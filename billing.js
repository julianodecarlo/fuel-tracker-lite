// billing.js - Plano Lite/PRO e cobrança (Google Play Billing via Digital Goods API + Payment Request API)
//
// ┌─ INTERRUPTOR ÚNICO ───────────────────────────────────────────────────────────┐
// │ mode: 'dev'        → botão "Dev: Lite/Pro" visível + compra SIMULADA          │
// │ mode: 'production' → Play Billing real; botão Dev some; PRO só via compra     │
// └───────────────────────────────────────────────────────────────────────────────┘
// Para publicar: troque mode para 'production', preencha productId e verifyEndpoint (ver PLAY-BILLING.md).
//
// Script clássico: expõe o objeto global `FuelBilling` (e module.exports para testes em Node).
const FuelBilling = (() => {
    'use strict';

    const CONFIG = {
        mode: 'dev',                     // 'dev' | 'production'
        productId: 'fuel_tracker_pro',   // SKU criado no Play Console (Monetizar > Produtos > Produtos no app)
        verifyEndpoint: '',              // URL do SEU servidor que verifica e confirma a compra (obrigatório em produção)
        priceFallback: 'R$ 4,90'         // exibido se o preço real do Play não puder ser lido
    };

    const DEV_FLAG_KEY = 'fuelTrackerPro';            // flag usada SOMENTE no modo dev
    const ENTITLEMENT_KEY = 'fuelTrackerEntitlement'; // PRO verificado (sobrevive ao "Resetar banco de dados")
    const PLAY_STORE = 'https://play.google.com/billing';
    const listeners = [];
    let memoryPro = null; // reserva caso o localStorage esteja indisponível

    class BillingError extends Error {
        constructor(code) { super(code); this.code = code; }
    }

    function configure(partial) { Object.assign(CONFIG, partial || {}); }
    function isDev() { return CONFIG.mode !== 'production'; }

    function readEntitlement() {
        try {
            const raw = JSON.parse(localStorage.getItem(ENTITLEMENT_KEY));
            return !!(raw && raw.pro === true);
        } catch (e) {
            return false;
        }
    }

    function isPro() {
        if (isDev()) {
            try { return localStorage.getItem(DEV_FLAG_KEY) === 'true'; } catch (e) { return false; }
        }
        return memoryPro !== null ? memoryPro : readEntitlement();
    }

    function emit(pro) {
        listeners.forEach(cb => { try { cb(pro); } catch (e) { /* um ouvinte com erro não pode travar os outros */ } });
    }

    function onChange(cb) { listeners.push(cb); }

    // Grava o PRO verificado (produção). Só avisa os ouvintes se o valor realmente mudou.
    function setEntitlement(pro) {
        const before = isPro();
        memoryPro = !!pro;
        try {
            localStorage.setItem(ENTITLEMENT_KEY, JSON.stringify({ pro: !!pro, sku: CONFIG.productId, verifiedAt: new Date().toISOString() }));
        } catch (e) { /* mantém em memória */ }
        if (before !== !!pro) emit(!!pro);
    }

    // Só no modo dev: alterna Lite/PRO (equivale ao antigo botão "Dev: Lite/Pro")
    function devSetPro(flag) {
        if (!isDev()) return false;
        const before = isPro();
        try { localStorage.setItem(DEV_FLAG_KEY, flag ? 'true' : 'false'); } catch (e) { return false; }
        if (before !== !!flag) emit(!!flag);
        return true;
    }

    async function getService() {
        if (typeof window === 'undefined' || !('getDigitalGoodsService' in window)) throw new BillingError('unsupported');
        try {
            return await window.getDigitalGoodsService(PLAY_STORE);
        } catch (e) {
            throw new BillingError('unsupported');
        }
    }

    // Pergunta ao SEU servidor se a compra é legítima (e ele a confirma no Google).
    // true = válida | false = recusada | null = indeterminado (sem rede / erro do servidor)
    async function verifyOnServer(purchaseToken, sku) {
        try {
            const res = await fetch(CONFIG.verifyEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sku, purchaseToken })
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
        if (isDev()) return { ok: true };
        if (!CONFIG.verifyEndpoint) return { ok: false, reason: 'no-backend' };
        try { await getService(); } catch (e) { return { ok: false, reason: 'unsupported' }; }
        return { ok: true };
    }

    async function getPriceText() {
        if (isDev()) return CONFIG.priceFallback;
        try {
            const service = await getService();
            const details = await service.getDetails([CONFIG.productId]);
            const item = details && details[0];
            if (item && item.price) {
                const lang = (typeof navigator !== 'undefined' && navigator.language) || 'pt-BR';
                return new Intl.NumberFormat(lang, { style: 'currency', currency: item.price.currency }).format(item.price.value);
            }
        } catch (e) { /* usa o texto padrão */ }
        return CONFIG.priceFallback;
    }

    /**
     * Inicia a compra. Resultado: { status }
     *  purchased | cancelled | unsupported | no-backend | unverified | rejected | error
     * Em produção, SEM servidor configurado a compra nem é iniciada (o Google reembolsaria em 3 dias).
     */
    async function purchase() {
        if (isDev()) {
            await new Promise(resolve => setTimeout(resolve, 1500)); // simula o gateway
            devSetPro(true);
            return { status: 'purchased' };
        }
        if (!CONFIG.verifyEndpoint) return { status: 'no-backend' };
        try { await getService(); } catch (e) { return { status: 'unsupported' }; }

        // O Play Billing ignora estes valores e usa o preço cadastrado no Play Console
        const request = new PaymentRequest(
            [{ supportedMethods: PLAY_STORE, data: { sku: CONFIG.productId } }],
            { total: { label: 'Total', amount: { currency: 'BRL', value: '0' } } }
        );

        let response;
        try {
            response = await request.show();
        } catch (e) {
            return { status: e && e.name === 'AbortError' ? 'cancelled' : 'error' };
        }

        const token = response.details && response.details.purchaseToken;
        const verified = token ? await verifyOnServer(token, CONFIG.productId) : false;
        try {
            await response.complete(verified === true ? 'success' : verified === false ? 'fail' : 'unknown');
        } catch (e) { /* não é crítico */ }

        if (verified === true) {
            setEntitlement(true);
            return { status: 'purchased' };
        }
        return { status: verified === null ? 'unverified' : 'rejected' };
    }

    /**
     * Sincroniza com o Google Play (chamar ao abrir o app): restaura compras feitas em outro aparelho/reinstalação,
     * confirma compras pendentes e revoga o PRO se a compra foi reembolsada.
     * Sem rede/sem Play, mantém o último estado verificado (o app continua funcionando offline).
     */
    async function refresh() {
        if (isDev() || !CONFIG.verifyEndpoint) return { status: 'skipped' };
        let service;
        try { service = await getService(); } catch (e) { return { status: 'unsupported' }; }

        let purchases;
        try { purchases = await service.listPurchases(); } catch (e) { return { status: 'error' }; }

        const mine = (purchases || []).filter(p => p && p.itemId === CONFIG.productId);
        let granted = false;
        let unknown = false;
        for (const p of mine) {
            const v = await verifyOnServer(p.purchaseToken, p.itemId);
            if (v === true) granted = true;
            else if (v === null) unknown = true;
        }
        if (granted) { setEntitlement(true); return { status: 'pro' }; }
        if (unknown) return { status: 'unverified' };
        setEntitlement(false); // nenhuma compra válida: nunca comprou, reembolsou ou foi revogada
        return { status: 'free' };
    }

    return { configure, isDev, isPro, onChange, devSetPro, getAvailability, getPriceText, purchase, refresh, CONFIG };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FuelBilling;
}
