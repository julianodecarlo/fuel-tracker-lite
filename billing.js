// billing.js - Plano Lite/PRO e cobrança (Google Play Billing via Digital Goods API + Payment Request API)
//
// Produto único NÃO consumível: fuel_tracker_pro (R$ 4,90, preço definido no Play Console).
//
// SEGURANÇA
//  • Não existe modo Dev nem PRO forçado: nenhum host (inclusive https://localhost do Capacitor) concede PRO.
//    Não há `configure()` nem `CONFIG` expostos, e o objeto é congelado.
//  • Não existe compra simulada: a compra SEMPRE passa pela Google Play.
//  • O PRO só é liberado depois de: purchaseToken retornado pela Play -> (verificação opcional no servidor)
//    -> acknowledge (acknowledgePurchase) bem-sucedido -> só então a licença é gravada.
//  • isPro() lê apenas o estado em memória. Esse estado vem de (a) compra confirmada, (b) listPurchases() da
//    Play ao abrir o app ou (c) offline: registro local SELADO (checksum SHA-256 ligado ao token da compra,
//    à origem e ao produto) com validade máxima de 30 dias sem revalidação.
//    Chaves soltas no localStorage (ex.: { pro: true }) NÃO concedem PRO.
//
// LIMITAÇÃO CONHECIDA: nenhum código 100% client-side é inviolável. O selo local barra edição casual pelo
// console/localStorage, mas para blindagem total configure VERIFY_ENDPOINT (servidor que valida o
// purchaseToken na Google Play Developer API).
//
// Script clássico: expõe o objeto global `FuelBilling` (e module.exports para testes em Node).
const FuelBilling = (() => {
    'use strict';

    const PRODUCT_ID = 'fuel_tracker_pro';         // ID ÚNICO do produto no Play Console (Monetizar > Produtos > Produtos no app)
    const VERIFY_ENDPOINT = '';                    // opcional: URL do SEU servidor que valida o purchaseToken
    const PRICE_FALLBACK = 'R$ 4,90';              // exibido se o preço real do Play não puder ser lido
    const PLAY_STORE = 'https://play.google.com/billing';
    const ENTITLEMENT_KEY = 'fuelTrackerEntitlement';  // licença selada (sobrevive ao "Zerar App")
    const SEAL_SALT = 'fuel-tracker/entitlement/v1';
    const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // sem revalidar na Play por mais que isso => volta a LITE
    const CLOCK_SKEW_MS = 5 * 60 * 1000;

    function create(win) {
        const listeners = [];
        let pro = false;          // estado validado em memória (única fonte de verdade em produção)
        let initPromise = null;
        let purchasing = false;

        class BillingError extends Error {
            constructor(code) { super(code); this.code = code; }
        }

        // --- Ambiente -------------------------------------------------------------------------------
        function storage() {
            try { return win && win.localStorage ? win.localStorage : null; } catch (e) { return null; }
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

        // --- Google Play ----------------------------------------------------------------------------
        async function getService() {
            if (!win || typeof win.getDigitalGoodsService !== 'function' || typeof win.PaymentRequest !== 'function') {
                throw new BillingError('unsupported');
            }
            try {
                return await win.getDigitalGoodsService(PLAY_STORE);
            } catch (e) {
                throw new BillingError('unsupported');
            }
        }

        // acknowledgePurchase da Play (na Digital Goods API o método se chama acknowledge). Produto não consumível => 'onetime'
        async function acknowledgePurchase(service, purchaseToken) {
            try {
                await service.acknowledge(purchaseToken, 'onetime');
                return true;
            } catch (e) {
                return false;
            }
        }

        // Validação opcional no SEU servidor. true = válida | false = recusada | null = indeterminado (sem rede/erro)
        async function verifyOnServer(purchaseToken) {
            if (!VERIFY_ENDPOINT) return true; // sem servidor: a Play (on-device) é a autoridade
            try {
                const res = await win.fetch(VERIFY_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sku: PRODUCT_ID, purchaseToken })
                });
                if (res.status >= 500) return null;
                if (!res.ok) return false;
                const data = await res.json().catch(() => ({}));
                return data.ok === true;
            } catch (e) {
                return null;
            }
        }

        // O que a tela de compra deve mostrar: { ok: true } ou { ok: false, reason }
        async function getAvailability() {
            try { await getService(); } catch (e) { return { ok: false, reason: 'unsupported' }; }
            return { ok: true };
        }

        async function getPriceText() {
            try {
                const service = await getService();
                const details = await service.getDetails([PRODUCT_ID]);
                const item = details && details[0];
                if (item && item.price) {
                    const lang = (win.navigator && win.navigator.language) || 'pt-BR';
                    return new Intl.NumberFormat(lang, { style: 'currency', currency: item.price.currency }).format(item.price.value);
                }
            } catch (e) { /* usa o texto padrão */ }
            return PRICE_FALLBACK;
        }


        /**
         * Inicia a compra na Google Play. Resultado: { status }
         *  purchased | cancelled | unsupported | unverified | rejected | error
         * O PRO só é liberado após o acknowledge bem-sucedido.
         */
        async function purchase() {
            if (purchasing) return { status: 'error' };
            purchasing = true;
            try {
                let service;
                try { service = await getService(); } catch (e) { return { status: 'unsupported' }; }

                // A Play ignora estes valores e cobra o preço cadastrado no Play Console
                const request = new win.PaymentRequest(
                    [{ supportedMethods: PLAY_STORE, data: { sku: PRODUCT_ID } }],
                    { total: { label: 'Fuel Tracker PRO', amount: { currency: 'BRL', value: '4.90' } } }
                );

                let response;
                try {
                    response = await request.show();
                } catch (e) {
                    return { status: e && e.name === 'AbortError' ? 'cancelled' : 'error' };
                }

                const token = response.details && response.details.purchaseToken;
                if (!token) {
                    try { await response.complete('fail'); } catch (e) { /* não é crítico */ }
                    return { status: 'error' };
                }

                const verified = await verifyOnServer(token);
                const acknowledged = verified === true ? await acknowledgePurchase(service, token) : false;
                try {
                    await response.complete(verified === false ? 'fail' : acknowledged ? 'success' : 'unknown');
                } catch (e) { /* não é crítico */ }

                if (verified === true && acknowledged) {
                    await persistEntitlement(token);
                    setPro(true);
                    return { status: 'purchased' };
                }
                // Sem acknowledge/validação NÃO libera. init() tenta confirmar de novo na próxima abertura.
                return { status: verified === false ? 'rejected' : 'unverified' };
            } finally {
                purchasing = false;
            }
        }

        /**
         * Consulta a licença real na Google Play (restaura compra em outro aparelho/reinstalação, confirma compras
         * pendentes e revoga o PRO se houve reembolso). Offline/sem Play: mantém o último estado validado.
         */
        async function refresh() {
            let service;
            try { service = await getService(); } catch (e) { return { status: 'unsupported' }; }

            let purchases;
            try { purchases = await service.listPurchases(); } catch (e) { return { status: 'error' }; }

            const mine = (purchases || []).filter(p => p && p.itemId === PRODUCT_ID && p.purchaseToken);
            let grantedToken = null;
            let unknown = false;
            for (const p of mine) {
                const v = await verifyOnServer(p.purchaseToken);
                if (v === true) {
                    await acknowledgePurchase(service, p.purchaseToken); // idempotente: se já confirmada, o erro é ignorado
                    grantedToken = p.purchaseToken;
                } else if (v === null) {
                    unknown = true;
                }
            }
            if (grantedToken) {
                await persistEntitlement(grantedToken);
                setPro(true);
                return { status: 'pro' };
            }
            if (unknown) return { status: 'unverified' };
            clearEntitlement(); // a Play respondeu e não há compra válida: nunca comprou, reembolsou ou revogou
            setPro(false);
            return { status: 'free' };
        }

        // Chamar ao abrir o app: carrega a licença selada (offline) e depois consulta a Google Play.
        function init() {
            if (!initPromise) {
                initPromise = (async () => {
                    if (await cachedEntitlementIsValid()) setPro(true);
                    return refresh();
                })().catch(() => ({ status: 'error' }));
            }
            return initPromise;
        }

        return Object.freeze({ isPro, onChange, getAvailability, getPriceText, purchase, refresh, init });
    }

    const api = create(typeof window !== 'undefined' ? window : null);
    return Object.freeze(Object.assign({}, api, {
        PRODUCT_ID,
        _create: (win) => create(win)
    }));
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FuelBilling;
}

