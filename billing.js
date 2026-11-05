// billing.js - Plano Lite/PRO e cobrança nativa (Google Play Billing via cordova-plugin-purchase / capacitor-plugin-cdv-purchase)
//
// Produto único NÃO consumível: fuel_tracker_pro (R$ 4,90, preço definido no Play Console).
//
// Biblioteca: vendor/cdv-purchase/store.js (cópia de capacitor-plugin-cdv-purchase/www/store.js, script clássico,
// sem bundler). Só é carregada dentro do app nativo Android; na web/PWA a compra fica indisponível.
//
// SEGURANÇA
//  • Não existe modo Dev nem PRO forçado: nenhum host (inclusive https://localhost do Capacitor) concede PRO.
//    Não há `configure()` nem `CONFIG` expostos, e o objeto é congelado.
//  • Não existe compra simulada: a compra SEMPRE passa pela Google Play.
//  • O PRO só é liberado depois de: transação aprovada pela Play -> verifyLicense(purchase) (pluggável) ->
//    acknowledge (transaction.finish) concluído -> só então a licença é gravada.
//  • isPro() lê apenas o estado em memória. Esse estado vem de (a) compra confirmada, (b) consulta dos produtos
//    possuídos na Play ao abrir o app / voltar do segundo plano, ou (c) offline: registro local SELADO
//    (SHA-256 ligado ao token da compra, à origem e ao produto) com validade máxima de 30 dias sem revalidação.
//    Chaves soltas no localStorage (ex.: { pro: true }) NÃO concedem PRO.
//  • Reembolso: se a Play deixa de listar o produto como possuído, o PRO é revogado. Erro de rede/Play
//    NUNCA revoga (mantém o último estado validado, respeitando o prazo do cache).
//
// LIMITAÇÃO CONHECIDA: nenhum código 100% client-side é inviolável. Para blindagem total (Fase 2), troque
// verifyLicense por validação em servidor (ver VERIFY_ENDPOINT / opção `verifyLicense` de _create).
//
// Script clássico: expõe o objeto global `FuelBilling` (e module.exports para testes em Node).
const FuelBilling = (() => {
    'use strict';

    const PRODUCT_ID = 'fuel_tracker_pro';         // ID ÚNICO do produto no Play Console (Monetizar > Produtos > Produtos no app)
    const VERIFY_ENDPOINT = '';                    // opcional: URL do SEU servidor que valida o purchaseToken
    const PRICE_FALLBACK = 'R$ 4,90';              // exibido se o preço real do Play não puder ser lido
    const STORE_LIB_URL = 'vendor/cdv-purchase/store.js';
    const ENTITLEMENT_KEY = 'fuelTrackerEntitlement';  // licença selada (sobrevive ao "Zerar App")
    const SEAL_SALT = 'fuel-tracker/entitlement/v1';
    const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // sem revalidar na Play por mais que isso => volta a LITE
    const CLOCK_SKEW_MS = 5 * 60 * 1000;
    const FINISH_TIMEOUT_MS = 15000;                // espera pelo acknowledge
    const PURCHASE_WAIT_MS = 20000;                 // espera pela aprovação após a tela de pagamento

    function create(win, opts) {
        const options = opts || {};
        const finishTimeoutMs = options.finishTimeoutMs || FINISH_TIMEOUT_MS;
        const purchaseWaitMs = options.purchaseWaitMs || PURCHASE_WAIT_MS;
        const listeners = [];
        let pro = false;          // estado validado em memória (única fonte de verdade)
        let initPromise = null;
        let storePromise = null;
        let refreshPromise = null;
        let purchasing = false;
        let rejectedSeen = false;        // verifyLicense recusou alguma transação (usado pelo resultado de purchase())
        let store = null;
        let CDV = null;
        const inflight = new Map();      // transactionId -> Promise do tratamento da transação
        const finishWaiters = new Map(); // transactionId -> resolve do acknowledge
        const proWaiters = [];

        class BillingError extends Error {
            constructor(code) { super(code); this.code = code; }
        }

        function storage() {
            try { return win && win.localStorage ? win.localStorage : null; } catch (e) { return null; }
        }

        // --- Ambiente -------------------------------------------------------------------------------
        function isNative() {
            try {
                const c = win && win.Capacitor;
                return !!c && typeof c.isNativePlatform === 'function' && c.isNativePlatform() &&
                    typeof c.getPlatform === 'function' && c.getPlatform() === 'android';
            } catch (e) { return false; }
        }

        // --- Estado ---------------------------------------------------------------------------------
        function emit(value) {
            listeners.forEach(cb => { try { cb(value); } catch (e) { /* um ouvinte com erro não trava os outros */ } });
        }

        function onChange(cb) { if (typeof cb === 'function') listeners.push(cb); }

        function isPro() {
            return pro === true; // SOMENTE o estado validado em memória
        }

        function setPro(next) {
            const before = isPro();
            pro = !!next;
            const after = isPro();
            if (before !== after) emit(after);
            if (after) proWaiters.splice(0).forEach(fn => fn());
        }

        // --- Licença selada (uso offline) -----------------------------------------------------------
        async function sha256(text) {
            const subtle = win && win.crypto && win.crypto.subtle;
            if (!subtle) throw new BillingError('no-crypto');
            const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
            return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        function originOf() {
            return (win && win.location && (win.location.origin || win.location.hostname)) || '';
        }

        async function sealOf(rec) {
            return sha256([SEAL_SALT, originOf(), rec.sku, rec.tokenHash, rec.verifiedAt].join('|'));
        }

        async function persistEntitlement(purchaseToken) {
            const s = storage();
            if (!s) return;
            try {
                const rec = { pro: true, sku: PRODUCT_ID, tokenHash: await sha256(purchaseToken), verifiedAt: new Date().toISOString() };
                rec.seal = await sealOf(rec);
                s.setItem(ENTITLEMENT_KEY, JSON.stringify(rec));
            } catch (e) { /* sem persistência: vale só nesta sessão e é revalidado na Play */ }
        }

        function clearEntitlement() {
            const s = storage();
            try { if (s) s.removeItem(ENTITLEMENT_KEY); } catch (e) { /* ignora */ }
        }

        // true somente se o registro existe, está íntegro (selo), é do nosso produto e dentro da validade offline
        async function cachedEntitlementIsValid() {
            const s = storage();
            if (!s) return false;
            let raw;
            try { raw = s.getItem(ENTITLEMENT_KEY); } catch (e) { return false; }
            if (raw === null || raw === undefined) return false;
            try {
                const rec = JSON.parse(raw);
                const valid = !!rec && rec.pro === true && rec.sku === PRODUCT_ID &&
                    typeof rec.tokenHash === 'string' && typeof rec.verifiedAt === 'string' && typeof rec.seal === 'string' &&
                    rec.seal === await sealOf(rec);
                const age = Date.now() - Date.parse(rec && rec.verifiedAt);
                if (valid && age >= -CLOCK_SKEW_MS && age <= OFFLINE_GRACE_MS) return true;
            } catch (e) { /* registro corrompido */ }
            clearEntitlement(); // adulterado, expirado ou inválido
            return false;
        }

        // --- Verificação da licença (PLUGÁVEL) -------------------------------------------------------
        // purchase = { productId, purchaseToken, transactionId }
        // Retorna true = válida | false = recusada | null = indeterminado (sem rede/erro: não libera e não revoga).
        // Sem servidor, a Play (no aparelho) é a autoridade. Na Fase 2 basta trocar esta função (ou passar
        // `verifyLicense` em _create) por uma chamada ao servidor.
        async function defaultVerifyLicense(purchase) {
            if (!purchase || purchase.productId !== PRODUCT_ID || !purchase.purchaseToken) return false;
            if (!VERIFY_ENDPOINT) return true;
            try {
                const res = await win.fetch(VERIFY_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sku: PRODUCT_ID, purchaseToken: purchase.purchaseToken })
                });
                if (res.status >= 500) return null;
                if (!res.ok) return false;
                const data = await res.json().catch(() => ({}));
                return data.ok === true;
            } catch (e) {
                return null;
            }
        }
        const verifyLicense = typeof options.verifyLicense === 'function' ? options.verifyLicense : defaultVerifyLicense;

        // --- Plugin nativo --------------------------------------------------------------------------
        function loadScript(src) {
            return new Promise((resolve, reject) => {
                const doc = win.document;
                if (!doc || !doc.createElement) { reject(new BillingError('no-document')); return; }
                const el = doc.createElement('script');
                el.src = src;
                el.onload = () => resolve();
                el.onerror = () => reject(new BillingError('load-failed'));
                (doc.head || doc.documentElement).appendChild(el);
            });
        }

        function tokenOf(tx) {
            const receipt = tx && tx.parentReceipt;
            return (receipt && receipt.purchaseToken) || (tx && tx.purchaseId) || (tx && tx.transactionId) || '';
        }

        function txKey(tx) { return String((tx && tx.transactionId) || tokenOf(tx)); }

        function isOurs(tx) {
            return !!tx && Array.isArray(tx.products) && tx.products.some(p => p && p.id === PRODUCT_ID);
        }

        // Trata uma transação aprovada: verifyLicense -> acknowledge (finish) -> libera PRO.
        // Idempotente por transactionId (approved dispara de novo a cada abertura para compras já confirmadas).
        function handleTransaction(tx) {
            if (!isOurs(tx)) return Promise.resolve('ignored');
            const key = txKey(tx);
            if (inflight.has(key)) return inflight.get(key);
            const job = (async () => {
                const purchase = { productId: PRODUCT_ID, purchaseToken: tokenOf(tx), transactionId: tx.transactionId };
                let verdict;
                try { verdict = await verifyLicense(purchase); } catch (e) { verdict = null; }
                if (verdict === false) { rejectedSeen = true; return 'rejected'; }
                if (verdict !== true) return 'unverified';
                // Compra já confirmada antes (reabertura/restauração): não há o que confirmar de novo
                const alreadyAcked = tx.isAcknowledged === true || (!!CDV && tx.state === CDV.TransactionState.FINISHED);
                if (!alreadyAcked) {
                    const acked = new Promise(resolve => {
                        const t = setTimeout(() => { finishWaiters.delete(key); resolve(false); }, finishTimeoutMs);
                        finishWaiters.set(key, () => { clearTimeout(t); resolve(true); });
                    });
                    try { await tx.finish(); } catch (e) { return 'unverified'; }
                    if (!(await acked)) return 'unverified'; // sem acknowledge NÃO libera; a próxima abertura tenta de novo
                }
                await persistEntitlement(purchase.purchaseToken);
                setPro(true);
                return 'pro';
            })().then(r => { inflight.delete(key); return r; }, () => { inflight.delete(key); return 'unverified'; });
            inflight.set(key, job);
            return job;
        }

        async function ensureStore() {
            if (!storePromise) {
                storePromise = (async () => {
                    if (!isNative()) throw new BillingError('unsupported');
                    if (!win.CdvPurchase) {
                        // marcador exigido por store.js + registro do plugin nativo (sem bundler)
                        win.CdvPurchaseCapacitor = { installed: true };
                        const c = win.Capacitor;
                        if (!(c.Plugins && c.Plugins.PurchasePlugin) && typeof c.registerPlugin === 'function') {
                            c.registerPlugin('PurchasePlugin');
                        }
                        await loadScript(STORE_LIB_URL);
                    }
                    CDV = win.CdvPurchase;
                    store = CDV && CDV.store;
                    if (!store) throw new BillingError('unsupported');
                    store.register({ id: PRODUCT_ID, type: CDV.ProductType.NON_CONSUMABLE, platform: CDV.Platform.GOOGLE_PLAY });
                    store.error(() => { /* erros chegam também nos retornos das chamadas */ });
                    store.when()
                        .approved(tx => { handleTransaction(tx); })
                        .finished(tx => {
                            const key = txKey(tx);
                            const w = finishWaiters.get(key);
                            if (w) { finishWaiters.delete(key); w(); }
                        });
                    const errors = await store.initialize([CDV.Platform.GOOGLE_PLAY]);
                    if (errors && errors.length) throw new BillingError('init-failed');
                    return store;
                })();
                storePromise.catch(() => { storePromise = null; }); // permite nova tentativa depois
            }
            return storePromise;
        }

        function productOf() {
            return store && CDV ? store.get(PRODUCT_ID, CDV.Platform.GOOGLE_PLAY) : undefined;
        }

        // Compara o que a Play diz que é do usuário com o estado local.
        // owned => trata a transação (verifica, confirma, libera). Não owned => revoga (reembolso/nunca comprou).
        async function reconcile() {
            if (store.owned(PRODUCT_ID)) {
                const tx = store.findInLocalReceipts(productOf());
                if (!tx) return { status: 'unverified' };
                const r = await handleTransaction(tx);
                if (r === 'pro') return { status: 'pro' };
                if (r === 'rejected') { clearEntitlement(); setPro(false); return { status: 'rejected' }; }
                return { status: 'unverified' };
            }
            clearEntitlement(); // a Play respondeu e não há compra válida: nunca comprou, reembolsou ou revogou
            setPro(false);
            return { status: 'free' };
        }

        // --- API pública ----------------------------------------------------------------------------
        async function getAvailability() {
            if (!isNative()) return { ok: false, reason: 'unsupported' };
            try { await ensureStore(); } catch (e) { return { ok: false, reason: e && e.code === 'unsupported' ? 'unsupported' : 'unavailable' }; }
            return productOf() ? { ok: true } : { ok: false, reason: 'unavailable' };
        }

        async function getPriceText() {
            try {
                await ensureStore();
                const p = productOf();
                const phase = p && p.pricing;
                if (phase && phase.price) return String(phase.price);
            } catch (e) { /* usa o texto padrão */ }
            return PRICE_FALLBACK;
        }

        function isCancel(err) {
            if (!err) return false;
            const msg = String(err.message || '');
            return err.code === (CDV && CDV.ErrorCode && CDV.ErrorCode.PAYMENT_CANCELLED) || /USER_CANCELED/i.test(msg) || String(err.code) === '1';
        }

        /**
         * Inicia a compra na Google Play. Resultado: { status }
         *  purchased | cancelled | pending | unsupported | unverified | rejected | error
         * O PRO só é liberado após verifyLicense + acknowledge bem-sucedidos.
         */
        async function purchase() {
            if (purchasing) return { status: 'error' };
            purchasing = true;
            try {
                try { await ensureStore(); } catch (e) { return { status: e && e.code === 'unsupported' ? 'unsupported' : 'error' }; }
                rejectedSeen = false;
                const product = productOf();
                const offer = product && product.getOffer();
                if (!offer) return { status: 'error' };

                const err = await store.order(offer);
                if (err) {
                    if (isCancel(err)) return { status: 'cancelled' };
                    if (/ALREADY_OWNED/i.test(String(err.message || ''))) {
                        const r = await restore();
                        return { status: r.status === 'pro' ? 'purchased' : 'error' };
                    }
                    return { status: 'error' };
                }

                // Aguarda a transação ser aprovada/confirmada (o evento chega pelo plugin)
                if (!isPro()) {
                    await new Promise(resolve => {
                        const t = setTimeout(resolve, purchaseWaitMs);
                        proWaiters.push(() => { clearTimeout(t); resolve(); });
                    });
                }
                if (isPro()) return { status: 'purchased' };
                const tx = store.findInLocalReceipts(product);
                if (tx && tx.isPending) return { status: 'pending' }; // pagamento adiado: libera quando a Play aprovar
                await Promise.all(Array.from(inflight.values()));
                return { status: rejectedSeen ? 'rejected' : 'unverified' };
            } finally {
                purchasing = false;
            }
        }

        /**
         * Restaura a compra (reinstalação/aparelho novo/código promocional) e revalida a licença na Play:
         * confirma compras pendentes e revoga o PRO se houve reembolso.
         * Erro de Play/rede: mantém o último estado validado.
         */
        function restore() {
            if (refreshPromise) return refreshPromise;
            refreshPromise = (async () => {
                try {
                    await ensureStore();
                } catch (e) {
                    return { status: e && e.code === 'unsupported' ? 'unsupported' : 'error' };
                }
                let err;
                try { err = await store.restorePurchases(); } catch (e) { err = e || true; }
                if (err) return { status: 'error' };
                try { return await reconcile(); } catch (e) { return { status: 'error' }; }
            })().then(r => { refreshPromise = null; return r; }, () => { refreshPromise = null; return { status: 'error' }; });
            return refreshPromise;
        }

        // Reconsulta a Play (ao voltar do segundo plano)
        function refresh() { return restore(); }

        // Chamar ao abrir o app: carrega a licença selada (offline) e depois consulta a Google Play.
        function init() {
            if (!initPromise) {
                initPromise = (async () => {
                    if (!isNative()) return { status: 'unsupported' };
                    if (await cachedEntitlementIsValid()) setPro(true);
                    try { await ensureStore(); } catch (e) { return { status: 'error' }; }
                    try { return await reconcile(); } catch (e) { return { status: 'error' }; }
                })().catch(() => ({ status: 'error' }));
            }
            return initPromise;
        }

        return Object.freeze({ isPro, onChange, getAvailability, getPriceText, purchase, restore, refresh, init });
    }

    const api = create(typeof window !== 'undefined' ? window : null);
    return Object.freeze(Object.assign({}, api, {
        PRODUCT_ID,
        _create: (win, opts) => create(win, opts)
    }));
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FuelBilling;
}
