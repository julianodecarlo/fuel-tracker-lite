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

test('acessibilidade: nenhum texto abaixo de 12px (9/10/11px) em index.html e app.js', () => {
    for (const f of ['index.html', 'app.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        const bad = src.match(/text-\[(9|10|11)px\]|font-size:\s*(9|10|11)px/g);
        assert.strictEqual(bad, null, f + ' ainda tem texto < 12px: ' + bad);
    }
});

function manualHtml() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const i = html.indexOf('id="manualModal"');
    const j = html.indexOf('id="tireModal"');
    assert.ok(i > 0 && j > i, 'manualModal não encontrado');
    return html.slice(i, j);
}

test('manual: tem >= 12 tópicos <details>', () => {
    assert.ok((manualHtml().match(/<details\b/g) || []).length >= 12);
});

test('manual: aviso de backup e responsabilidade do usuário', () => {
    const m = manualHtml();
    for (const s of ['Limpar armazenamento', 'responsabilidade exclusiva do usuário', 'não consegue recuperar nem restaurar']) {
        assert.ok(m.includes(s), 'falta: ' + s);
    }
});

test('Indicar para Amigo: no app nativo não mostra toast de sucesso falso; mantém plano B de copiar o link', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('async function shareAppWithFriend'), app.indexOf('function toggleSettingsMenu'));
    const nativo = fn.slice(fn.indexOf('native.share.share'), fn.indexOf('navigator.share &&'));
    assert.ok(nativo.length > 20 && !/showToast\(\s*'Obrigado/.test(nativo), 'toast de sucesso no ramo nativo');
    assert.ok(/clipboard\.writeText/.test(fn) && /Link de indicação copiado/.test(fn), 'plano B de copiar o link');
});

function manualTopics() {
    const m = manualHtml();
    const out = [];
    const re = /<details\b[^>]*>([\s\S]*?)<\/details>/g;
    let x;
    while ((x = re.exec(m))) {
        const title = (x[1].match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '';
        const text = x[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        out.push({ title: title.replace(/<[^>]*>/g, '').trim(), text, words: text.split(' ').length });
    }
    return out;
}

test('manual v2: >= 14 tópicos <details>, cada um com 35 a 140 palavras', () => {
    const t = manualTopics();
    assert.ok(t.length >= 14, 'tópicos: ' + t.length);
    for (const x of t) assert.ok(x.words >= 35 && x.words <= 140, x.title + ' tem ' + x.words + ' palavras');
});

test('manual v2: títulos na ordem prevista (menu na ordem do #settingsDropdown)', () => {
    const titles = manualTopics().map(x => x.title);
    assert.deepStrictEqual(titles, ['Planos: Lite x PRO', 'Decisão no posto', 'Resumo e novo abastecimento', 'Histórico', 'Análise (PRO)',
        'Revisão e documentos', 'Aparência', 'Veículos', 'Indicar para amigo', 'Backup / Restaurar', 'Exportar Excel (PRO)', 'Zerar App',
        'Tamanho do texto', 'Privacidade e armazenamento']);
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const dd = html.slice(html.indexOf('id="settingsDropdown"'), html.indexOf('</header>'));
    const menu = [...dd.matchAll(/<\/i>\s*([^<]+?)<\/span>\s*(?:<span id="themeMenuLabel"|<\/button>)/g)].map(m => m[1].trim());
    const esperado = ['Aparência', 'Veículos', 'Indicar para Amigo', 'Manual do Usuário', 'Backup / Restaurar', 'Exportar Excel', 'Zerar App'];
    assert.deepStrictEqual(menu, esperado);
    const norm = s => s.replace(/ \(PRO\)/, '').toLowerCase();
    const pos = esperado.filter(n => n !== 'Manual do Usuário').map(n => titles.findIndex(t => norm(t) === n.toLowerCase()));
    assert.ok(pos.every(p => p >= 0) && pos.every((p, i) => i === 0 || p > pos[i - 1]), 'ordem do menu: ' + pos);
});

test('manual v2: quadro de aviso depois de #manualTopics e fora dele', () => {
    const m = manualHtml();
    const iT = m.indexOf('id="manualTopics"');
    const iW = m.indexOf('class="manual-warn"');
    const iEnd = m.lastIndexOf('</details>');
    assert.ok(iT > 0 && iW > iEnd && iW > iT, 'aviso deve vir depois dos tópicos');
    assert.ok(m.includes('id="manualScroll"'));
});

test('manual v2: CSS sem borda nos tópicos, .manual-body com padding-top >= 8px, corpo 14px', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    for (const m of html.matchAll(/(?:html\.dark\s+)?\.manual-topic\s*\{([^}]*)\}/g)) assert.ok(!/border/.test(m[1]), 'borda em .manual-topic');
    assert.ok(!/class="manual-topic[^"]*\bborder/.test(html), 'classe border no tópico');
    const b = html.match(/\.manual-body\s*\{([^}]*)\}/)[1];
    const px = v => { const n = parseFloat(v); return /rem/.test(v) ? n * 16 : n; };
    assert.ok(px(b.match(/padding-top:\s*([\d.]+r?e?m?p?x?)/)[1]) >= 8, 'padding-top');
    for (const k of ['right', 'bottom', 'left']) assert.ok(px(b.match(new RegExp('padding-' + k + ':\\s*([\\d.]+(?:rem|px))'))[1]) >= 16, 'padding-' + k);
    assert.ok(/font-size:\s*\.875rem/.test(b));
    assert.ok(/\.manual-sum\s*\{[^}]*min-height:\s*48px/.test(html));
});

test('manual v3: scrollIntoView ao abrir tópico; sem busca', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.ok(/scrollIntoView\(\{\s*block:\s*'start'/.test(app) && /prefers-reduced-motion/.test(app));
    assert.ok(!/autoToggle|filterManual|normalizeSearchText/.test(app));
});

test('manual: menciona Lite e PRO', () => {
    const m = manualHtml();
    assert.ok(m.includes('Lite') && m.includes('PRO'));
});

test('manual: sem termos proibidos nem preço', () => {
    const m = manualHtml();
    assert.ok(!/teste interno|beta|alpha|testador|trial|github/i.test(m), 'termo proibido: ' + m.match(/teste interno|beta|alpha|testador|trial|github/i));
    assert.ok(!m.includes('R$'), 'preço em reais');
});

test('verdes: .text-etanol e .text-verde-suave existem e diferem (claro e escuro)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(/\.text-etanol\s*\{\s*color:\s*var\(--verde-etanol\)/.test(html), 'falta .text-etanol');
    assert.ok(/\.text-verde-suave\s*\{\s*color:\s*var\(--verde-suave\)/.test(html), 'falta .text-verde-suave');
    const get = (re, n) => { const m = html.match(re); assert.ok(m, 'variavel ausente: ' + n); return m[1].toLowerCase(); };
    const lE = get(/:root\s*\{[^}]*--verde-etanol:\s*(#[0-9a-f]{6})/i, 'etanol claro');
    const lS = get(/:root\s*\{[^}]*--verde-suave:\s*(#[0-9a-f]{6})/i, 'suave claro');
    const dE = get(/html\.dark\s*\{[^}]*--verde-etanol:\s*(#[0-9a-f]{6})/i, 'etanol escuro');
    const dS = get(/html\.dark\s*\{[^}]*--verde-suave:\s*(#[0-9a-f]{6})/i, 'suave escuro');
    assert.notStrictEqual(lE, lS);
    assert.notStrictEqual(dE, dS);
    // contraste WCAG do verde suave >= 4.5:1 nos fundos mais claros/escuros usados
    const L = h => { const c = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    for (const bg of ['#fbf8f3', '#efe8db', '#e7e0d2']) assert.ok(cr(lS, bg) >= 4.5, 'claro ' + bg);
    for (const bg of ['#0f172a', '#1e293b']) assert.ok(cr(dS, bg) >= 4.5, 'escuro ' + bg);
});

const DAY = 86400000;
const NOW_T = new Date(2026, 10, 8, 12, 0, 0).getTime();
test('backup: sem backup e sem referência => "Sem backup", não atrasado', () => {
    const s = FuelCore.getBackupStatus(NOW_T, 0, 0);
    assert.strictEqual(s.text, 'Sem backup');
    assert.strictEqual(s.hasBackup, false);
    assert.strictEqual(s.overdue, false);
});
test('backup: sem backup mas referência há 31 dias => "Sem backup" e atrasado', () => {
    const s = FuelCore.getBackupStatus(NOW_T, 0, NOW_T - 31 * DAY);
    assert.strictEqual(s.text, 'Sem backup');
    assert.strictEqual(s.overdue, true);
});
test('backup: 10 dias => em dia, com data dd/mm/aaaa', () => {
    const s = FuelCore.getBackupStatus(NOW_T, NOW_T - 10 * DAY, 0);
    assert.strictEqual(s.overdue, false);
    assert.strictEqual(s.days, 10);
    assert.strictEqual(s.text, 'Backup: 29/10/2026');
});
test('backup: 31 dias => atrasado; 30 dias exatos ainda em dia', () => {
    assert.strictEqual(FuelCore.getBackupStatus(NOW_T, NOW_T - 31 * DAY, 0).overdue, true);
    assert.strictEqual(FuelCore.getBackupStatus(NOW_T, NOW_T - 30 * DAY, 0).overdue, false);
});
test('backup: formato da data é dd/mm/aaaa com zeros à esquerda (fuso local)', () => {
    assert.strictEqual(FuelCore.formatBackupDate(new Date(2026, 0, 5, 23, 30).getTime()), '05/01/2026');
    assert.strictEqual(FuelCore.formatBackupDate(new Date(2026, 10, 8, 0, 5).getTime()), '08/11/2026');
});
test('rodapé: "Base Local Ativa" removido; lembrete e rodapé usam a mesma getBackupStatus', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.ok(!/Base Local Ativa/.test(html + app));
    assert.ok(/id="backupStatus"/.test(html));
    assert.ok(/id="appVersionFooter"/.test(html));
    const reminder = app.slice(app.indexOf('function checkBackupReminder'), app.indexOf('function normalizeImportedRecord'));
    const footer = app.slice(app.indexOf('function renderBackupFooter'), app.indexOf('function checkBackupReminder'));
    assert.ok(/getBackupStatus\(/.test(reminder) && /getBackupStatus\(/.test(footer));
});

// ---- manual v3 e veículos no Lite ----
function appSrc() { return fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n'); }
function grabFn(app, start) { const i = app.indexOf(start); assert.ok(i >= 0, 'trecho não encontrado: ' + start); return app.slice(i, app.indexOf('\n    }\n', i) + 7); }

function loadVehicles(pro, initial) {
    const app = appSrc();
    const src = [app.match(/const VEHICLE_PRO_MESSAGE = .*;/)[0], 'function openVehicleModal()', 'function editVehicle(', 'function requestEditVehicle(', 'function deleteVehicle(', 'function saveVehicle(']
        .map(s => grabFn(app, s)).join('\n');
    const els = {};
    const el = (id) => els[id] || (els[id] = { value: '', textContent: '', classList: { toggle() {}, add() {}, remove() {} } });
    const st = { pro, vehicles: initial.map(v => ({ ...v })), saved: 0, blocked: [], errors: [], toasts: [], els };
    const sandbox = {
        document: { getElementById: el },
        isProPlan: () => st.pro, renderVehicleList() {}, showModal() {}, hideModal() {}, clearInlineError() {},
        showInlineError: (id, msg) => st.errors.push(msg), blockLiteFeature: (m) => st.blocked.push(m),
        showToast: (m) => st.toasts.push(m), normalizePlate: (p) => p, isValidPlate: () => true,
        saveVehicles: () => { st.saved++; return true; }, saveActiveVehicle() {}, renderVehicleSelector() {}, recalculateMetricsAndRender() {},
        loadRecords() {}, loadTireConfig() {}, loadRevisionConfig() {}, resetForm() {}, closeVehicleModal() {},
        confirm: () => true, localStorage: { removeItem() {} }, VEHICLE_SCOPED_KEYS: [], getVehicleScopedKey: (k, id) => k + id,
        getActiveVehicle: () => st.vehicles.find(v => v.id === st.activeVehicleId)
    };
    ['vehicleNameInput', 'vehiclePlateInput', 'vehicleEditId'].forEach(el);
    el('vehicleForm').reset = () => { ['vehicleNameInput', 'vehiclePlateInput', 'vehicleEditId'].forEach(i => { el(i).value = ''; }); };
    const api = require('vm').runInNewContext('var vehicles, activeVehicleId;' + src + '; ({ openVehicleModal, requestEditVehicle, deleteVehicle, saveVehicle, set(v, a) { vehicles = v; activeVehicleId = a; }, get() { return vehicles; } })', sandbox);
    api.set(st.vehicles, initial[0].id);
    st.api = api;
    return st;
}
const V2 = [{ id: 'v1', name: 'Gol', plate: 'ABC-1234' }, { id: 'v2', name: 'Uno', plate: 'DEF-5678' }];
const submit = (st, name, plate, editId) => {
    st.els.vehicleNameInput.value = name; st.els.vehiclePlateInput.value = plate; st.els.vehicleEditId.value = editId;
    st.api.saveVehicle({ preventDefault() {} });
};

test('veículos Lite: abre a gestão e preenche o veículo ativo; PRO abre o formulário vazio', () => {
    const l = loadVehicles(false, V2.slice(0, 1));
    l.api.openVehicleModal();
    assert.strictEqual(l.els.vehicleNameInput.value, 'Gol');
    assert.strictEqual(l.els.vehiclePlateInput.value, 'ABC-1234');
    assert.strictEqual(l.els.vehicleEditId.value, 'v1');
    assert.deepStrictEqual(l.blocked, []);
    const p = loadVehicles(true, V2);
    p.api.openVehicleModal();
    assert.strictEqual(p.els.vehicleNameInput.value, '');
    assert.strictEqual(p.els.vehicleEditId.value, '');
});

test('veículos Lite: salva edição do veículo ativo', () => {
    const l = loadVehicles(false, V2.slice(0, 1));
    submit(l, 'Carro da família', 'XYZ-9876', 'v1');
    assert.strictEqual(l.saved, 1);
    assert.deepStrictEqual(l.api.get().map(v => [v.id, v.name, v.plate]), [['v1', 'Carro da família', 'XYZ-9876']]);
    assert.deepStrictEqual(l.blocked, []);
});

test('veículos Lite: cadastrar novo ou editar outro é bloqueado e nada é gravado', () => {
    const l = loadVehicles(false, V2);
    submit(l, 'Novo', 'NOV-0001', '');
    submit(l, 'Outro', 'OUT-0002', 'v2');
    assert.strictEqual(l.saved, 0);
    assert.strictEqual(l.blocked.length, 2);
    assert.strictEqual(l.blocked[0], 'Cadastrar mais veículos é exclusivo do plano PRO.');
    assert.deepStrictEqual(l.api.get().map(v => v.name), ['Gol', 'Uno']);
    l.api.requestEditVehicle('v2');
    assert.strictEqual(l.blocked.length, 3);
    l.api.requestEditVehicle('v1');
    assert.strictEqual(l.els.vehicleNameInput.value, 'Gol');
});

test('veículos Lite: nome obrigatório com a nova mensagem; não exclui (ex-PRO não perde nada)', () => {
    const l = loadVehicles(false, V2.slice(0, 1));
    submit(l, '  ', 'ABC-1234', 'v1');
    assert.deepStrictEqual(l.errors, ['Informe o nome ou apelido do veículo.']);
    const ex = loadVehicles(false, V2);
    ex.api.deleteVehicle('v2');
    ex.api.deleteVehicle('v1');
    assert.strictEqual(ex.saved, 0);
    assert.strictEqual(ex.api.get().length, 2);
    assert.strictEqual(ex.blocked.length, 2);
});

test('veículos PRO: cadastra, edita e exclui como antes', () => {
    const p = loadVehicles(true, V2.slice(0, 1));
    submit(p, 'Uno', 'DEF-5678', '');
    assert.strictEqual(p.api.get().length, 2);
    const novo = p.api.get()[1].id;
    submit(p, 'Uno Mille', 'DEF-5678', novo);
    assert.strictEqual(p.api.get()[1].name, 'Uno Mille');
    p.api.deleteVehicle(novo);
    assert.strictEqual(p.api.get().length, 1);
    p.api.deleteVehicle('v1');
    assert.strictEqual(p.api.get().length, 1, 'não exclui o único');
    assert.deepStrictEqual(p.blocked, []);
});

test('veículos: modal com aviso do Lite e rótulo "Nome ou apelido"', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(/id="vehicleLiteNote"[^>]*>Plano Lite: 1 veículo\. Para cadastrar mais, assine o PRO\.</.test(html));
    assert.ok(/>Nome ou apelido</.test(html));
});

test('manual v3: sem busca; grupos em <div data-group>; texto fixo no topo', () => {
    const m = manualHtml();
    assert.ok(!/manualSearch|manualEmpty|data-kw/.test(m), 'resquício da busca');
    assert.ok(m.includes('Toque no item para abrir a descrição completa.'));
    assert.ok(m.includes('Menu ⚙</h4>') && !m.includes('Menu da engrenagem'));
    const g = [...m.matchAll(/data-group="(\w+)"/g)].map(x => x[1]);
    assert.deepStrictEqual(g, ['entenda', 'abas', 'menu', 'dados']);
});

test('manual v3: "Entenda o app" primeiro no Lite, depois de "Seus dados" no PRO, sempre antes do quadro âmbar', () => {
    const app = appSrc();
    assert.ok(/function openManualModal\(\) \{\s*orderManualGroups\(\);/.test(app), 'reavalia ao abrir');
    const box = {
        kids: ['entenda', 'abas', 'menu', 'dados'].map(name => ({ name })),
        get firstElementChild() { return this.kids[0]; },
        querySelector(sel) { const n = sel.match(/"(\w+)"/)[1]; return this.kids.find(k => k.name === n); },
        appendChild(n) { this.kids = this.kids.filter(k => k !== n); this.kids.push(n); },
        insertBefore(n, ref) { this.kids = this.kids.filter(k => k !== n); this.kids.splice(this.kids.indexOf(ref), 0, n); }
    };
    let pro = false;
    const fn = require('vm').runInNewContext(grabFn(app, 'function orderManualGroups()') + '; orderManualGroups', { document: { getElementById: () => box }, isProPlan: () => pro });
    fn(); assert.deepStrictEqual(box.kids.map(k => k.name), ['entenda', 'abas', 'menu', 'dados']);
    pro = true; fn(); assert.deepStrictEqual(box.kids.map(k => k.name), ['abas', 'menu', 'dados', 'entenda']);
    pro = false; fn(); assert.deepStrictEqual(box.kids.map(k => k.name), ['entenda', 'abas', 'menu', 'dados']);
    const m = manualHtml();
    assert.ok(m.indexOf('id="manualTopics"') < m.indexOf('class="manual-warn"'));
});

test('manual v3: Excel cita .xlsx; "Como funciona:"; dica de Aparência; Veículos Lite e PRO', () => {
    const t = manualTopics();
    assert.ok(/\.xlsx/.test(t.find(x => x.title.startsWith('Exportar Excel')).text));
    for (const n of ['Planos: Lite x PRO', 'Privacidade e armazenamento']) {
        const x = t.find(y => y.title === n).text;
        assert.ok(x.includes('Como funciona:') && !x.includes('Como usar:'), n);
    }
    assert.ok(t.find(x => x.title === 'Aparência').text.includes('Use o tema mais confortável para o seu ambiente.'));
    assert.ok(/Lite e PRO[\s\S]*1 veículo/.test(t.find(x => x.title === 'Veículos').text));
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log('  ok   - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n         ' + e.message); }
    }
    console.log(failed ? `\n${failed} teste(s) falharam` : `\nTodos os ${tests.length} testes do core passaram`);
    process.exit(failed ? 1 : 0);
})();
