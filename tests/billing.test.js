// Testes do billing.js e do sw.js. Execute: node tests/billing.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const FuelBilling = require('../billing.js');

const FAST = { finishTimeoutMs: 50, purchaseWaitMs: 50 };

function makeStorage(initial) {
    const m = new Map(Object.entries(initial || {}));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); }
    };
}

// Mock fiel ao que o store.js (cordova-plugin-purchase 13.x) expõe: register, when().approved/finished,
// initialize, owned, findInLocalReceipts, order, restorePurchases e Transaction.finish().
function makeFakeCdv(o, calls) {
    const handlers = { approved: [], finished: [] };
    const product = { id: 'fuel_tracker_pro', pricing: { price: 'R$ 4,90' }, getOffer: () => ({ id: 'offer-1', productId: 'fuel_tracker_pro' }) };
    function mkTx(r) {
        const tx = {
            transactionId: 'tr-' + r.token,
            parentReceipt: { purchaseToken: r.token },
            products: [{ id: r.productId || 'fuel_tracker_pro' }],
            isAcknowledged: !!r.acked,
            isPending: !!r.pending,
            state: r.acked ? 'approved' : 'initiated',
            finish: async () => {
                calls.finish.push(r.token);
                if (o.ackFails) return;
                tx.isAcknowledged = true;
                tx.state = 'finished';
                handlers.finished.forEach((cb) => cb(tx));
            }
        };
        return tx;
    }
    let receipts = (o.owned || []).map(mkTx);
    const fire = (tx) => { if (!tx.isPending) handlers.approved.forEach((cb) => cb(tx)); };
    const store = {
        register: (p) => { calls.register.push(p); },
        error: () => {},
        when() {
            const w = {
                approved: (cb) => { handlers.approved.push(cb); return w; },
                finished: (cb) => { handlers.finished.push(cb); return w; }
            };
            return w;
        },
        async initialize(platforms) {
            calls.init.push(platforms);
            if (o.initErrors) return [{ isError: true, message: 'x' }];
            receipts.forEach(fire);
            return [];
        },
        get: (id) => (o.noProduct || id !== 'fuel_tracker_pro' ? undefined : product),
        owned: (id) => receipts.some((tx) => tx.products[0].id === id && !tx.isPending),
        findInLocalReceipts: () => receipts[0],
        async order(offer) {
            calls.order.push(offer);
            if (o.cancel) return { isError: true, code: 6777006, message: 'USER_CANCELED' };
            if (o.orderError) return { isError: true, code: 6777003, message: o.orderError };
            const tx = mkTx({ token: 'tok-123', acked: false, pending: o.pending });
            receipts = [tx];
            fire(tx);
            return undefined;
        },
        async restorePurchases() {
            calls.restore++;
            if (o.restoreError) return { isError: true, message: 'offline' };
            if (o.afterRestore) { receipts = o.afterRestore.map(mkTx); receipts.forEach(fire); }
            return undefined;
        }
    };
    return {
        store,
        Platform: { GOOGLE_PLAY: 'android-playstore' },
        ProductType: { NON_CONSUMABLE: 'non consumable' },
        ErrorCode: { PAYMENT_CANCELLED: 6777006 },
        TransactionState: { FINISHED: 'finished' }
    };
}

function makeWin(opts) {
    const o = opts || {};
    const native = o.native !== false;
    const calls = { finish: [], register: [], init: [], order: [], restore: 0, registerPlugin: [], scripts: [] };
    const host = o.hostname || 'localhost';
    const win = {
        location: { hostname: host, origin: 'https://' + host },
        localStorage: o.storage || makeStorage(),
        crypto: webcrypto,
        navigator: { language: 'pt-BR' },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
        Capacitor: {
            isNativePlatform: () => native,
            getPlatform: () => (native ? 'android' : 'web'),
            Plugins: {},
            registerPlugin: (n) => { calls.registerPlugin.push(n); win.Capacitor.Plugins[n] = {}; }
        }
    };
    const fake = makeFakeCdv(o, calls);
    if (o.lazy) {
        // biblioteca ainda não carregada: o <script> injetado a define
        win.document = {
            head: { appendChild: (el) => { calls.scripts.push(el.src); win.CdvPurchase = fake; setTimeout(() => el.onload(), 0); } },
            createElement: () => ({})
        };
    } else {
        win.CdvPurchase = fake;
    }
    return { win, calls };
}

const create = (win, extra) => FuelBilling._create(win, Object.assign({}, FAST, extra));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('productId é fuel_tracker_pro e objeto é imutável/sem configure', () => {
    assert.strictEqual(FuelBilling.PRODUCT_ID, 'fuel_tracker_pro');
    assert.ok(Object.isFrozen(FuelBilling));
    assert.strictEqual(FuelBilling.configure, undefined);
    assert.strictEqual(FuelBilling.CONFIG, undefined);
});

test('nenhum host (inclusive localhost do Capacitor) concede PRO; flag antiga e registro simples não valem', () => {
    const storage = makeStorage({ fuelTrackerPro: 'true', fuelTrackerEntitlement: JSON.stringify({ pro: true }) });
    ['app.example.com', 'localhost', '127.0.0.1'].forEach((hostname) => {
        const b = create(makeWin({ storage, hostname }).win);
        assert.strictEqual(b.isPro(), false);
        assert.strictEqual(b.isDev, undefined);
        assert.strictEqual(b.devSetPro, undefined);
    });
});

test('modo de teste removido: sem TRIAL_FORCE_PRO, sem forçar PRO e sem menu Dev', () => {
    const root = path.join(__dirname, '..');
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const bill = fs.readFileSync(path.join(root, 'billing.js'), 'utf8');
    assert.strictEqual(FuelBilling.TRIAL_FORCE_PRO, undefined);
    assert.ok(!/TRIAL_FORCE_PRO/.test(app + bill + html), 'TRIAL_FORCE_PRO não pode existir');
    assert.ok(!/devPlanMenu|toggleDevPlan|devSetPro|Dev:\s*Lite/.test(app + html + bill), 'menu Dev não pode existir');
    assert.ok(!/isDev\s*\(/.test(app + bill), 'isDev() não pode existir');
});

test('produto registrado como NON_CONSUMABLE na Google Play, só fuel_tracker_pro; preço vem da Play', async () => {
    const { win, calls } = makeWin();
    const b = create(win);
    assert.strictEqual(await b.getPriceText(), 'R$ 4,90');
    assert.strictEqual(calls.register.length, 1);
    assert.deepStrictEqual(calls.register[0], { id: 'fuel_tracker_pro', type: 'non consumable', platform: 'android-playstore' });
    assert.deepStrictEqual(calls.init, [['android-playstore']]);
});

test('compra: finish (acknowledge) chamado, PRO liberado só depois, licença selada gravada', async () => {
    const { win, calls } = makeWin();
    const b = create(win);
    const changes = [];
    b.onChange((v) => changes.push(v));
    const r = await b.purchase();
    assert.strictEqual(r.status, 'purchased');
    assert.deepStrictEqual(calls.finish, ['tok-123']);
    assert.deepStrictEqual(calls.order.map((x) => x.productId), ['fuel_tracker_pro']);
    assert.strictEqual(b.isPro(), true);
    assert.deepStrictEqual(changes, [true]);
    const rec = JSON.parse(win.localStorage.getItem('fuelTrackerEntitlement'));
    assert.ok(rec.seal && rec.tokenHash && rec.sku === 'fuel_tracker_pro');
});

test('compra: falha no acknowledge NÃO libera PRO', async () => {
    const { win } = makeWin({ ackFails: true });
    const b = create(win);
    assert.strictEqual((await b.purchase()).status, 'unverified');
    assert.strictEqual(b.isPro(), false);
    assert.strictEqual(win.localStorage.getItem('fuelTrackerEntitlement'), null);
});

test('compra cancelada, pagamento pendente e fora do app nativo não liberam PRO', async () => {
    const c = create(makeWin({ cancel: true }).win);
    assert.strictEqual((await c.purchase()).status, 'cancelled');
    assert.strictEqual(c.isPro(), false);
    const p = create(makeWin({ pending: true }).win);
    assert.strictEqual((await p.purchase()).status, 'pending');
    assert.strictEqual(p.isPro(), false);
    const u = create(makeWin({ native: false }).win);
    assert.strictEqual((await u.purchase()).status, 'unsupported');
    assert.strictEqual(u.isPro(), false);
    assert.deepStrictEqual(await u.getAvailability(), { ok: false, reason: 'unsupported' });
});

test('web/PWA: init não concede PRO nem com licença selada válida no localStorage', async () => {
    const first = makeWin();
    await create(first.win).purchase();
    const saved = first.win.localStorage.getItem('fuelTrackerEntitlement');
    const web = makeWin({ native: false, storage: makeStorage({ fuelTrackerEntitlement: saved }) });
    const b = create(web.win);
    assert.strictEqual((await b.init()).status, 'unsupported');
    assert.strictEqual(b.isPro(), false);
});

test('verifyLicense é pluggável: false recusa (sem acknowledge), null não libera nem revoga', async () => {
    const calls = [];
    const no = makeWin();
    const b = create(no.win, { verifyLicense: async (p) => { calls.push(p); return false; } });
    assert.strictEqual((await b.purchase()).status, 'rejected');
    assert.strictEqual(b.isPro(), false);
    assert.deepStrictEqual(no.calls.finish, []);
    assert.deepStrictEqual(calls, [{ productId: 'fuel_tracker_pro', purchaseToken: 'tok-123', transactionId: 'tr-tok-123' }]);

    const unk = makeWin();
    const b2 = create(unk.win, { verifyLicense: async () => null });
    assert.strictEqual((await b2.purchase()).status, 'unverified');
    assert.strictEqual(b2.isPro(), false);
    assert.deepStrictEqual(unk.calls.finish, []);
});

test('licença selada de outro produto é rejeitada; compra de outro produto não concede PRO', async () => {
    const first = makeWin();
    await create(first.win).purchase();
    const rec = JSON.parse(first.win.localStorage.getItem('fuelTrackerEntitlement'));
    rec.sku = 'outro_produto';
    const old = makeWin({ initErrors: true, storage: makeStorage({ fuelTrackerEntitlement: JSON.stringify(rec) }) });
    const b = create(old.win);
    await b.init();
    assert.strictEqual(b.isPro(), false);
    const other = makeWin({ owned: [{ token: 'x', acked: true, productId: 'outro_produto' }] });
    const b2 = create(other.win);
    assert.strictEqual((await b2.init()).status, 'free');
    assert.strictEqual(b2.isPro(), false);
});

test('offline (erro ao iniciar a loja): licença selada válida mantém PRO; adulterada é descartada', async () => {
    const first = makeWin();
    await create(first.win).purchase();
    const saved = first.win.localStorage.getItem('fuelTrackerEntitlement');

    const off = makeWin({ initErrors: true, storage: makeStorage({ fuelTrackerEntitlement: saved }) });
    const b = create(off.win);
    assert.strictEqual((await b.init()).status, 'error');
    assert.strictEqual(b.isPro(), true);

    const forged = JSON.parse(saved); forged.tokenHash = 'forjado';
    const bad = makeWin({ initErrors: true, storage: makeStorage({ fuelTrackerEntitlement: JSON.stringify(forged) }) });
    const b2 = create(bad.win);
    await b2.init();
    assert.strictEqual(b2.isPro(), false);
    assert.strictEqual(bad.win.localStorage.getItem('fuelTrackerEntitlement'), null);

    const simple = makeWin({ initErrors: true, storage: makeStorage({ fuelTrackerEntitlement: '{"pro":true}' }) });
    const b3 = create(simple.win);
    await b3.init();
    assert.strictEqual(b3.isPro(), false);
});

test('offline: licença selada expirada (>30 dias) é descartada', async () => {
    const first = makeWin();
    await create(first.win).purchase();
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 24 * 60 * 60 * 1000;
    try {
        const off = makeWin({ initErrors: true, storage: makeStorage({ fuelTrackerEntitlement: first.win.localStorage.getItem('fuelTrackerEntitlement') }) });
        const b = create(off.win);
        await b.init();
        assert.strictEqual(b.isPro(), false);
    } finally { Date.now = realNow; }
});

test('init online (reinstalação/aparelho novo): compra já confirmada na Play restaura o PRO sem novo acknowledge', async () => {
    const owned = makeWin({ owned: [{ token: 't1', acked: true }] });
    const b = create(owned.win);
    assert.strictEqual((await b.init()).status, 'pro');
    assert.strictEqual(b.isPro(), true);
    assert.deepStrictEqual(owned.calls.finish, []);
});

test('código promocional / compra ainda não confirmada: init confirma (acknowledge) e libera PRO', async () => {
    const promo = makeWin({ owned: [{ token: 'promo-1', acked: false }] });
    const b = create(promo.win);
    assert.strictEqual((await b.init()).status, 'pro');
    assert.strictEqual(b.isPro(), true);
    assert.deepStrictEqual(promo.calls.finish, ['promo-1']);
});

test('reembolso: Play deixa de listar o produto => init e refresh revogam o PRO e limpam a licença', async () => {
    const first = makeWin();
    await create(first.win).purchase();
    const saved = first.win.localStorage.getItem('fuelTrackerEntitlement');
    const refunded = makeWin({ owned: [], storage: makeStorage({ fuelTrackerEntitlement: saved }) });
    const b = create(refunded.win);
    assert.strictEqual((await b.init()).status, 'free');
    assert.strictEqual(b.isPro(), false);
    assert.strictEqual(refunded.win.localStorage.getItem('fuelTrackerEntitlement'), null);

    // reembolso detectado ao voltar do segundo plano
    const live = makeWin({ owned: [{ token: 't1', acked: true }], afterRestore: [] });
    const b2 = create(live.win);
    await b2.init();
    assert.strictEqual(b2.isPro(), true);
    const changes = [];
    b2.onChange((v) => changes.push(v));
    assert.strictEqual((await b2.refresh()).status, 'free');
    assert.strictEqual(b2.isPro(), false);
    assert.deepStrictEqual(changes, [false]);
});

test('erro da Play/rede ao reconsultar NUNCA revoga o PRO', async () => {
    const w = makeWin({ owned: [{ token: 't1', acked: true }], restoreError: true });
    const b = create(w.win);
    await b.init();
    assert.strictEqual(b.isPro(), true);
    assert.strictEqual((await b.refresh()).status, 'error');
    assert.strictEqual(b.isPro(), true);
});

test('Restaurar compra: encontra a compra da conta e libera PRO', async () => {
    const w = makeWin({ owned: [], afterRestore: [{ token: 'novo-aparelho', acked: true }] });
    const b = create(w.win);
    assert.strictEqual((await b.init()).status, 'free');
    assert.strictEqual((await b.restore()).status, 'pro');
    assert.strictEqual(b.isPro(), true);
    assert.strictEqual(w.calls.restore, 1);
});

test('plugin nativo: carrega vendor/cdv-purchase/store.js e registra PurchasePlugin só no app nativo', async () => {
    const w = makeWin({ lazy: true });
    const b = create(w.win);
    assert.strictEqual((await b.getAvailability()).ok, true);
    assert.deepStrictEqual(w.calls.scripts, ['vendor/cdv-purchase/store.js']);
    assert.deepStrictEqual(w.calls.registerPlugin, ['PurchasePlugin']);
    assert.deepStrictEqual(w.win.CdvPurchaseCapacitor, { installed: true });
    const web = makeWin({ lazy: true, native: false });
    await create(web.win).getAvailability();
    assert.deepStrictEqual(web.calls.scripts, []);
});

test('biblioteca vendorizada é idêntica à do pacote instalado', () => {
    const root = path.join(__dirname, '..');
    const vendored = path.join(root, 'vendor', 'cdv-purchase', 'store.js');
    assert.ok(fs.existsSync(vendored), 'vendor/cdv-purchase/store.js ausente');
    const pkg = path.join(root, 'node_modules', 'capacitor-plugin-cdv-purchase', 'www', 'store.js');
    if (fs.existsSync(pkg)) assert.ok(fs.readFileSync(vendored).equals(fs.readFileSync(pkg)), 'vendor desatualizado: rode npm run vendor:purchase');
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

test('código-fonte: sem processProUpgrade, sem Digital Goods API, sem compra simulada com setTimeout de liberação', () => {
    const root = path.join(__dirname, '..');
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const bill = fs.readFileSync(path.join(root, 'billing.js'), 'utf8');
    assert.ok(!/processProUpgrade/.test(app + html));
    assert.ok(!/getDigitalGoodsService|PaymentRequest/.test(bill));
    assert.ok(!/setPro\(true\)[^\n]*setTimeout|setTimeout[^\n]*setPro\(true\)/.test(bill));
    assert.ok(/FuelBilling\.purchase\(\)/.test(app));
    assert.ok(/startProPurchase\(\)/.test(html));
    assert.ok(/restoreProPurchase\(\)/.test(html) && /FuelBilling\.restore\(\)/.test(app), 'botão Restaurar compra');
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log('  ok   - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n         ' + e.message); }
    }
    console.log(failed ? `\n${failed} teste(s) falharam` : `\nTodos os ${tests.length} testes passaram`);
    process.exit(failed ? 1 : 0);
})();
