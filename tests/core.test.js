// Testes do core.js (funções puras). Execute: node tests/core.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const FuelCore = require('../core.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const rec = (date, odo, valorG, precoG, fullTank = true) => ({ date, odo, precoA: 0, valorA: 0, precoG, valorG, fullTank });

test('km/L: um segmento entre dois tanques cheios', () => {
    // 100 km com 10 L (50 / 5,00) => 10 km/L; o 1º tanque cheio só marca o início
    const segs = FuelCore.computeConsumptionSegments([rec('2026-01-01', 1000, 50, 5), rec('2026-01-10', 1100, 50, 5)]);
    assert.strictEqual(segs.length, 1);
    assert.strictEqual(segs[0].km, 100);
    assert.strictEqual(segs[0].liters, 10);
    assert.strictEqual(segs[0].kml, 10);
    assert.strictEqual(segs[0].fuel, 'G');
});

test('km/L: parcial acumula litros e não fecha segmento; ordem de entrada não importa', () => {
    const list = [rec('2026-01-20', 1200, 25, 5), rec('2026-01-01', 1000, 50, 5), rec('2026-01-10', 1100, 25, 5, false)];
    const segs = FuelCore.computeConsumptionSegments(list);
    assert.strictEqual(segs.length, 1);
    assert.strictEqual(segs[0].km, 200);
    assert.strictEqual(segs[0].liters, 10); // 5 L parcial + 5 L do tanque que fecha
});

test('km/L: sem tanque cheio ou odômetro repetido não gera segmento', () => {
    assert.strictEqual(FuelCore.computeConsumptionSegments([rec('2026-01-01', 1000, 50, 5, false), rec('2026-01-10', 1100, 50, 5, false)]).length, 0);
    assert.strictEqual(FuelCore.computeConsumptionSegments([rec('2026-01-01', 1000, 50, 5), rec('2026-01-10', 1000, 50, 5)]).length, 0);
    assert.strictEqual(FuelCore.computeConsumptionSegments([]).length, 0);
});

test('km/L: média ponderada = Σkm / ΣL', () => {
    const segs = [{ km: 100, liters: 10 }, { km: 300, liters: 40 }];
    assert.strictEqual(FuelCore.weightedKml(segs), 8);
    assert.strictEqual(FuelCore.weightedKml([]), 0);
});

test('sanitizeRecord: aceita registro válido e converte tipos', () => {
    const r = FuelCore.sanitizeRecord({ date: '2026-02-28', odo: '1500', precoG: '5,50', valorG: '55', fullTank: 'true' });
    assert.ok(r);
    assert.strictEqual(r.odo, 1500);
    assert.strictEqual(r.precoG, 5.5);
    assert.strictEqual(r.fullTank, true);
});

test('sanitizeRecord: rejeita data impossível, odômetro inválido, valores negativos e abastecimento vazio', () => {
    const base = { date: '2026-02-28', odo: 1500, precoG: 5, valorG: 50 };
    assert.strictEqual(FuelCore.sanitizeRecord(Object.assign({}, base, { date: '2026-02-30' })), null);
    assert.strictEqual(FuelCore.sanitizeRecord(Object.assign({}, base, { date: '28/02/2026' })), null);
    assert.strictEqual(FuelCore.sanitizeRecord(Object.assign({}, base, { odo: -1 })), null);
    assert.strictEqual(FuelCore.sanitizeRecord(Object.assign({}, base, { odo: 1.5 })), null);
    assert.strictEqual(FuelCore.sanitizeRecord(Object.assign({}, base, { odo: FuelCore.MAX_ODOMETER + 1 })), null);
    assert.strictEqual(FuelCore.sanitizeRecord(Object.assign({}, base, { valorG: -5 })), null);
    assert.strictEqual(FuelCore.sanitizeRecord(Object.assign({}, base, { valorG: 0, valorA: 0 })), null);
    assert.strictEqual(FuelCore.sanitizeRecord(null), null);
    assert.strictEqual(FuelCore.sanitizeRecord('texto'), null);
});

test('filterRecordsByPeriod: 30d, mês, ano e tudo', () => {
    const ref = new Date(2026, 5, 15); // 15/06/2026
    const list = [rec('2026-05-17', 1, 1, 1), rec('2026-05-16', 2, 1, 1), rec('2026-06-01', 3, 1, 1), rec('2025-12-31', 4, 1, 1)];
    const odos = (p) => FuelCore.filterRecordsByPeriod(list, p, ref).map(r => r.odo).sort();
    assert.deepStrictEqual(odos('30d'), [1, 3]); // hoje + 29 dias anteriores => desde 17/05
    assert.deepStrictEqual(odos('month'), [3]);
    assert.deepStrictEqual(odos('year'), [1, 2, 3]);
    assert.deepStrictEqual(odos('all'), [1, 2, 3, 4]);
    assert.deepStrictEqual(FuelCore.filterRecordsByPeriod(null, 'all', ref), []);
});

test('calculatePeriodTotals: litros e gasto', () => {
    const t = FuelCore.calculatePeriodTotals([rec('2026-01-01', 1, 50, 5), rec('2026-01-02', 2, 30, 6)]);
    assert.strictEqual(t.liters, 15);
    assert.strictEqual(t.spent, 80);
    assert.strictEqual(t.count, 2);
    assert.deepStrictEqual(FuelCore.calculatePeriodTotals(null), { liters: 0, spent: 0, count: 0 });
});

test('safeRound / parseDecimalValue / toLocalISODate', () => {
    assert.strictEqual(FuelCore.safeRound(1.005, 2), 1.01);
    assert.strictEqual(FuelCore.parseDecimalValue('1,5'), 1.5);
    assert.strictEqual(FuelCore.toLocalISODate(new Date(2026, 0, 5)), '2026-01-05');
});

test('limite do plano Lite definido em app.js (10 lançamentos) e checado no cadastro', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.ok(/const LITE_RECORD_LIMIT = 10;/.test(app));
    assert.ok(/!isProPlan\(\) && records\.length >= LITE_RECORD_LIMIT/.test(app));
});

test('Indicar para Amigo: compartilha o link da Play Store, não window.location.href', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.ok(app.includes('https://play.google.com/store/apps/details?id=io.github.julianodecarlo.twa'));
    const fn = app.slice(app.indexOf('async function shareAppWithFriend'), app.indexOf('function toggleSettingsMenu'));
    assert.ok(!fn.includes('window.location.href'));
});

test('build de produção: diagnostico.html fora do copy-web e do sw.js', () => {
    const copy = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'copy-web.js'), 'utf8');
    const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    assert.ok(!/FILES = \[[^\]]*diagnostico/.test(copy));
    assert.ok(!/'diagnostico\.html'/.test(sw));
});

test('www/ não é versionado (.gitignore)', () => {
    const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    assert.ok(/^\/?www\/?\s*$/m.test(gi));
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log('  ok   - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n         ' + e.message); }
    }
    console.log(failed ? `\n${failed} teste(s) falharam` : `\nTodos os ${tests.length} testes do core passaram`);
    process.exit(failed ? 1 : 0);
})();
