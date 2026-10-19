// Testes do billing.js e do sw.js. Execute: node tests/billing.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const FuelBilling = require('../billing.js');

function makeStorage(initial) {
    const m = new Map(Object.entries(initial || {}));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); }
    };
}

function makeWin(opts) {
    const o = opts || {};
    const calls = { ack: [], complete: [], details: [], payment: [] };
    const host = o.hostname || 'app.example.com';
    const win = {
        location: { hostname: host, origin: 'https://' + host },
        localStorage: o.storage || makeStorage(),
        crypto: webcrypto,
        navigator: { language: 'pt-BR' },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
    };
    if (o.play !== false) {
        win.PaymentRequest = function (methods) {
            calls.payment.push(methods);
            this.show = async () => {
                if (o.cancel) { const e = new Error('x'); e.name = 'AbortError'; throw e; }
                return { details: { purchaseToken: 'tok-123' }, complete: async (r) => { calls.complete.push(r); } };
            };
        };
        win.getDigitalGoodsService = async () => ({
            acknowledge: async (token, type) => { if (o.ackFails) throw new Error('ack'); calls.ack.push([token, type]); },
            getDetails: async (ids) => { calls.details.push(ids); return [{ price: { currency: 'BRL', value: '4.90' } }]; },
            listPurchases: async () => (o.purchases || [])
        });
    }
    return { win, calls };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('productId é fuel_tracker_pro e objeto é imutável/sem configure', () => {
    assert.strictEqual(FuelBilling.PRODUCT_ID, 'fuel_tracker_pro');
    assert.ok(Object.isFrozen(FuelBilling));
    assert.strictEqual(FuelBilling.configure, undefined);
    assert.strictEqual(FuelBilling.CONFIG, undefined);
});

test('produção: isDev=false e devSetPro recusa; flag fuelTrackerPro=true NÃO concede PRO', () => {
    const storage = makeStorage({ fuelTrackerPro: 'true', fuelTrackerEntitlement: JSON.stringify({ pro: true }) });
    const b = FuelBilling._create(makeWin({ storage }).win);
    assert.strictEqual(b.isDev(), false);
    assert.strictEqual(b.devSetPro(true), false);
    assert.strictEqual(b.isPro(), false);
});

test('localhost e 127.0.0.1: isDev=true e devSetPro alterna plano', () => {
    ['localhost', '127.0.0.1'].forEach((hostname) => {
        const b = FuelBilling._create(makeWin({ hostname }).win);
        assert.strictEqual(b.isDev(), true);
        assert.strictEqual(b.isPro(), false);
        assert.strictEqual(b.devSetPro(true), true);
        assert.strictEqual(b.isPro(), true);
    });
});

test('hostname parecido (localhost.evil.com) NÃO é dev', () => {
    assert.strictEqual(FuelBilling._create(makeWin({ hostname: 'localhost.evil.com' }).win).isDev(), false);
});

test('compra: acknowledge chamado, PRO liberado só depois, licença selada gravada', async () => {
    const { win, calls } = makeWin();
    const b = FuelBilling._create(win);
    const changes = [];
    b.onChange((v) => changes.push(v));
    const r = await b.purchase();
    assert.strictEqual(r.status, 'purchased');
    assert.deepStrictEqual(calls.ack, [['tok-123', 'onetime']]);
    assert.deepStrictEqual(calls.complete, ['success']);
    assert.strictEqual(b.isPro(), true);
    assert.deepStrictEqual(changes, [true]);
    const rec = JSON.parse(win.localStorage.getItem('fuelTrackerEntitlement'));
    assert.ok(rec.seal && rec.tokenHash && rec.sku === 'fuel_tracker_pro');
});

test('compra: falha no acknowledge NÃO libera PRO', async () => {
    const { win } = makeWin({ ackFails: true });
    const b = FuelBilling._create(win);
    assert.strictEqual((await b.purchase()).status, 'unverified');
    assert.strictEqual(b.isPro(), false);
    assert.strictEqual(win.localStorage.getItem('fuelTrackerEntitlement'), null);
});

test('compra cancelada e sem Play (unsupported) não liberam PRO', async () => {
    const c = FuelBilling._create(makeWin({ cancel: true }).win);
    assert.strictEqual((await c.purchase()).status, 'cancelled');
    assert.strictEqual(c.isPro(), false);
    const u = FuelBilling._create(makeWin({ play: false }).win);
    assert.strictEqual((await u.purchase()).status, 'unsupported');
    assert.strictEqual(u.isPro(), false);
});

test('Digital Goods API: getDetails e PaymentRequest recebem exclusivamente fuel_tracker_pro', async () => {
    const { win, calls } = makeWin();
    const b = FuelBilling._create(win);
    assert.strictEqual(await b.getPriceText(), 'R$\u00a04,90');
    assert.deepStrictEqual(calls.details, [['fuel_tracker_pro']]);
    await b.purchase();
    assert.strictEqual(calls.payment.length, 1);
    assert.deepStrictEqual(calls.payment[0].map((m) => m.data), [{ sku: 'fuel_tracker_pro' }]);
});

test('licença selada de outro produto é rejeitada; restauração ignora itemId diferente', async () => {
    // registro com sku diferente de fuel_tracker_pro não vale
    const first = makeWin();
    await FuelBilling._create(first.win).purchase();
    const rec = JSON.parse(first.win.localStorage.getItem('fuelTrackerEntitlement'));
    rec.sku = 'outro_produto';
    const old = makeWin({ play: false, storage: makeStorage({ fuelTrackerEntitlement: JSON.stringify(rec) }) });
    const b = FuelBilling._create(old.win);
    await b.init();
    assert.strictEqual(b.isPro(), false);
    // compra de outro itemId no listPurchases não concede PRO
    const other = makeWin({ purchases: [{ itemId: 'outro_produto', purchaseToken: 'x' }] });
    const b2 = FuelBilling._create(other.win);
    assert.strictEqual((await b2.init()).status, 'free');
    assert.strictEqual(b2.isPro(), false);
});

test('offline: licença selada válida restaura PRO; adulterada é descartada', async () => {
    const first = makeWin();
    await FuelBilling._create(first.win).purchase();
    const saved = first.win.localStorage.getItem('fuelTrackerEntitlement');

    const off = makeWin({ play: false, storage: makeStorage({ fuelTrackerEntitlement: saved }) });
    const b = FuelBilling._create(off.win);
    await b.init();
    assert.strictEqual(b.isPro(), true);

    const forged = JSON.parse(saved); forged.tokenHash = 'forjado';
    const bad = makeWin({ play: false, storage: makeStorage({ fuelTrackerEntitlement: JSON.stringify(forged) }) });
    const b2 = FuelBilling._create(bad.win);
    await b2.init();
    assert.strictEqual(b2.isPro(), false);
    assert.strictEqual(bad.win.localStorage.getItem('fuelTrackerEntitlement'), null);

    const simple = makeWin({ play: false, storage: makeStorage({ fuelTrackerEntitlement: '{"pro":true}' }) });
    const b3 = FuelBilling._create(simple.win);
    await b3.init();
    assert.strictEqual(b3.isPro(), false);
});

test('offline: licença selada expirada (>30 dias) é descartada', async () => {
    const first = makeWin();
    await FuelBilling._create(first.win).purchase();
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 24 * 60 * 60 * 1000;
    try {
        const off = makeWin({ play: false, storage: makeStorage({ fuelTrackerEntitlement: first.win.localStorage.getItem('fuelTrackerEntitlement') }) });
        const b = FuelBilling._create(off.win);
        await b.init();
        assert.strictEqual(b.isPro(), false);
    } finally { Date.now = realNow; }
});

test('init online: restaura compra da Play; sem compra revoga (reembolso)', async () => {
    const owned = makeWin({ purchases: [{ itemId: 'fuel_tracker_pro', purchaseToken: 't1' }] });
    const b = FuelBilling._create(owned.win);
    assert.strictEqual((await b.init()).status, 'pro');
    assert.strictEqual(b.isPro(), true);
    assert.deepStrictEqual(owned.calls.ack, [['t1', 'onetime']]);

    const first = makeWin();
    await FuelBilling._create(first.win).purchase();
    const refunded = makeWin({ purchases: [], storage: makeStorage({ fuelTrackerEntitlement: first.win.localStorage.getItem('fuelTrackerEntitlement') }) });
    const b2 = FuelBilling._create(refunded.win);
    assert.strictEqual((await b2.init()).status, 'free');
    assert.strictEqual(b2.isPro(), false);
    assert.strictEqual(refunded.win.localStorage.getItem('fuelTrackerEntitlement'), null);
});

test('sw.js: cache v9, limpeza de caches antigos e 18 arquivos no addAll', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    assert.ok(/CACHE_PREFIX \+ 'v9'/.test(src));
    assert.ok(/caches\.delete\(k\)/.test(src) && /k !== CACHE_NAME/.test(src));
    assert.ok(/cache\.addAll\(/.test(src));
    const grab = (name) => {
        const m = src.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];'));
        return m[1].split('\n').map((l) => (l.match(/'([^']+)'/) || [])[1]).filter(Boolean);
    };
    const files = [...grab('APP_SHELL'), ...grab('STATIC_ASSETS')];
    assert.strictEqual(files.length, 18);
    assert.strictEqual(new Set(files).size, 18);
    files.forEach((f) => assert.ok(fs.existsSync(path.join(__dirname, '..', f)), 'arquivo ausente: ' + f));
});

test('código-fonte: sem processProUpgrade nem compra simulada com setTimeout', () => {
    const root = path.join(__dirname, '..');
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const bill = fs.readFileSync(path.join(root, 'billing.js'), 'utf8');
    assert.ok(!/processProUpgrade/.test(app + html));
    assert.ok(!/setTimeout/.test(bill));
    assert.ok(/FuelBilling\.purchase\(\)/.test(app));
    assert.ok(/startProPurchase\(\)/.test(html));
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log('  ok   - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n         ' + e.message); }
    }
    console.log(failed ? `\n${failed} teste(s) falharam` : `\nTodos os ${tests.length} testes passaram`);
    process.exit(failed ? 1 : 0);
})();

