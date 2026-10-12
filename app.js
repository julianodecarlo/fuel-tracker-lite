// app.js - Módulo Encapsulado do Fuel Tracker (com Suporte ao Plano PRO)
const FuelTrackerApp = (() => {
    'use strict';

    const STORAGE_KEY = 'fuel_tracker_records';
    const THEME_STORAGE_KEY = 'fuel_tracker_theme';
    const TIRE_STORAGE_KEY = 'fuel_tracker_tire_config';
    const CNH_STORAGE_KEY = 'fuel_tracker_cnh_config';
    const REVISION_STORAGE_KEY = 'fuel_tracker_revision_config';
    const PLAN_STORAGE_KEY = 'fuel_tracker_plan_status';
    const PRO_FLAG_KEY = 'fuelTrackerPro';
    const LITE_RECORD_LIMIT = 10;
    const VEHICLES_STORAGE_KEY = 'fuel_tracker_vehicles';
    const ACTIVE_VEHICLE_STORAGE_KEY = 'fuel_tracker_active_vehicle';
    const DEFAULT_VEHICLE_ID = 'default';

    const KML_MIN = 5.0;
    const KML_MAX = 23.0;

    let records = [];
    let vehicles = [];
    let activeVehicleId = DEFAULT_VEHICLE_ID;
    let tireConfig = { interval: 10000, lastKm: 0 };
    let cnhConfig = { expiryDate: '', hasToxic: false, toxicExpiryDate: '' };
    let revisionConfig = { interval: 10000 };
    let planStatus = { isPro: false, expiresAt: null };

    let currentAvgMode = 'all';
    let currentKmlCriterion = 'both';
    let currentHistoryFilter = 'ALL';
    let currentAnalysisPeriod = '30d';
    const ANALYSIS_PERIOD_LABELS = {
        '30d': 'Últimos 30 dias',
        'month': 'Mês atual',
        'year': 'Ano atual',
        'all': 'Todo o período'
    };
    let chartInstance = null;
    let distChartInstance = null;
    let deferredPrompt = null;

    let isHistoryDirty = true;

    // --- 1. FUNÇÕES PURAS (SEM DEPENDÊNCIA DE DOM) ---
    function safeRound(value, decimals = 2) {
        return FuelCore.safeRound(value, decimals);
    }

    function parseDecimalValue(val) {
        return FuelCore.parseDecimalValue(val);
    }

    function formatDecimalTwoDigits(val) {
        if (val === null || val === undefined || val === '' || isNaN(val) || val === 0) return '';
        return safeRound(val, 2).toFixed(2).replace('.', ',');
    }

    function formatDateBR(dateStr) {
        if (!dateStr) return '';
        const parts = dateStr.split('-');
        if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
        return dateStr;
    }

    function escapeHtml(str) {
        return FuelCore.escapeHtml(str);
    }

    function validateOdometer(newOdo, currentDate, editIndex) {
        const sorted = [...records]
            .map((r, i) => ({ ...r, index: i }))
            .filter(r => r.index !== editIndex)
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        for (let r of sorted) {
            if (new Date(r.date) < new Date(currentDate) && r.odo >= newOdo) {
                return `O odômetro (${newOdo} km) não pode ser menor ou igual a um registro anterior (${r.odo} km em ${formatDateBR(r.date)}).`;
            }
            if (new Date(r.date) > new Date(currentDate) && r.odo <= newOdo) {
                return `O odômetro (${newOdo} km) não pode ser maior ou igual a um registro posterior (${r.odo} km em ${formatDateBR(r.date)}).`;
            }
        }
        return null;
    }

    function calculateCnhStatus(config, currentDate = new Date()) {
        if (!config || !config.expiryDate) {
            return { status: 'NO_DATA', diffDays: null };
        }
        
        const today = new Date(currentDate);
        today.setHours(0, 0, 0, 0);
        const exp = new Date(config.expiryDate + 'T00:00:00');
        const diffDays = Math.ceil((exp - today) / (1000 * 60 * 60 * 24));

        if (diffDays < 0) return { status: 'EXPIRED', diffDays };
        if (diffDays <= 30) return { status: 'WARNING', diffDays };
        return { status: 'OK', diffDays };
    }

    // --- 2. GERENCIAMENTO DE ARMAZENAMENTO E DADOS ---
    // --- Armazenamento resiliente: leitura tipada (nunca lança) e escrita com retorno booleano ---
    const DEFAULT_TIRE_CONFIG = { interval: 10000, lastKm: 0 };
    const DEFAULT_CNH_CONFIG = { expiryDate: '', hasToxic: false, toxicExpiryDate: '' };
    const DEFAULT_REVISION_CONFIG = { interval: 10000 };
    const DEFAULT_PLAN_STATUS = { isPro: false, expiresAt: null };
    const REJECTED_STORAGE_KEY = 'fuel_tracker_rejected_records';
    // Chaves que pertencem a UM veículo (sufixadas com o id, exceto o veículo "default")
    const VEHICLE_SCOPED_KEYS = [STORAGE_KEY, TIRE_STORAGE_KEY, REVISION_STORAGE_KEY, REJECTED_STORAGE_KEY];

    function isQuotaError(e) {
        return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
            e.code === 22 || e.code === 1014);
    }

    function notifyStorageError(e) {
        showToast(
            isQuotaError(e)
                ? 'Armazenamento cheio! Exporte um backup e libere espaço.'
                : 'Erro ao salvar os dados localmente.',
            'fa-triangle-exclamation', 'text-rose-500'
        );
    }

    function readJSON(key, validate, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null) return fallback;
            const parsed = JSON.parse(raw);
            return (!validate || validate(parsed)) ? parsed : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function writeJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            notifyStorageError(e);
            return false;
        }
    }

    // Grava várias chaves "tudo ou nada". valor === null remove a chave.
    // Se qualquer gravação falhar, restaura o estado anterior de TODAS as chaves.
    function commitWrites(entries) {
        const previous = entries.map(([k]) => [k, localStorage.getItem(k)]);
        try {
            entries.forEach(([k, v]) => {
                if (v === null) localStorage.removeItem(k);
                else localStorage.setItem(k, v);
            });
            return true;
        } catch (e) {
            previous.forEach(([k, v]) => {
                try {
                    if (v === null) localStorage.removeItem(k);
                    else localStorage.setItem(k, v);
                } catch (err) { /* melhor esforço */ }
            });
            notifyStorageError(e);
            return false;
        }
    }

    const isDateStr = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

    function normalizeTireConfig(c) {
        if (!c || typeof c !== 'object') return null;
        const interval = Number(c.interval);
        const lastKm = Number(c.lastKm);
        if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(lastKm) || lastKm < 0) return null;
        return { interval, lastKm };
    }

    function normalizeRevisionConfig(c) {
        if (!c || typeof c !== 'object') return null;
        const interval = Number(c.interval);
        if (!Number.isFinite(interval) || interval <= 0) return null;
        return { interval };
    }

    function normalizeCnhConfig(c) {
        if (!c || typeof c !== 'object') return null;
        return {
            expiryDate: isDateStr(c.expiryDate) ? c.expiryDate : '',
            hasToxic: c.hasToxic === true,
            toxicExpiryDate: isDateStr(c.toxicExpiryDate) ? c.toxicExpiryDate : ''
        };
    }

    function normalizePlanStatus(p) {
        if (!p || typeof p !== 'object') return null;
        return { isPro: p.isPro === true, expiresAt: typeof p.expiresAt === 'string' ? p.expiresAt : null };
    }

    function vehicleKey(baseKey) {
        return activeVehicleId === DEFAULT_VEHICLE_ID ? baseKey : `${baseKey}_${activeVehicleId}`;
    }

    function isValidPlate(value) {
        return /^[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}$/.test(value);
    }

    function normalizePlate(value) {
        const clean = value.replace(/[^A-Z0-9]/g, '');
        return `${clean.slice(0, 3)}-${clean.slice(3)}`;
    }

    function maskPlateInput(value) {
        return normalizePlate(value.toUpperCase());
    }

    function loadVehicles() {
        const raw = readJSON(VEHICLES_STORAGE_KEY, Array.isArray, []);
        vehicles = raw
            .filter(v => v && typeof v === 'object' && v.id !== undefined && v.id !== null && v.id !== '')
            .map(v => ({ id: String(v.id), name: String(v.name || 'Veículo'), plate: v.plate ? String(v.plate) : '' }));
        if (!vehicles.length) {
            vehicles = [{ id: DEFAULT_VEHICLE_ID, name: 'Meu Veículo', plate: '' }];
            saveVehicles();
        }
        const savedActive = localStorage.getItem(ACTIVE_VEHICLE_STORAGE_KEY);
        activeVehicleId = vehicles.some(v => v.id === savedActive) ? savedActive : vehicles[0].id;
    }

    function saveVehicles() {
        return writeJSON(VEHICLES_STORAGE_KEY, vehicles);
    }

    function saveActiveVehicle() {
        try { localStorage.setItem(ACTIVE_VEHICLE_STORAGE_KEY, activeVehicleId); } catch (e) { notifyStorageError(e); }
    }

    function getActiveVehicle() {
        return vehicles.find(v => v.id === activeVehicleId) || vehicles[0];
    }

    function loadRecords() {
        const raw = readJSON(vehicleKey(STORAGE_KEY), Array.isArray, []);
        const clean = [];
        const rejected = [];
        raw.forEach(item => {
            const rec = FuelCore.sanitizeRecord(item);
            if (rec) clean.push(rec); else rejected.push(item);
        });
        records = clean;
        isHistoryDirty = true;
        if (rejected.length) {
            // Quarentena: guarda uma cópia dos itens descartados (nada se perde silenciosamente)
            try { localStorage.setItem(vehicleKey(REJECTED_STORAGE_KEY), JSON.stringify(rejected)); } catch (e) { }
            showToast(`${rejected.length} registro(s) inválido(s) foram ignorados (guardados em quarentena).`,
                'fa-triangle-exclamation', 'text-amber-500');
        }
    }

    function saveRecords() {
        const ok = writeJSON(vehicleKey(STORAGE_KEY), records);
        if (ok) isHistoryDirty = true;
        return ok;
    }

    function loadTireConfig() {
        tireConfig = normalizeTireConfig(readJSON(vehicleKey(TIRE_STORAGE_KEY))) || { ...DEFAULT_TIRE_CONFIG };
    }

    function loadCnhConfig() {
        cnhConfig = normalizeCnhConfig(readJSON(CNH_STORAGE_KEY)) || { ...DEFAULT_CNH_CONFIG };
    }

    function loadRevisionConfig() {
        revisionConfig = normalizeRevisionConfig(readJSON(vehicleKey(REVISION_STORAGE_KEY))) || { ...DEFAULT_REVISION_CONFIG };
    }

    function loadPlanStatus() {
        planStatus = normalizePlanStatus(readJSON(PLAN_STORAGE_KEY)) || { ...DEFAULT_PLAN_STATUS };
    }

    function savePlanStatus() {
        writeJSON(PLAN_STORAGE_KEY, planStatus);
        renderPlanBadge();
    }

    // Erro com mensagem segura para exibir ao usuário
    class ImportError extends Error { }

    // Normaliza + valida cada item. Devolve os válidos e as posições (1-based) dos rejeitados.
    function sanitizeRecordList(list) {
        const clean = [];
        const rejected = [];
        list.forEach((item, i) => {
            let rec = null;
            try { rec = FuelCore.sanitizeRecord(normalizeImportedRecord(item)); } catch (e) { rec = null; }
            if (rec) clean.push(rec); else rejected.push(i + 1);
        });
        return { clean, rejected };
    }

    function describeRejected(rejected) {
        if (!rejected.length) return '';
        const shown = rejected.slice(0, 10).join(', ');
        return `${rejected.length} registro(s) inválido(s) serão ignorados (posição no arquivo: ${shown}${rejected.length > 10 ? '…' : ''}).`;
    }

    function parseBackupText(text) {
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new ImportError('O arquivo selecionado não é um JSON válido.');
        }
    }

    function hasValidId(v) {
        return !!v && typeof v === 'object' && v.id !== undefined && v.id !== null && v.id !== '';
    }

    // Baixa um arquivo de texto via Blob (data: URI falha em backups grandes)
    function downloadBlob(fileName, text) {
        const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // Converte formatos (atual e legados) para o formato interno. NÃO é o portão de validação:
    // o resultado sempre passa por FuelCore.sanitizeRecord (que rejeita registros corrompidos).
    function normalizeImportedRecord(item) {
        if (!item || typeof item !== 'object') return null;

        const date = String(item.date !== undefined && item.date !== null ? item.date
            : (item.data !== undefined && item.data !== null ? item.data : ''));

        let odo = item.odo !== undefined ? item.odo : item.odometro;
        if (typeof odo === 'string' && /^\s*\d+([.,]\d+)?\s*$/.test(odo)) odo = Number(odo.replace(',', '.'));
        if (typeof odo === 'number' && Number.isFinite(odo)) odo = Math.trunc(odo); // negativos NÃO são "corrigidos": serão rejeitados

        const rawFull = item.fullTank !== undefined ? item.fullTank
            : (item.full !== undefined ? item.full : item.tanqueCheio);
        const fullTank = rawFull === undefined ? true : FuelCore.toBool(rawFull); // "false" (string) agora é false

        if (item.valorA !== undefined || item.valorG !== undefined) {
            return {
                date,
                odo,
                precoA: parseDecimalValue(item.precoA),
                valorA: parseDecimalValue(item.valorA),
                precoG: parseDecimalValue(item.precoG),
                valorG: parseDecimalValue(item.valorG),
                fullTank
            };
        }

        const litersA = parseDecimalValue(item.litersA || item.litrosA || item.litrosEtanol);
        const litersG = parseDecimalValue(item.litersG || item.litrosG || item.litrosGasolina);
        let precoA = parseDecimalValue(item.priceA || item.precoA || item.precoEtanol);
        let precoG = parseDecimalValue(item.priceG || item.precoG || item.precoGasolina);
        const totL = parseDecimalValue(item.totL || item.totalLitros) || safeRound(litersA + litersG, 2);
        const totR = parseDecimalValue(item.totR || item.totalReais || item.gastoTotal);

        let comb = item.comb || item.tipoCombustivel;
        if (!comb) {
            if (litersA > 0 && litersG > 0) comb = 'M';
            else if (litersA > 0) comb = 'A';
            else comb = 'G';
        }

        let valorA = litersA > 0 ? safeRound(litersA * precoA, 2) : 0;
        let valorG = litersG > 0 ? safeRound(litersG * precoG, 2) : 0;

        if (valorA === 0 && valorG === 0 && totR > 0) {
            if (comb === 'G') {
                valorG = totR;
                if (precoG <= 0 && totL > 0) precoG = safeRound(totR / totL, 2);
            } else {
                valorA = totR;
                if (precoA <= 0 && totL > 0) precoA = safeRound(totR / totL, 2);
            }
        }

        return {
            date,
            odo,
            precoA: parseDecimalValue(precoA),
            valorA: parseDecimalValue(valorA),
            precoG: parseDecimalValue(precoG),
            valorG: parseDecimalValue(valorG),
            fullTank
        };
    }

    // --- 3. MIGRAÇÃO E CHECKOUT PRO ---
    function isProPlan() {
        return FuelBilling.isPro(); // modo dev: flag de teste | modo production: compra verificada no Google Play
    }

    const LITE_LOCK_MESSAGE = 'Recurso exclusivo do plano PRO! Atualize para desbloquear lançamentos ilimitados e configurações personalizadas.';

    function blockLiteFeature(message = LITE_LOCK_MESSAGE) {
        showToast(message, 'fa-crown', 'text-amber-500');
        openUpgradeModal();
    }

    function renderPlanBadge() {
        const badge = document.getElementById('appBadge');
        const upgradeBtn = document.getElementById('btnUpgradePro');
        const analyticsTab = document.getElementById('tabAnalytics');
        const pro = isProPlan();

        if (badge) {
            badge.innerText = pro ? 'PRO' : 'LITE';
            badge.className = pro
                ? 'text-xs px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold'
                : 'text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500 font-bold';
        }

        if (upgradeBtn) upgradeBtn.classList.toggle('hidden', pro);
    }

    function openUpgradeModal() {
        showModal('upgradeModal');
        refreshUpgradeModalState();
    }

    // Preço real (Play Console) e disponibilidade da compra
    function refreshUpgradeModalState() {
        const priceEl = document.getElementById('upgradePriceText');
        const btn = document.getElementById('btnConfirmUpgrade');
        const note = document.getElementById('upgradeNote');
        FuelBilling.getPriceText().then(text => { if (priceEl) priceEl.textContent = text; });
        FuelBilling.getAvailability().then(a => {
            if (btn) btn.disabled = !a.ok;
            if (note) {
                note.textContent = a.ok ? '' : (a.reason === 'unsupported'
                    ? 'A compra do PRO está disponível no aplicativo instalado pela Google Play.'
                    : 'A compra do PRO ainda não está disponível nesta versão.');
                note.classList.toggle('hidden', a.ok);
            }
        });
    }

    function closeUpgradeModal() {
        hideModal('upgradeModal');
    }

    // Alternar plano para testes: SÓ existe no modo 'dev' (interruptor em billing.js)
    if (FuelBilling.isDev()) {
        window.toggleDevPlan = function () {
            const next = !isProPlan();
            FuelBilling.devSetPro(next);
            alert(next ? 'Modo de Teste: Alterado para PRO' : 'Modo de Teste: Alterado para LITE');
            location.reload();
        };
    }

    
    async function processProUpgrade() {
        const btn = document.getElementById('btnConfirmUpgrade');
        if (btn) btn.disabled = true;
        showToast('Processando pagamento...', 'fa-spinner', 'text-sky-500');

        let result;
        try {
            result = await FuelBilling.purchase();
        } catch (e) {
            result = { status: 'error' };
        }
        if (btn) btn.disabled = false;

        switch (result.status) {
            case 'purchased':
                closeUpgradeModal();
                showToast('Parabéns! Você agora é PRO!', 'fa-circle-check', 'text-emerald-500');
                break;
            case 'cancelled':
                showToast('Compra cancelada.', 'fa-circle-info', 'text-stone-500');
                break;
            case 'unsupported':
                showToast('A compra do PRO está disponível no aplicativo instalado pela Google Play.', 'fa-triangle-exclamation', 'text-amber-500');
                break;
            case 'no-backend':
                showToast('A compra do PRO ainda não está disponível nesta versão.', 'fa-triangle-exclamation', 'text-amber-500');
                break;
            case 'unverified':
                showToast('Pagamento recebido, mas ainda não foi possível confirmar. Abra o app com internet em até 3 dias; sem confirmação, o Google reembolsa automaticamente.', 'fa-triangle-exclamation', 'text-amber-500');
                break;
            case 'rejected':
                showToast('Não foi possível validar a compra. Tente novamente.', 'fa-triangle-exclamation', 'text-rose-500');
                break;
            default:
                showToast('Não foi possível concluir a compra.', 'fa-triangle-exclamation', 'text-rose-500');
        }
    }

    // Chamado quando o plano muda (compra, restauração, reembolso ou alternância no modo dev)
    function onPlanChanged(pro) {
        planStatus.isPro = pro;
        planStatus.expiresAt = null;
        savePlanStatus();            // também atualiza o selo LITE/PRO
        recalculateMetricsAndRender(); // redesenha tudo que depende do plano
    }

    // --- 4. MANIPULAÇÃO E RENDERING DA INTERFACE ---
    function maskDecimalTwoDigits(input) {
        let digits = input.value.replace(/\D/g, '');
        if (!digits) {
            input.value = '';
            return;
        }
        let numericVal = (parseInt(digits, 10) / 100).toFixed(2);
        input.value = numericVal.replace('.', ',');
    }

    function initTheme() {
        const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
        applyTheme(savedTheme);
    }

    function toggleTheme() {
        const isDark = document.documentElement.classList.contains('dark');
        const newTheme = isDark ? 'light' : 'dark';
        applyTheme(newTheme);
        localStorage.setItem(THEME_STORAGE_KEY, newTheme);
        showToast(`Modo ${newTheme === 'dark' ? 'Escuro' : 'Claro'} ativado!`, 'fa-palette', 'text-sky-500');
        
        if (!document.getElementById('viewAnalytics').classList.contains('hidden')) {
            renderCharts();
        }
    }

    function applyTheme(theme) {
        const html = document.documentElement;
        const icon = document.getElementById('themeMenuIcon');
        const label = document.getElementById('themeMenuLabel');

        if (theme === 'light') {
            html.classList.remove('dark');
            if (icon) icon.className = 'fa-solid fa-moon w-4';
            if (label) label.innerText = 'Claro';
        } else {
            html.classList.add('dark');
            if (icon) icon.className = 'fa-solid fa-sun w-4';
            if (label) label.innerText = 'Escuro';
        }
    }

    function initOfflineNetworkMonitoring() {
        const updateOnlineStatus = () => {
            const indicator = document.getElementById('offlineIndicator');
            if (indicator) {
                if (navigator.onLine) {
                    indicator.classList.add('hidden');
                } else {
                    indicator.classList.remove('hidden');
                    showToast('Modo offline ativado!', 'fa-wifi-slash', 'text-amber-500');
                }
            }
        };

        window.addEventListener('online', updateOnlineStatus);
        window.addEventListener('offline', updateOnlineStatus);
        updateOnlineStatus();
    }

    function installPWA() {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                showToast('Instalando o Fuel Tracker...', 'fa-download', 'text-emerald-500');
            }
            deferredPrompt = null;
            const installBtn = document.getElementById('pwaInstallBtn');
            if (installBtn) installBtn.classList.add('hidden');
        });
    }

    async function shareAppWithFriend() {
        const shareData = {
            title: 'Fuel Tracker - Controle de Combustível',
            text: 'Dá uma olhada no Fuel Tracker! O app ideal para controlar abastecimentos, médias de consumo (Etanol vs Gasolina) e manutenção do carro:',
            url: window.location.href
        };

        if (navigator.share && navigator.canShare && navigator.canShare(shareData)) {
            try {
                await navigator.share(shareData);
                showToast('Obrigado por indicar!', 'fa-heart', 'text-rose-500');
            } catch (err) {
                if (err.name !== 'AbortError') console.error(err);
            }
        } else {
            try {
                await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`);
                showToast('Link de indicação copiado!', 'fa-copy', 'text-teal-500');
            } catch (e) {
                alert(`Compartilhe o app enviando o link:\n${window.location.href}`);
            }
        }
    }

    function toggleSettingsMenu() {
        const dropdown = document.getElementById('settingsDropdown');
        const gearBtn = document.getElementById('btnSettingsMenu');
        if (dropdown) {
            const isHidden = dropdown.classList.contains('hidden');
            dropdown.classList.toggle('hidden');
            if (gearBtn) {
                gearBtn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
            }
        }
    }

    function openManualModal() {
        showModal('manualModal');
    }

    function closeManualModal() {
        hideModal('manualModal');
    }

    // --- Modais acessíveis: foco no diálogo, Esc fecha, Tab preso dentro e foco devolvido ao fechar ---
    const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const modalReturnFocus = {};

    function isModalOpen(modal) {
        return !!modal && modal.classList.contains('opacity-100');
    }

    function showModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;
        if (!isModalOpen(modal)) modalReturnFocus[id] = document.activeElement;
        modal.inert = false; // diálogos fechados ficam "inert": não recebem foco nem leitor de tela
        modal.classList.remove('opacity-0', 'pointer-events-none');
        modal.classList.add('opacity-100');
        // Foca o próprio diálogo (leitores de tela anunciam o título) sem abrir o teclado virtual no celular
        modal.setAttribute('tabindex', '-1');
        if (typeof modal.focus === 'function') modal.focus({ preventScroll: true });
    }

    function hideModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;
        modal.classList.remove('opacity-100');
        modal.classList.add('opacity-0', 'pointer-events-none');
        modal.inert = true;
        const back = modalReturnFocus[id];
        delete modalReturnFocus[id];
        if (back && typeof back.focus === 'function' && back.isConnected !== false) back.focus();
    }

    function getOpenDialogs() {
        return Array.from(document.querySelectorAll('[role="dialog"]')).filter(isModalOpen);
    }

    function closeSettingsMenu() {
        const dropdown = document.getElementById('settingsDropdown');
        const gearBtn = document.getElementById('btnSettingsMenu');
        if (dropdown && !dropdown.classList.contains('hidden')) {
            dropdown.classList.add('hidden');
            if (gearBtn) gearBtn.setAttribute('aria-expanded', 'false');
        }
    }

    function handleGlobalKeydown(event) {
        if (event.key === 'Escape') {
            const open = getOpenDialogs();
            if (open.length) {
                hideModal(open[open.length - 1].id);
                event.preventDefault();
                return;
            }
            const dropdown = document.getElementById('settingsDropdown');
            if (dropdown && !dropdown.classList.contains('hidden')) {
                closeSettingsMenu();
                const gear = document.getElementById('btnSettingsMenu');
                if (gear && typeof gear.focus === 'function') gear.focus();
            }
            return;
        }
        if (event.key === 'Tab') {
            const open = getOpenDialogs();
            if (!open.length) return;
            const modal = open[open.length - 1];
            const items = Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR)).filter(el => el.getClientRects().length > 0);
            if (!items.length) { event.preventDefault(); return; }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || active === modal)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    // --- Erros de formulário inline (no lugar de alert() bloqueante) ---
    function showInlineError(errorId, message, fieldId) {
        const el = document.getElementById(errorId);
        if (el) {
            el.textContent = message;
            el.classList.remove('hidden');
        }
        if (fieldId) {
            const field = document.getElementById(fieldId);
            if (field) {
                field.setAttribute('aria-invalid', 'true');
                if (typeof field.focus === 'function') field.focus();
            }
        }
    }

    function clearInlineError(errorId) {
        const el = document.getElementById(errorId);
        if (!el) return;
        el.textContent = '';
        el.classList.add('hidden');
        const form = typeof el.closest === 'function' ? el.closest('form') : null;
        if (form) form.querySelectorAll('[aria-invalid="true"]').forEach(f => f.removeAttribute('aria-invalid'));
    }

    function showToast(message, iconClass = 'fa-circle-check', iconColor = 'text-emerald-500') {
        const toast = document.getElementById('toast');
        const toastMsg = document.getElementById('toastMsg');
        const toastIcon = document.getElementById('toastIcon');

        if (!toast || !toastMsg || !toastIcon) return;

        toastMsg.innerText = message;
        toastIcon.className = `fa-solid ${iconClass} ${iconColor} text-base`;

        toast.classList.remove('opacity-0', 'translate-y-10', 'pointer-events-none');
        toast.classList.add('opacity-100', 'translate-y-0');

        setTimeout(() => {
            toast.classList.remove('opacity-100', 'translate-y-0');
            toast.classList.add('opacity-0', 'translate-y-10', 'pointer-events-none');
        }, 3000);
    }

    function switchTab(tab) {
        if (tab === 'analytics' && !isProPlan()) {
            showToast('Relatórios avançados e gráficos comparativos são exclusivos do plano PRO.', 'fa-crown', 'text-amber-500');
            openUpgradeModal();
            return;
        }

        const tabs = ['dashboard', 'history', 'analytics', 'revision'];
        tabs.forEach(t => {
            const view = document.getElementById(`view${t.charAt(0).toUpperCase() + t.slice(1)}`);
            const btn = document.getElementById(`tab${t.charAt(0).toUpperCase() + t.slice(1)}`);
            if (view && btn) {
                if (t === tab) {
                    view.classList.remove('hidden');
                    btn.className = "py-2 rounded-lg bg-emerald-500 text-slate-950 font-bold shadow transition flex items-center justify-center gap-1 focus:outline-none focus:ring-2 focus:ring-emerald-600";
                    btn.setAttribute('aria-selected', 'true');
                } else {
                    view.classList.add('hidden');
                    btn.className = "py-2 rounded-lg text-stone-600 dark:text-slate-300 hover:text-stone-900 dark:hover:text-white font-semibold transition flex items-center justify-center gap-1 focus:outline-none focus:ring-2 focus:ring-emerald-500";
                    btn.setAttribute('aria-selected', 'false');
                }
            }
        });

        if (tab === 'analytics') {
            renderCharts();
        }
    }

    function handleFormSubmit(e) {
        e.preventDefault();
        clearInlineError('formError');

        const editIndex = parseInt(document.getElementById('editIndex').value, 10);

        // Limite do plano Lite (Máximo de 10 abastecimentos cadastrados)
        if (!isProPlan() && records.length >= LITE_RECORD_LIMIT && (isNaN(editIndex) || editIndex < 0)) {
            blockLiteFeature('A versão Lite é limitada a 10 lançamentos de abastecimento. Atualize para o PRO e registre sem limites!');
            return;
        }

        const date = document.getElementById('inputData').value;
        const odo = parseInt(document.getElementById('inputOdometro').value, 10);
        const precoA = parseDecimalValue(document.getElementById('inputPrecoA').value);
        const valorA = parseDecimalValue(document.getElementById('inputValorA').value);
        const precoG = parseDecimalValue(document.getElementById('inputPrecoG').value);
        const valorG = parseDecimalValue(document.getElementById('inputValorG').value);
        const fullTank = document.getElementById('inputTanqueCheio').checked;

        if (!date || isNaN(odo)) {
            showInlineError('formError', 'Preencha a data e o odômetro.', !date ? 'inputData' : 'inputOdometro');
            return;
        }

        if (date > FuelCore.todayLocalISO()) {
            showInlineError('formError', 'A data do abastecimento não pode ser futura.', 'inputData');
            return;
        }

        // Mesmo limite usado ao carregar/importar: um valor maior seria descartado na próxima abertura do app
        if (odo < 0 || odo > FuelCore.MAX_ODOMETER) {
            showInlineError('formError', `O odômetro deve estar entre 0 e ${FuelCore.MAX_ODOMETER.toLocaleString('pt-BR')} km.`, 'inputOdometro');
            return;
        }

        if (valorA <= 0 && valorG <= 0) {
            showInlineError('formError', 'Informe ao menos um valor gasto (Etanol ou Gasolina).', 'inputValorA');
            return;
        }

        const odoError = validateOdometer(odo, date, editIndex);
        if (odoError) {
            showInlineError('formError', odoError, 'inputOdometro');
            return;
        }

        const newRecord = {
            date,
            odo,
            precoA,
            valorA,
            precoG,
            valorG,
            fullTank
        };

        const isEdit = editIndex >= 0 && editIndex < records.length;
        const snapshot = records.slice();
        if (isEdit) {
            records[editIndex] = newRecord;
        } else {
            records.push(newRecord);
        }

        if (!saveRecords()) {
            records = snapshot; // desfaz em memória: nada de "sucesso" falso (o erro já foi exibido)
            return;
        }

        if (isEdit) {
            showToast('Registro atualizado com sucesso!', 'fa-pen-to-square', 'text-sky-500');
        } else {
            showToast('Abastecimento cadastrado!', 'fa-circle-check', 'text-emerald-500');
        }
        resetForm();
        recalculateMetricsAndRender();
    }

    function editRecord(index) {
        if (index < 0 || index >= records.length) return;

        const rec = records[index];
        document.getElementById('editIndex').value = index;
        document.getElementById('inputData').value = rec.date;
        document.getElementById('inputOdometro').value = rec.odo;
        document.getElementById('inputPrecoA').value = formatDecimalTwoDigits(rec.precoA);
        document.getElementById('inputValorA').value = formatDecimalTwoDigits(rec.valorA);
        document.getElementById('inputPrecoG').value = formatDecimalTwoDigits(rec.precoG);
        document.getElementById('inputValorG').value = formatDecimalTwoDigits(rec.valorG);
        document.getElementById('inputTanqueCheio').checked = rec.fullTank !== false;

        document.getElementById('formTitle').innerText = 'Editar Registro';
        document.getElementById('formIcon').className = 'fa-solid fa-pen-to-square text-sky-500';
        document.getElementById('cancelEditBtn').classList.remove('hidden');

        switchTab('dashboard');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function deleteRecord(index) {
        if (!Number.isInteger(index) || index < 0 || index >= records.length) return;
        if (confirm('Tem certeza que deseja excluir este registro?')) {
            const removed = records.splice(index, 1);
            if (!saveRecords()) {
                records.splice(index, 0, ...removed); // desfaz em memória
                return;
            }
            recalculateMetricsAndRender();
            showToast('Registro excluído.', 'fa-trash', 'text-rose-500');
        }
    }

    function resetForm() {
        document.getElementById('fuelForm').reset();
        document.getElementById('editIndex').value = -1;
        document.getElementById('inputData').value = FuelCore.todayLocalISO();
        document.getElementById('inputData').max = FuelCore.todayLocalISO();
        clearInlineError('formError');
        updateOdometerPlaceholder();
        document.getElementById('formTitle').innerText = 'Novo Abastecimento';
        document.getElementById('formIcon').className = 'fa-solid fa-circle-plus text-emerald-500';
        document.getElementById('cancelEditBtn').classList.add('hidden');
    }

    function updateOdometerPlaceholder() {
        const odoInput = document.getElementById('inputOdometro');
        if (!odoInput) return;
        const lastOdo = records.length ? Math.max(...records.map(r => Number(r.odo))) : null;
        odoInput.placeholder = lastOdo !== null && !isNaN(lastOdo)
            ? `Último: ${lastOdo.toLocaleString('pt-BR')}`
            : 'Ex: 10000';
    }

    function renderVehicleSelector() {
        const select = document.getElementById('vehicleSelect');
        if (!select) return;
        select.innerHTML = vehicles.map(v =>
            `<option value="${escapeHtml(v.id)}"${v.id === activeVehicleId ? ' selected' : ''}>${escapeHtml(v.name)}${v.plate ? ' • ' + escapeHtml(v.plate) : ''}</option>`
        ).join('');
    }

    function renderVehicleList() {
        const container = document.getElementById('vehicleListContainer');
        if (!container) return;
        if (!vehicles.length) {
            container.innerHTML = '<p class="text-xs text-stone-500 dark:text-slate-400 text-center py-2">Nenhum veículo cadastrado.</p>';
            return;
        }
        container.innerHTML = vehicles.map(v => {
            const isActive = v.id === activeVehicleId;
            return `
            <div class="flex items-center justify-between gap-2 p-2.5 rounded-xl border ${isActive ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-stone-300 dark:border-slate-700 bg-white dark:bg-slate-900'}">
                <div class="min-w-0">
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="font-bold text-stone-900 dark:text-white truncate">${escapeHtml(v.name)}</span>
                        ${isActive ? '<span class="text-[9px] uppercase font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-500/20 px-1.5 py-0.5 rounded">Ativo</span>' : ''}
                    </div>
                    <span class="text-[10px] text-stone-500 dark:text-slate-400">${v.plate ? escapeHtml(v.plate) : 'Sem placa'}</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" data-action="edit-vehicle" data-id="${escapeHtml(v.id)}" aria-label="Editar veículo" class="w-7 h-7 rounded-lg bg-stone-200 dark:bg-slate-800 text-sky-600 dark:text-sky-400 hover:bg-stone-300 dark:hover:bg-slate-700 transition flex items-center justify-center focus:outline-none focus:ring-1 focus:ring-sky-500">
                        <i class="fa-solid fa-pen text-[10px]" aria-hidden="true"></i>
                    </button>
                    <button type="button" data-action="delete-vehicle" data-id="${escapeHtml(v.id)}" aria-label="Excluir veículo" class="w-7 h-7 rounded-lg bg-stone-200 dark:bg-slate-800 text-rose-600 dark:text-rose-400 hover:bg-stone-300 dark:hover:bg-slate-700 transition flex items-center justify-center focus:outline-none focus:ring-1 focus:ring-rose-500">
                        <i class="fa-solid fa-trash-can text-[10px]" aria-hidden="true"></i>
                    </button>
                </div>
            </div>`;
        }).join('');
    }

    function switchVehicle(id) {
        if (!id || id === activeVehicleId || !vehicles.some(v => v.id === id)) return;
        activeVehicleId = id;
        saveActiveVehicle();
        loadRecords();
        loadTireConfig();
        loadRevisionConfig();
        resetForm();
        recalculateMetricsAndRender();
        showToast(`Veículo selecionado: ${getActiveVehicle().name}`, 'fa-car', 'text-emerald-500');
    }

    function openVehicleModal() {
        if (!isProPlan()) {
            blockLiteFeature('A gestão de frota e múltiplos veículos é exclusiva do plano PRO. Assine para cadastrar mais veículos!');
            return;
        }
        document.getElementById('vehicleForm').reset();
        clearInlineError('vehicleFormError');
        renderVehicleList();
        showModal('vehicleModal');
    }

    function closeVehicleModal() {
        hideModal('vehicleModal');
    }

    function editVehicle(id) {
        const vehicle = vehicles.find(v => v.id === id);
        if (!vehicle) return;
        document.getElementById('vehicleNameInput').value = vehicle.name;
        document.getElementById('vehiclePlateInput').value = vehicle.plate || '';
        document.getElementById('vehicleEditId').value = vehicle.id;
    }

    function deleteVehicle(id) {
        if (vehicles.length <= 1) {
            showToast('Não é possível excluir o único veículo', 'fa-triangle-exclamation', 'text-amber-500');
            return;
        }
        const vehicle = vehicles.find(v => v.id === id);
        if (!vehicle) return;
        if (!confirm(`Excluir o veículo "${vehicle.name}"? Os abastecimentos e configurações vinculados a ele serão excluídos permanentemente.`)) return;

        const wasActive = id === activeVehicleId;
        const previousVehicles = vehicles;
        vehicles = vehicles.filter(v => v.id !== id);
        if (!saveVehicles()) {
            vehicles = previousVehicles;
            return;
        }
        // Remove os dados do veículo excluído (evita chaves órfãs ocupando a cota do localStorage)
        VEHICLE_SCOPED_KEYS.forEach(k => {
            try { localStorage.removeItem(getVehicleScopedKey(k, id)); } catch (err) { }
        });

        if (wasActive) {
            activeVehicleId = vehicles[0].id;
            saveActiveVehicle();
            loadRecords();
            loadTireConfig();
            loadRevisionConfig();
            resetForm();
        }

        renderVehicleSelector();
        renderVehicleList();
        recalculateMetricsAndRender();
        showToast(`Veículo "${vehicle.name}" excluído.`, 'fa-trash-can', 'text-rose-500');
    }

    function saveVehicle(e) {
        e.preventDefault();
        if (!isProPlan()) {
            blockLiteFeature('A gestão de frota e múltiplos veículos é exclusiva do plano PRO. Assine para cadastrar mais veículos!');
            return;
        }
        const name = document.getElementById('vehicleNameInput').value.trim();
        const plate = normalizePlate(document.getElementById('vehiclePlateInput').value.trim().toUpperCase());
        const editId = document.getElementById('vehicleEditId').value;

        clearInlineError('vehicleFormError');
        if (!name) {
            showInlineError('vehicleFormError', 'Informe o nome/modelo do veículo.', 'vehicleNameInput');
            return;
        }
        if (!isValidPlate(plate)) {
            showInlineError('vehicleFormError', 'Placa inválida. Use o formato XXX-XXXX (ex: ABC-1234).', 'vehiclePlateInput');
            return;
        }

        const snapshot = vehicles.slice();
        const existingIndex = editId ? vehicles.findIndex(v => v.id === editId) : -1;
        const isUpdate = existingIndex >= 0;
        if (isUpdate) {
            vehicles[existingIndex] = { ...vehicles[existingIndex], name, plate };
        } else {
            vehicles.push({ id: 'v_' + Date.now().toString(36), name, plate });
        }

        if (!saveVehicles()) {
            vehicles = snapshot; // desfaz em memória
            return;
        }
        if (isUpdate) {
            showToast(`Veículo "${name}" atualizado!`, 'fa-pen', 'text-sky-500');
        } else {
            showToast(`Veículo "${name}" cadastrado!`, 'fa-car', 'text-emerald-500');
        }
        renderVehicleSelector();
        renderVehicleList();
        recalculateMetricsAndRender();

        document.getElementById('vehicleEditId').value = '';
        document.getElementById('vehicleForm').reset();
        closeVehicleModal();
    }

    function handleResetDatabase() {
        if (confirm('ATENÇÃO: Todos os dados do Fuel Tracker serão apagados permanentemente — veículos, abastecimentos, históricos e configurações!\n\nDeseja continuar?')) {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.indexOf('fuel_tracker') === 0 || key === PRO_FLAG_KEY)) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(k => localStorage.removeItem(k));
            showToast('Aplicativo zerado. Recarregando...', 'fa-trash-arrow-up', 'text-red-500');
            setTimeout(() => { window.location.reload(); }, 800);
        }
    }

    function handleExportJSON() {
        closeSettingsMenu();
        const backupData = {
            records,
            tireConfig,
            cnhConfig,
            revisionConfig,
            planStatus,
            vehicles,
            activeVehicleId
        };
        const today = FuelCore.todayLocalISO();
        const fileName = isProPlan()
            ? `fuel_tracker_backup_placa ${getActiveVehicle().plate || 'SEM-PLACA'}_${today}.json`
            : `fuel_tracker_backup_${today}.json`;
        downloadBlob(fileName, JSON.stringify(backupData, null, 2));
        showToast('Backup gerado com sucesso!', 'fa-download', 'text-purple-500');
        closeBackupModal();
        switchTab('dashboard');
    }

    // Fase 1 (SEM efeitos colaterais): lê, valida e monta o plano de importação do veículo ativo.
    // Fase 1 (SEM efeitos colaterais): lê e valida o arquivo. O DESTINO é escolhido pelo usuário depois.
    function buildActiveImportPlan(text) {
        const imported = parseBackupText(text);
        const plan = { clean: [], rejected: [], tire: null, revision: null, cnh: null, source: null };
        let rawRecords;

        if (Array.isArray(imported)) {
            rawRecords = imported;
        } else if (imported && typeof imported === 'object') {
            if (!Array.isArray(imported.records)) {
                throw new ImportError('O arquivo não contém a lista "records" de abastecimentos.');
            }
            rawRecords = imported.records;
            plan.tire = normalizeTireConfig(imported.tireConfig);
            plan.revision = normalizeRevisionConfig(imported.revisionConfig);
            plan.cnh = normalizeCnhConfig(imported.cnhConfig);

            // Veículo de origem: o que estava ativo quando o backup foi exportado
            const wanted = imported.activeVehicleId !== undefined && imported.activeVehicleId !== null ? String(imported.activeVehicleId) : null;
            const src = wanted && Array.isArray(imported.vehicles)
                ? imported.vehicles.find(v => hasValidId(v) && String(v.id) === wanted) : null;
            if (src) {
                plan.source = {
                    id: String(src.id),
                    name: String(src.name || 'Veículo'),
                    plate: src.plate ? normalizePlate(String(src.plate).toUpperCase()) : ''
                };
            }
        } else {
            throw new ImportError('Formato JSON inválido: esperado um backup do Fuel Tracker.');
        }

        const { clean, rejected } = sanitizeRecordList(rawRecords);
        if (rawRecords.length && !clean.length) {
            throw new ImportError(`Nenhum registro válido foi encontrado no arquivo (${rawRecords.length} rejeitado(s)).`);
        }
        plan.clean = clean;
        plan.rejected = rejected;
        return plan;
    }

    // Fase 2: grava tudo "ou nada" (rollback automático em caso de falha, ex.: cota excedida)
    // --- Importação do veículo: o usuário escolhe o destino ---
    const NEW_VEHICLE_OPTION = '__new__';
    let pendingImport = null;

    const plural = n => `${n} registro${n === 1 ? '' : 's'}`;
    const vehicleLabel = v => (v.plate ? `${v.name} • ${v.plate}` : v.name);
    const countVehicleRecords = id => readJSON(getVehicleScopedKey(STORAGE_KEY, id), Array.isArray, []).length;

    // Nome/placa do novo veículo (vem do backup); evita duplicar um veículo idêntico
    function newVehicleDraft(plan) {
        let name = (plan.source && plan.source.name) || 'Veículo importado';
        const plate = (plan.source && plan.source.plate) || '';
        if (vehicles.some(v => v.name === name && (v.plate || '') === plate)) name += ' (importado)';
        return { id: 'v_' + Date.now().toString(36), name, plate };
    }

    function openImportChoice(plan) {
        pendingImport = plan;
        const pro = isProPlan();
        const targets = pro ? vehicles : vehicles.filter(v => v.id === activeVehicleId); // Lite: só o veículo ativo
        const draft = newVehicleDraft(plan);

        const options = [];
        if (pro) {
            options.push(`<option value="${NEW_VEHICLE_OPTION}">Criar novo veículo: ${escapeHtml(draft.name)}</option>`);
        } else {
            options.push('<option value="" disabled>Criar novo veículo (exclusivo PRO)</option>');
        }
        options.push('<optgroup label="Substituir os dados de:">' + targets.map(v =>
            `<option value="${escapeHtml(v.id)}">${escapeHtml(vehicleLabel(v))} (${plural(countVehicleRecords(v.id))})</option>`).join('') + '</optgroup>');

        const select = document.getElementById('importTargetSelect');
        select.innerHTML = options.join('');
        const sourceIsTarget = plan.source && targets.some(v => v.id === plan.source.id);
        select.value = sourceIsTarget ? plan.source.id : (pro ? NEW_VEHICLE_OPTION : activeVehicleId);

        const fromTxt = plan.source ? ` do veículo "${vehicleLabel(plan.source)}"` : '';
        document.getElementById('importSummary').textContent = `O arquivo contém ${plural(plan.clean.length)}${fromTxt}.`;
        const warnEl = document.getElementById('importWarn');
        const warn = describeRejected(plan.rejected);
        warnEl.textContent = warn;
        warnEl.classList.toggle('hidden', !warn);

        onImportTargetChange();
        showModal('importModal');
    }

    function onImportTargetChange() {
        if (!pendingImport) return;
        const select = document.getElementById('importTargetSelect');
        const note = document.getElementById('importTargetNote');
        const btn = document.getElementById('btnConfirmImport');
        const n = pendingImport.clean.length;
        if (btn) btn.disabled = !select.value;
        if (select.value === NEW_VEHICLE_OPTION) {
            note.textContent = `Será criado o veículo "${newVehicleDraft(pendingImport).name}" com ${plural(n)}. Seus veículos e dados atuais não serão alterados.`;
            note.className = 'text-xs font-semibold text-emerald-700 dark:text-emerald-400';
            return;
        }
        const v = vehicles.find(x => x.id === select.value);
        if (!v) { note.textContent = ''; return; }
        note.textContent = `Atenção: os ${plural(countVehicleRecords(v.id))} de "${vehicleLabel(v)}" serão SUBSTITUÍDOS pelos ${plural(n)} do arquivo. Não é possível desfazer.`;
        note.className = 'text-xs font-semibold text-rose-600 dark:text-rose-400';
    }

    function closeImportModal() {
        pendingImport = null;
        hideModal('importModal');
    }

    // Fase 2: grava tudo "ou nada" (rollback automático em caso de falha, ex.: cota excedida)
    function applyActiveImport(plan, targetId, newVehicleList, isNewVehicle) {
        const key = base => getVehicleScopedKey(base, targetId);
        const entries = [[key(STORAGE_KEY), JSON.stringify(plan.clean)], [key(REJECTED_STORAGE_KEY), null]];
        if (plan.tire) entries.push([key(TIRE_STORAGE_KEY), JSON.stringify(plan.tire)]);
        if (plan.revision) entries.push([key(REVISION_STORAGE_KEY), JSON.stringify(plan.revision)]);
        // A CNH é do motorista, não do veículo: ao criar um veículo novo, não sobrescreve a que já existe
        if (plan.cnh && (!isNewVehicle || !cnhConfig.expiryDate)) entries.push([CNH_STORAGE_KEY, JSON.stringify(plan.cnh)]);
        if (newVehicleList) entries.push([VEHICLES_STORAGE_KEY, JSON.stringify(newVehicleList)]);
        if (targetId !== activeVehicleId) entries.push([ACTIVE_VEHICLE_STORAGE_KEY, targetId]); // mostra o resultado
        return commitWrites(entries);
    }

    function confirmImport() {
        const plan = pendingImport;
        if (!plan) return;
        const select = document.getElementById('importTargetSelect');
        const target = select ? select.value : '';
        let ok = false;
        let targetName = '';

        if (target === NEW_VEHICLE_OPTION) {
            if (!isProPlan()) {
                showToast('Criar novos veículos é exclusivo do plano PRO.', 'fa-triangle-exclamation', 'text-amber-500');
                return;
            }
            const draft = newVehicleDraft(plan);
            ok = applyActiveImport(plan, draft.id, [...vehicles, { id: draft.id, name: draft.name, plate: draft.plate }], true);
            targetName = draft.name;
        } else {
            const v = vehicles.find(x => x.id === target);
            if (!v || (!isProPlan() && v.id !== activeVehicleId)) {
                showToast('Selecione um destino válido para a importação.', 'fa-triangle-exclamation', 'text-amber-500');
                return;
            }
            ok = applyActiveImport(plan, v.id, null, false);
            targetName = v.name;
        }
        if (!ok) return; // falhou: estado anterior preservado (rollback) e usuário já avisado

        closeImportModal();
        closeBackupModal();
        showToast(`Dados importados em "${targetName}"! Atualizando o aplicativo...`, 'fa-upload', 'text-blue-500');
        setTimeout(() => { window.location.reload(); }, 1200);
    }

    function importJSON(event) {
        const input = event.target;
        const file = input.files && input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onerror = function () {
            alert('Não foi possível ler o arquivo selecionado.');
            input.value = '';
        };
        reader.onload = function (e) {
            try {
                openImportChoice(buildActiveImportPlan(e.target.result)); // nada é gravado até o usuário escolher e confirmar
            } catch (err) {
                alert(err instanceof ImportError ? err.message : 'Erro inesperado ao processar o arquivo. Nenhum dado foi alterado.');
            } finally {
                input.value = ''; // permite escolher o mesmo arquivo novamente (inclusive após erro/cancelamento)
            }
        };
        reader.readAsText(file);
    }

    // --- BACKUP GERAL (FULL BACKUP) ---
    function getVehicleScopedKey(baseKey, vehicleId) {
        return vehicleId === DEFAULT_VEHICLE_ID ? baseKey : `${baseKey}_${vehicleId}`;
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function exportFullBackup() {
        try {
            const exportedVehicles = vehicles.map(v => {
                const id = String(v.id);
                let recs = [];
                try { recs = JSON.parse(localStorage.getItem(getVehicleScopedKey(STORAGE_KEY, id)) || '[]'); } catch (e) { }
                let tire = null;
                try { tire = JSON.parse(localStorage.getItem(getVehicleScopedKey(TIRE_STORAGE_KEY, id)) || 'null'); } catch (e) { }
                let rev = null;
                try { rev = JSON.parse(localStorage.getItem(getVehicleScopedKey(REVISION_STORAGE_KEY, id)) || 'null'); } catch (e) { }
                return {
                    id,
                    name: v.name,
                    plate: v.plate || '',
                    records: Array.isArray(recs) ? recs : [],
                    tireConfig: tire,
                    revisionConfig: rev
                };
            });

            const backupData = {
                app: 'FuelTracker',
                backupType: 'full',
                version: 1,
                createdAt: new Date().toISOString(),
                activeVehicleId: String(activeVehicleId),
                cnhConfig,
                planStatus,
                vehicles: exportedVehicles
            };

            const now = new Date();
            const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
            const fileName = `fuel_tracker_backup_${exportedVehicles.length}-Veiculos_${stamp}.json`;

            downloadBlob(fileName, JSON.stringify(backupData, null, 2));

            showToast(`Backup gerado com sucesso! ${exportedVehicles.length} veículo(s) incluído(s).`, 'fa-download', 'text-emerald-500');
            closeBackupModal();
            switchTab('dashboard');
        } catch (err) {
            showToast('Erro ao gerar o backup geral.', 'fa-triangle-exclamation', 'text-rose-500');
        }
    }

    function importFullBackup() {
        const input = document.getElementById('importFullFile');
        if (input) input.click();
    }

    // Validação ESTRUTURAL do arquivo. Cada registro é validado individualmente por sanitizeRecordList.
    function isValidFullBackup(data) {
        if (!data || typeof data !== 'object') return false;
        if (data.app !== 'FuelTracker' || data.backupType !== 'full') return false;
        if (!Array.isArray(data.vehicles) || !data.vehicles.length) return false;
        return data.vehicles.every(v => hasValidId(v) && Array.isArray(v.records));
    }

    // Fase 1 (SEM efeitos colaterais): valida tudo em memória e monta o plano de restauração
    function buildFullImportPlan(text) {
        const imported = parseBackupText(text);
        if (!isValidFullBackup(imported)) {
            throw new ImportError('Arquivo de backup geral inválido ou corrompido. Utilize um arquivo gerado pelo "Exportar Tudo" do Fuel Tracker.');
        }

        const seen = new Set();
        const cleanedVehicles = [];
        const perVehicle = [];
        let rawCount = 0;
        let rejectedCount = 0;

        imported.vehicles.forEach(v => {
            const id = String(v.id);
            if (seen.has(id)) return; // ids duplicados: vale o primeiro
            seen.add(id);
            const { clean, rejected } = sanitizeRecordList(v.records);
            rawCount += v.records.length;
            rejectedCount += rejected.length;
            cleanedVehicles.push({
                id,
                name: String(v.name || 'Veículo'),
                plate: v.plate ? normalizePlate(String(v.plate).toUpperCase()) : ''
            });
            perVehicle.push({
                id,
                records: clean,
                tire: normalizeTireConfig(v.tireConfig),
                revision: normalizeRevisionConfig(v.revisionConfig)
            });
        });

        if (!cleanedVehicles.length) throw new ImportError('O backup não contém veículos válidos.');
        if (rawCount && !perVehicle.some(p => p.records.length)) {
            throw new ImportError(`Nenhum registro válido foi encontrado no backup (${rawCount} rejeitado(s)).`);
        }

        const wanted = imported.activeVehicleId !== undefined && imported.activeVehicleId !== null ? String(imported.activeVehicleId) : null;
        return {
            cleanedVehicles,
            perVehicle,
            rejectedCount,
            activeId: wanted && seen.has(wanted) ? wanted : cleanedVehicles[0].id,
            cnh: normalizeCnhConfig(imported.cnhConfig),
            plan: normalizePlanStatus(imported.planStatus)
        };
    }

    // Fase 2: restauração = substituição total, gravada "tudo ou nada" (rollback em caso de falha)
    function applyFullImportPlan(plan) {
        const entries = [];
        const newIds = new Set(plan.perVehicle.map(p => p.id));

        // Dados de veículos atuais que não existem no backup são removidos (substituição total)
        vehicles.forEach(v => {
            if (!newIds.has(v.id)) {
                VEHICLE_SCOPED_KEYS.forEach(k => entries.push([getVehicleScopedKey(k, v.id), null]));
            }
        });
        plan.perVehicle.forEach(p => {
            entries.push([getVehicleScopedKey(STORAGE_KEY, p.id), JSON.stringify(p.records)]);
            entries.push([getVehicleScopedKey(TIRE_STORAGE_KEY, p.id), p.tire ? JSON.stringify(p.tire) : null]);
            entries.push([getVehicleScopedKey(REVISION_STORAGE_KEY, p.id), p.revision ? JSON.stringify(p.revision) : null]);
            entries.push([getVehicleScopedKey(REJECTED_STORAGE_KEY, p.id), null]);
        });
        entries.push([VEHICLES_STORAGE_KEY, JSON.stringify(plan.cleanedVehicles)]);
        entries.push([ACTIVE_VEHICLE_STORAGE_KEY, plan.activeId]);
        if (plan.cnh) entries.push([CNH_STORAGE_KEY, JSON.stringify(plan.cnh)]);
        if (plan.plan) entries.push([PLAN_STORAGE_KEY, JSON.stringify(plan.plan)]);
        return commitWrites(entries);
    }

    function handleFullImportFile(event) {
        const input = event.target;
        const file = input.files && input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onerror = function () {
            alert('Não foi possível ler o arquivo selecionado.');
            input.value = '';
        };
        reader.onload = function (e) {
            try {
                const plan = buildFullImportPlan(e.target.result);
                const warn = plan.rejectedCount
                    ? `\n\n${plan.rejectedCount} registro(s) inválido(s) serão ignorados.`
                    : '';
                const approved = confirm(
                    `A restauração do backup geral substituirá TODOS os veículos, históricos e configurações atuais (${plan.cleanedVehicles.length} veículo(s) no arquivo).` +
                    warn + '\n\nDeseja continuar?'
                );
                if (!approved) return;
                if (!applyFullImportPlan(plan)) return; // falhou: estado anterior preservado (rollback) e usuário já avisado

                closeBackupModal();
                showToast('Dados restaurados com sucesso! Atualizando o aplicativo...', 'fa-upload', 'text-blue-500');
                setTimeout(() => { window.location.reload(); }, 1200);
            } catch (err) {
                alert(err instanceof ImportError ? err.message : 'Erro inesperado ao processar o arquivo. Nenhum dado foi alterado.');
            } finally {
                input.value = ''; // permite escolher o mesmo arquivo novamente
            }
        };
        reader.readAsText(file);
    }

    function openBackupModal() {
        showModal('backupModal');
        switchBackupTab('active');
    }

    function closeBackupModal() {
        hideModal('backupModal');
    }

    function switchBackupTab(tab) {
        const paneActive = document.getElementById('backupPaneActive');
        const paneFull = document.getElementById('backupPaneFull');
        const btnActive = document.getElementById('backupTabActive');
        const btnFull = document.getElementById('backupTabFull');
        if (!paneActive || !paneFull || !btnActive || !btnFull) return;

        const activeClass = 'py-2 rounded-lg bg-emerald-500 text-slate-950 font-bold shadow transition focus:outline-none focus:ring-2 focus:ring-emerald-600';
        const idleClass = 'py-2 rounded-lg text-stone-600 dark:text-slate-300 font-semibold hover:text-stone-900 dark:hover:text-white transition focus:outline-none focus:ring-2 focus:ring-emerald-500';

        if (tab === 'full') {
            paneActive.classList.add('hidden');
            paneFull.classList.remove('hidden');
            btnActive.className = idleClass;
            btnFull.className = activeClass;
        } else {
            paneFull.classList.add('hidden');
            paneActive.classList.remove('hidden');
            btnFull.className = idleClass;
            btnActive.className = activeClass;
        }
    }

    function handleExportExcel() {
        closeSettingsMenu();
        if (!isProPlan()) {
            openUpgradeModal();
            return;
        }
        if (!records.length) {
            alert('Não há dados cadastrados para exportar.');
            return;
        }

        if (typeof XLSX === 'undefined') {
            alert('Não foi possível carregar a biblioteca de exportação para Excel. Feche e abra o aplicativo novamente; se o problema continuar, atualize ou reinstale o app.');
            return;
        }

        const exportData = records.map(r => ({
            'Data': formatDateBR(r.date),
            'Odômetro (km)': r.odo,
            'Preço Etanol (R$)': r.precoA || 0,
            'Valor Etanol (R$)': r.valorA || 0,
            'Preço Gasolina (R$)': r.precoG || 0,
            'Valor Gasolina (R$)': r.valorG || 0,
            'Tanque Cheio': r.fullTank ? 'Sim' : 'Não'
        }));

        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Abastecimentos");
        XLSX.writeFile(wb, `fuel_tracker_relatorio_${FuelCore.todayLocalISO()}.xlsx`);
        showToast('Relatório Excel baixado!', 'fa-file-excel', 'text-emerald-500');
    }

    function setAvgMode(mode) {
        currentAvgMode = mode;
        const btnAll = document.getElementById('avgModeAll');
        const btn5 = document.getElementById('avgMode5');

        if (mode === 'all') {
            btnAll.className = "flex-1 py-1 rounded-md bg-white dark:bg-slate-700 text-stone-900 dark:text-white font-semibold text-[11px] transition shadow-sm dark:shadow-none focus:outline-none focus:ring-1 focus:ring-emerald-500";
            btn5.className = "flex-1 py-1 rounded-md text-stone-500 dark:text-slate-400 font-semibold text-[11px] hover:text-stone-900 dark:hover:text-white transition focus:outline-none focus:ring-1 focus:ring-emerald-500";
        } else {
            btn5.className = "flex-1 py-1 rounded-md bg-white dark:bg-slate-700 text-stone-900 dark:text-white font-semibold text-[11px] transition shadow-sm dark:shadow-none focus:outline-none focus:ring-1 focus:ring-emerald-500";
            btnAll.className = "flex-1 py-1 rounded-md text-stone-500 dark:text-slate-400 font-semibold text-[11px] hover:text-stone-900 dark:hover:text-white transition focus:outline-none focus:ring-1 focus:ring-emerald-500";
        }
        recalculateMetricsAndRender();
    }

    function setKmlFilterCriterion(crit) {
        currentKmlCriterion = crit;
        const btnTank = document.getElementById('filterTankOnly');
        const btnRange = document.getElementById('filterRangeOnly');
        const btnBoth = document.getElementById('filterBoth');

        [btnTank, btnRange, btnBoth].forEach(b => {
            if (b) b.className = "py-1 rounded-lg text-stone-500 dark:text-slate-400 font-semibold transition focus:outline-none focus:ring-1 focus:ring-emerald-500";
        });

        if (crit === 'tank' && btnTank) btnTank.className = "py-1 rounded-lg bg-emerald-500 text-slate-950 font-bold transition shadow focus:outline-none focus:ring-1 focus:ring-emerald-500";
        if (crit === 'range' && btnRange) btnRange.className = "py-1 rounded-lg bg-emerald-500 text-slate-950 font-bold transition shadow focus:outline-none focus:ring-1 focus:ring-emerald-500";
        if (crit === 'both' && btnBoth) btnBoth.className = "py-1 rounded-lg bg-emerald-500 text-slate-950 font-bold transition shadow focus:outline-none focus:ring-1 focus:ring-emerald-500";

        recalculateMetricsAndRender();
    }

    function setHistoryFilter(type) {
        currentHistoryFilter = type;
        const btnALL = document.getElementById('filterBtnALL');
        const btnA = document.getElementById('filterBtnA');
        const btnG = document.getElementById('filterBtnG');
        const btnM = document.getElementById('filterBtnM');

        [btnALL, btnA, btnG, btnM].forEach(b => {
            if (b) b.className = "px-3 py-1.5 rounded-xl bg-stone-200 dark:bg-slate-800 text-stone-700 dark:text-slate-300 hover:bg-stone-300 dark:hover:bg-slate-700 font-medium transition whitespace-nowrap focus:outline-none focus:ring-1 focus:ring-emerald-500";
        });

        const activeBtn = document.getElementById(`filterBtn${type}`);
        if (activeBtn) {
            activeBtn.className = "px-3 py-1.5 rounded-xl bg-emerald-500 text-slate-950 font-bold shadow transition whitespace-nowrap focus:outline-none focus:ring-1 focus:ring-emerald-600";
        }

        renderHistoryList();
    }

    // Segmentos entre tanques cheios consecutivos (ver core.js). A "faixa" 5-23 só descarta outliers.
    function getConsumptionSegments(applyRange = true) {
        const segs = FuelCore.computeConsumptionSegments(records);
        return applyRange ? segs.filter(s => s.kml >= KML_MIN && s.kml <= KML_MAX) : segs;
    }

    // Texto "X,XX km/L" de cada trecho, indexado pelo registro que ABRE o trecho (tanque cheio)
    function getKmlTextByRecord() {
        const map = new Map();
        FuelCore.computeConsumptionSegments(records).forEach(s => {
            map.set(s.start, `${formatDecimalTwoDigits(s.kml)} km/L`);
        });
        return map;
    }

    function getFullTankKmlsByFuel() {
        const segs = getConsumptionSegments(true);
        return {
            segsA: segs.filter(s => s.fuel === 'A'),
            segsG: segs.filter(s => s.fuel === 'G')
        };
    }

    function getFatorRendimentoDinamico() {
        const { segsA, segsG } = getFullTankKmlsByFuel();

        if (!segsA.length || !segsG.length) {
            return 0.70;
        }

        const avgKmlA = FuelCore.weightedKml(segsA);
        const avgKmlG = FuelCore.weightedKml(segsG);

        return avgKmlG > 0 ? safeRound(avgKmlA / avgKmlG, 4) : 0.70;
    }

    function generateInsightText() {
        const insightEl = document.getElementById('insightText');
        if (!insightEl) return;

        if (records.filter(r => r.fullTank).length < 3) {
            insightEl.innerText = "Cadastre pelo menos 3 abastecimentos com tanque cheio para receber análises e sugestões personalizadas de economia.";
            return;
        }

        const { segsA, segsG } = getFullTankKmlsByFuel();

        if (segsA.length && segsG.length) {
            const avgA = FuelCore.weightedKml(segsA);
            const avgG = FuelCore.weightedKml(segsG);
            const ratio = ((avgA / avgG) * 100).toFixed(1);
            insightEl.innerText = `O seu motor entrega ${avgA.toFixed(2)} km/L no Etanol e ${avgG.toFixed(2)} km/L na Gasolina. O seu rendimento com Etanol equivale a ${ratio}% da Gasolina. Abasteça com Etanol sempre que o preço por litro for menor que ${ratio}% do valor da gasolina!`;
        } else if (segsA.length) {
            const avgA = FuelCore.weightedKml(segsA);
            insightEl.innerText = `Sua média com Etanol é de ${avgA.toFixed(2)} km/L. Experimente abastecer com Gasolina com tanque cheio para liberar a comparação automatizada entre os dois combustíveis!`;
        } else if (segsG.length) {
            const avgG = FuelCore.weightedKml(segsG);
            insightEl.innerText = `Sua média com Gasolina é de ${avgG.toFixed(2)} km/L. Experimente abastecer com Etanol com tanque cheio para calcular o seu fator real de rendimento!`;
        } else {
            insightEl.innerText = "Lembre-se de marcar a opção 'Tanque Cheio' nos seus abastecimentos para obter cálculos exatos de consumo (km/L).";
        }
    }

    function calcularDecisaoPosto() {
        const pA = parseDecimalValue(document.getElementById('calcPrecoA').value);
        const pG = parseDecimalValue(document.getElementById('calcPrecoG').value);
        const resEl = document.getElementById('resultadoCalcPosto');
        const labelFator = document.getElementById('labelFatorPosto');

        if (!resEl) return;

        const fator = getFatorRendimentoDinamico();
        if (labelFator) {
            // Sem tanques cheios de etanol E gasolina o fator é a regra geral (70%), não o do seu carro
            const { segsA, segsG } = getFullTankKmlsByFuel();
            const usingDefault = !(segsA.length && segsG.length);
            labelFator.innerText = usingDefault ? `Fator padrão: ${(fator * 100).toFixed(0)}%` : `Fator: ${(fator * 100).toFixed(1)}%`;
            labelFator.title = usingDefault
                ? 'Faltam abastecimentos de tanque cheio com etanol e com gasolina para calcular o fator do seu carro.'
                : 'Fator calculado com o consumo médio do seu carro (km/L etanol ÷ km/L gasolina).';
        }

        if (pA <= 0 || pG <= 0) {
            resEl.innerHTML = 'Insira os preços para comparar a vantagem.';
            resEl.className = "text-center p-2 rounded-xl bg-stone-200/50 dark:bg-slate-900/90 border border-stone-300/60 dark:border-slate-800 text-xs font-semibold text-stone-500 dark:text-slate-400";
            return;
        }

        const ratio = pA / pG;
        const maxEtanolPrice = pG * fator;

        if (ratio <= fator) {
            resEl.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400 font-extrabold"><i class="fa-solid fa-leaf mr-1"></i> Abasteça com ETANOL!</span> (Razão: ${(ratio * 100).toFixed(1)}% - Máx ideal: R$ ${formatDecimalTwoDigits(maxEtanolPrice)})`;
            resEl.className = "text-center p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs font-semibold text-emerald-700 dark:text-emerald-300";
        } else {
            resEl.innerHTML = `<span class="text-orange-600 dark:text-orange-400 font-extrabold"><i class="fa-solid fa-fire mr-1"></i> Abasteça com GASOLINA!</span> (Razão: ${(ratio * 100).toFixed(1)}% - Etanol valeria até: R$ ${formatDecimalTwoDigits(maxEtanolPrice)})`;
            resEl.className = "text-center p-2 rounded-xl bg-orange-500/10 border border-orange-500/30 text-xs font-semibold text-orange-700 dark:text-orange-300";
        }
    }

    function updateAnalysisCards() {
        // `records` já contém apenas os abastecimentos do veículo ativo
        const filtered = FuelCore.filterRecordsByPeriod(records, currentAnalysisPeriod, new Date());
        const totals = FuelCore.calculatePeriodTotals(filtered);
        const label = ANALYSIS_PERIOD_LABELS[currentAnalysisPeriod] || ANALYSIS_PERIOD_LABELS['30d'];

        const metricLitrosMes = document.getElementById('metricLitrosMes');
        const metricGastoMes = document.getElementById('metricGastoMes');
        const labelLitros = document.getElementById('labelPeriodLitros');
        const labelGasto = document.getElementById('labelPeriodGasto');

        if (metricLitrosMes) metricLitrosMes.innerText = `${totals.liters.toFixed(1).replace('.', ',')} L`;
        if (metricGastoMes) metricGastoMes.innerText = `R$ ${totals.spent.toFixed(2).replace('.', ',')}`;
        if (labelLitros) labelLitros.innerText = label;
        if (labelGasto) labelGasto.innerText = label;
    }

    function setAnalysisPeriod(period) {
        if (!ANALYSIS_PERIOD_LABELS[period]) return;
        currentAnalysisPeriod = period;
        const activeCls = "flex-1 py-1 rounded-md bg-white dark:bg-slate-700 text-stone-900 dark:text-white font-semibold text-[11px] transition shadow-sm dark:shadow-none focus:outline-none focus:ring-1 focus:ring-emerald-500";
        const idleCls = "flex-1 py-1 rounded-md text-stone-500 dark:text-slate-400 font-semibold text-[11px] hover:text-stone-900 dark:hover:text-white transition focus:outline-none focus:ring-1 focus:ring-emerald-500";
        document.querySelectorAll('#analysisPeriodSelector [data-period]').forEach(btn => {
            const isActive = btn.dataset.period === period;
            btn.className = isActive ? activeCls : idleCls;
            btn.setAttribute('aria-pressed', String(isActive));
        });
        updateAnalysisCards();
    }

    function recalculateMetricsAndRender() {
        const sorted = [...records].sort((a, b) => a.odo - b.odo);

        let totalKm = 0;
        let totalGasto = 0;
        let gastoCustoKm = 0;
        let currentOdo = 0;

        if (sorted.length > 0) {
            currentOdo = sorted[sorted.length - 1].odo;
            if (sorted.length > 1) {
                totalKm = sorted[sorted.length - 1].odo - sorted[0].odo;
            }
            totalGasto = safeRound(sorted.reduce((acc, r) => acc + (r.valorA || 0) + (r.valorG || 0), 0), 2);
            // O 1º abastecimento cobre km anteriores ao 1º odômetro (fora de totalKm): não entra no custo/km
            gastoCustoKm = safeRound(sorted.slice(1).reduce((acc, r) => acc + (r.valorA || 0) + (r.valorG || 0), 0), 2);
        }

        const kpiTotalKm = document.getElementById('kpiTotalKm');
        const kpiOdometro = document.getElementById('kpiOdometro');
        const kpiGastoTotal = document.getElementById('kpiGastoTotal');
        const kpiCustoMedio = document.getElementById('kpiCustoMedio');

        if (kpiTotalKm) kpiTotalKm.innerText = `${totalKm.toLocaleString('pt-BR')} km`;
        if (kpiOdometro) kpiOdometro.innerText = `Odômetro: ${currentOdo.toLocaleString('pt-BR')} km`;
        if (kpiGastoTotal) kpiGastoTotal.innerText = `R$ ${formatDecimalTwoDigits(totalGasto)}`;

        const custoKm = totalKm > 0 ? safeRound(gastoCustoKm / totalKm, 2) : 0;
        if (kpiCustoMedio) kpiCustoMedio.innerText = `Custo/km: R$ ${formatDecimalTwoDigits(custoKm)}`;

        // 'tank' = todos os trechos entre tanques cheios; 'range'/'both' = também descartam outliers fora de 5-23 km/L.
        // (A regra do tanque cheio é sempre imposta: parciais nunca fecham um trecho.)
        const segments = getConsumptionSegments(currentKmlCriterion !== 'tank');

        let alcoholSegs = segments.filter(s => s.fuel === 'A');
        let gasSegs = segments.filter(s => s.fuel === 'G');
        let mixedSegs = segments.filter(s => s.fuel === 'M');

        if (currentAvgMode === 'last5') {
            alcoholSegs = alcoholSegs.slice(-5);
            gasSegs = gasSegs.slice(-5);
            mixedSegs = mixedSegs.slice(-5);
        }

        // Média ponderada (Σkm / ΣL)
        const calcAvg = segs => segs.length ? safeRound(FuelCore.weightedKml(segs), 2) : 0;

        const avgA = calcAvg(alcoholSegs);
        const avgG = calcAvg(gasSegs);
        const avgM = calcAvg(mixedSegs);

        const avgAlcoholVal = document.getElementById('avgAlcoholVal');
        const avgGasVal = document.getElementById('avgGasVal');
        const avgMixedVal = document.getElementById('avgMixedVal');

        if (avgAlcoholVal) avgAlcoholVal.innerText = avgA > 0 ? formatDecimalTwoDigits(avgA) : '0,00';
        if (avgGasVal) avgGasVal.innerText = avgG > 0 ? formatDecimalTwoDigits(avgG) : '0,00';
        if (avgMixedVal) avgMixedVal.innerText = avgM > 0 ? formatDecimalTwoDigits(avgM) : '0,00';

        updateAnalysisCards();

        renderRecentRecords();
        renderHistoryList();
        renderRevisionForecast();
        renderTireStatus();
        renderCnhStatus();
        calcularDecisaoPosto();
        updateOdometerPlaceholder();

        if (!document.getElementById('viewAnalytics').classList.contains('hidden')) {
            renderCharts();
        }
    }

    function renderRecentRecords() {
        const listEl = document.getElementById('recentRecordsList');
        if (!listEl) return;

        const sorted = [...records].sort((a, b) => a.odo - b.odo);

        const kmlByStart = getKmlTextByRecord();
        const calculated = sorted.map(r => ({
            ...r,
            kmlText: kmlByStart.get(r) || null,
            recordIndex: records.indexOf(r)
        }));

        const recent = calculated.reverse().slice(0, 5);

        if (!recent.length) {
            listEl.innerHTML = '<div class="p-4 text-center text-xs text-stone-400 dark:text-slate-500 glass-card rounded-2xl">Nenhum abastecimento cadastrado ainda.</div>';
            return;
        }

        listEl.innerHTML = recent.map((r) => {
            const total = safeRound((r.valorA || 0) + (r.valorG || 0), 2);
            const litersA = r.precoA > 0 ? (r.valorA / r.precoA) : 0;
            const litersG = r.precoG > 0 ? (r.valorG / r.precoG) : 0;

            let fuelTag = '';
            let litersInfo = '';
            if (r.valorA > 0 && r.valorG > 0) {
                fuelTag = '<span class="text-purple-600 dark:text-purple-400 font-bold flex items-center gap-1"><i class="fa-solid fa-shuffle" aria-hidden="true"></i>Misto</span>';
                litersInfo = `${formatDecimalTwoDigits(litersA)} L Etanol + ${formatDecimalTwoDigits(litersG)} L Gasolina`;
            } else if (r.valorA > 0) {
                fuelTag = '<span class="text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-1"><i class="fa-solid fa-leaf" aria-hidden="true"></i>Etanol</span>';
                litersInfo = `${formatDecimalTwoDigits(litersA)} L`;
            } else {
                fuelTag = '<span class="text-orange-500 font-bold flex items-center gap-1"><i class="fa-solid fa-fire" aria-hidden="true"></i>Gasolina</span>';
                litersInfo = `${formatDecimalTwoDigits(litersG)} L`;
            }

            const tankTag = r.fullTank 
                ? '<span class="text-emerald-600 dark:text-emerald-400 font-medium">(Tanque Cheio)</span>' 
                : '<span class="text-amber-600 dark:text-amber-400 font-medium">(Parcial)</span>';

            return `
                <div class="glass-card p-3 rounded-xl border border-stone-300 dark:border-slate-700/50 bg-[#efe8db] dark:bg-slate-800/50 flex items-center justify-between text-xs">
                    <div>
                        <div class="font-bold text-stone-900 dark:text-white flex items-center gap-2">
                            <span>${escapeHtml(formatDateBR(r.date))}</span>
                            <span class="text-[10px] bg-stone-200 dark:bg-slate-700 text-stone-600 dark:text-slate-300 px-1.5 py-0.5 rounded">${escapeHtml(Number(r.odo).toLocaleString('pt-BR'))} km</span>
                        </div>
                        <div class="text-[11px] text-stone-500 dark:text-slate-400 mt-0.5">
                            Combustível: ${fuelTag} ${tankTag}
                        </div>
                        <div class="text-[11px] text-stone-500 dark:text-slate-400">
                            ${litersInfo}
                        </div>
                    </div>
                    <div class="text-right flex flex-col items-end gap-0.5">
                        <div class="font-black text-emerald-600 dark:text-emerald-400">R$ ${formatDecimalTwoDigits(total)}</div>
                        ${r.kmlText ? `<div class="text-xs font-black text-amber-700 dark:text-amber-400 bg-amber-500/15 dark:bg-amber-500/20 px-2 py-0.5 rounded-md border border-amber-500/40">${r.kmlText}</div>` : ''}
                        <div class="flex items-center gap-1 mt-1">
                            <button onclick="FuelTrackerApp.editRecord(${r.recordIndex})" class="w-7 h-7 rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 flex items-center justify-center transition" title="Editar" aria-label="Editar registro">
                                <i class="fa-solid fa-pen text-xs"></i>
                            </button>
                            <button onclick="FuelTrackerApp.deleteRecord(${r.recordIndex})" class="w-7 h-7 rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 flex items-center justify-center transition" title="Excluir" aria-label="Excluir registro">
                                <i class="fa-solid fa-trash text-xs"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderHistoryList() {
        const listEl = document.getElementById('fullHistoryList');
        const countBadge = document.getElementById('historyCountBadge');
        const searchVal = (document.getElementById('historySearch')?.value || '').toLowerCase();

        if (!listEl) return;

        const sorted = [...records].sort((a, b) => a.odo - b.odo);

        // recordIndex = posição REAL em `records` (editRecord/deleteRecord indexam `records`, não a lista ordenada)
        const kmlByStart = getKmlTextByRecord();
        const calculated = sorted.map(r => ({
            ...r,
            recordIndex: records.indexOf(r),
            kmlText: kmlByStart.get(r) || null
        }));

        let filtered = calculated.reverse();

        if (searchVal) {
            filtered = filtered.filter(r => 
                formatDateBR(r.date).includes(searchVal) || 
                r.odo.toString().includes(searchVal)
            );
        }

        if (currentHistoryFilter === 'A') filtered = filtered.filter(r => r.valorA > 0 && r.valorG === 0);
        if (currentHistoryFilter === 'G') filtered = filtered.filter(r => r.valorG > 0 && r.valorA === 0);
        if (currentHistoryFilter === 'M') filtered = filtered.filter(r => r.valorA > 0 && r.valorG > 0);

        if (countBadge) countBadge.innerText = `${filtered.length} registro(s)`;

        if (!filtered.length) {
            listEl.innerHTML = '<div class="p-6 text-center text-xs text-stone-400 dark:text-slate-500 glass-card rounded-2xl">Nenhum registro encontrado.</div>';
            return;
        }

        listEl.innerHTML = filtered.map((r) => {
            const total = safeRound((r.valorA || 0) + (r.valorG || 0), 2);
            const litersA = r.precoA > 0 ? (r.valorA / r.precoA) : 0;
            const litersG = r.precoG > 0 ? (r.valorG / r.precoG) : 0;

            let fuelDetails = [];
            if (r.valorA > 0) fuelDetails.push('<i class="fa-solid fa-leaf text-emerald-600 dark:text-emerald-400" aria-hidden="true"></i> Etanol: R$ ' + formatDecimalTwoDigits(r.valorA) + ' (' + (r.precoA > 0 ? 'R$ ' + formatDecimalTwoDigits(r.precoA) + '/L • ' + formatDecimalTwoDigits(litersA) + ' L' : '') + ')');
            if (r.valorG > 0) fuelDetails.push('<i class="fa-solid fa-fire text-orange-500" aria-hidden="true"></i> Gasolina: R$ ' + formatDecimalTwoDigits(r.valorG) + ' (' + (r.precoG > 0 ? 'R$ ' + formatDecimalTwoDigits(r.precoG) + '/L • ' + formatDecimalTwoDigits(litersG) + ' L' : '') + ')');
            if (r.valorA > 0 && r.valorG > 0) fuelDetails.push('<i class="fa-solid fa-shuffle text-purple-600 dark:text-purple-400" aria-hidden="true"></i> Misto');

            const tankBadge = r.fullTank 
                ? '<span class="text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded">Tanque Cheio</span>'
                : '<span class="text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded">Parcial</span>';

            return `
                <div class="glass-card p-3 rounded-2xl border border-stone-300 dark:border-slate-700/50 bg-[#efe8db] dark:bg-slate-800/50 space-y-2 text-xs">
                    <div class="flex items-center justify-between border-b border-stone-300/60 dark:border-slate-700/60 pb-2">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-bold text-stone-900 dark:text-white">${escapeHtml(formatDateBR(r.date))}</span>
                            <span class="text-[10px] font-bold bg-stone-200 dark:bg-slate-700 text-stone-700 dark:text-slate-300 px-2 py-0.5 rounded-lg">${escapeHtml(Number(r.odo).toLocaleString('pt-BR'))} km</span>
                            ${tankBadge}
                            ${r.kmlText ? `<span class="text-[11px] font-black text-amber-700 dark:text-amber-400 bg-amber-500/15 dark:bg-amber-500/20 px-2 py-0.5 rounded-md border border-amber-500/40">${r.kmlText}</span>` : ''}
                        </div>
                        <div class="flex items-center gap-1">
                            <button onclick="FuelTrackerApp.editRecord(${r.recordIndex})" class="w-7 h-7 rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 flex items-center justify-center transition" title="Editar" aria-label="Editar abastecimento de ${escapeHtml(formatDateBR(r.date))}">
                                <i class="fa-solid fa-pen text-xs" aria-hidden="true"></i>
                            </button>
                            <button onclick="FuelTrackerApp.deleteRecord(${r.recordIndex})" class="w-7 h-7 rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 flex items-center justify-center transition" title="Excluir" aria-label="Excluir abastecimento de ${escapeHtml(formatDateBR(r.date))}">
                                <i class="fa-solid fa-trash text-xs" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>

                    <div class="flex items-center justify-between text-[11px]">
                        <div class="text-stone-600 dark:text-slate-300">
                            ${fuelDetails.join(' | ')}
                        </div>
                        <div class="font-black text-emerald-600 dark:text-emerald-400 text-sm">
                            R$ ${formatDecimalTwoDigits(total)}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderRevisionForecast() {
        const forecastEl = document.getElementById('revisionForecast');
        const subtextEl = document.getElementById('revisionSubtext');
        const targetBadge = document.getElementById('revisionKmTarget');
        const progressBar = document.getElementById('revisionProgressBar');
        const progressContainer = document.getElementById('revisionProgressContainer');

        if (!forecastEl || !subtextEl || !targetBadge) return;

        const interval = isProPlan() ? (revisionConfig.interval || 10000) : 10000;
        targetBadge.innerText = `${interval.toLocaleString('pt-BR')} km`;

        if (!records.length) {
            forecastEl.innerText = "Sem dados suficientes";
            subtextEl.innerText = "Cadastre abastecimentos para calcular a estimativa";
            if (progressBar) progressBar.style.width = "0%";
            if (progressContainer) progressContainer.setAttribute('aria-valuenow', "0");
            return;
        }

        const currentOdo = Math.max(...records.map(r => Number(r.odo)));
        const nextTarget = Math.ceil((currentOdo + 1) / interval) * interval;
        const kmRemaining = nextTarget - currentOdo;

        const currentCycleKm = interval - kmRemaining;
        const progressPct = Math.min(100, Math.max(0, (currentCycleKm / interval) * 100));

        if (progressBar) progressBar.style.width = `${progressPct}%`;
        if (progressContainer) progressContainer.setAttribute('aria-valuenow', Math.round(progressPct).toString());

        if (records.length >= 2) {
            const sorted = [...records].sort((a, b) => Number(a.odo) - Number(b.odo));
            const minOdo = Number(sorted[0].odo);
            const maxOdo = Number(sorted[sorted.length - 1].odo);
            const firstDate = new Date(sorted[0].date);
            const lastDate = new Date(sorted[sorted.length - 1].date);
            const daysDiff = (lastDate - firstDate) / (1000 * 60 * 60 * 24);

            if (daysDiff <= 0 || maxOdo === minOdo) {
                forecastEl.innerText = `Próxima revisão aos ${nextTarget.toLocaleString('pt-BR')} km`;
                subtextEl.innerText = `Faltam ${kmRemaining.toLocaleString('pt-BR')} km (Registre abastecimentos em datas diferentes para estimar prazos)`;
                return;
            }

            const kmPerDay = (maxOdo - minOdo) / daysDiff;
            if (kmPerDay > 0) {
                const estimatedDaysLeft = Math.round(kmRemaining / kmPerDay);
                const estimatedDate = new Date();
                estimatedDate.setDate(estimatedDate.getDate() + estimatedDaysLeft);

                forecastEl.innerText = `Próxima revisão aos ${nextTarget.toLocaleString('pt-BR')} km (~${formatDateBR(FuelCore.toLocalISODate(estimatedDate))})`;
                subtextEl.innerText = `Faltam ${kmRemaining.toLocaleString('pt-BR')} km no seu ritmo atual de uso`;
            } else {
                forecastEl.innerText = `Próxima revisão aos ${nextTarget.toLocaleString('pt-BR')} km`;
                subtextEl.innerText = `Faltam ${kmRemaining.toLocaleString('pt-BR')} km`;
            }
        } else {
            forecastEl.innerText = `Próxima revisão aos ${nextTarget.toLocaleString('pt-BR')} km`;
            subtextEl.innerText = `Faltam ${kmRemaining.toLocaleString('pt-BR')} km`;
        }
    }

    function renderTireStatus() {
        const forecastEl = document.getElementById('tireForecast');
        const subtextEl = document.getElementById('tireSubtext');
        const targetBadge = document.getElementById('tireTargetBadge');
        const progressBar = document.getElementById('tireProgressBar');
        const progressContainer = document.getElementById('tireProgressContainer');

        if (!forecastEl || !subtextEl || !targetBadge) return;

        const currentOdo = records.length ? Math.max(...records.map(r => Number(r.odo))) : tireConfig.lastKm;
        const targetKm = tireConfig.lastKm + (isProPlan() ? tireConfig.interval : 10000);
        const kmRemaining = targetKm - currentOdo;
        
        targetBadge.innerText = `Meta: ${targetKm.toLocaleString('pt-BR')} km`;

        let progressPct = 0;
        if (tireConfig.interval > 0 && isProPlan()) {
            progressPct = Math.min(100, Math.max(0, ((currentOdo - tireConfig.lastKm) / tireConfig.interval) * 100));
        } else if (!isProPlan()) {
            progressPct = Math.min(100, Math.max(0, ((currentOdo - tireConfig.lastKm) / 10000) * 100));
        }

        if (progressBar) progressBar.style.width = `${progressPct}%`;
        if (progressContainer) progressContainer.setAttribute('aria-valuenow', Math.round(progressPct).toString());

        if (kmRemaining <= 0) {
            forecastEl.innerText = "Hora do Rodízio!";
            forecastEl.className = "text-xl font-black text-rose-600 dark:text-rose-400";
            subtextEl.innerText = `Ultrapassou ${Math.abs(kmRemaining).toLocaleString('pt-BR')} km da meta cadastrada`;
        } else {
            forecastEl.className = "text-xl font-black text-stone-900 dark:text-white";
            
            if (records.length >= 2) {
                const sorted = [...records].sort((a, b) => Number(a.odo) - Number(b.odo));
                const minOdo = Number(sorted[0].odo);
                const maxOdo = Number(sorted[sorted.length - 1].odo);
                const firstDate = new Date(sorted[0].date);
                const lastDate = new Date(sorted[sorted.length - 1].date);
                const daysDiff = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
                
                if (daysDiff <= 0 || maxOdo === minOdo) {
                    forecastEl.innerText = `Faltam ${kmRemaining.toLocaleString('pt-BR')} km`;
                    subtextEl.innerText = `Último rodízio em ${tireConfig.lastKm.toLocaleString('pt-BR')} km (Registre abastecimentos em datas diferentes para estimar prazos)`;
                    return;
                }

                const kmPerDay = (maxOdo - minOdo) / daysDiff;
                if (kmPerDay > 0) {
                    const estimatedDaysLeft = Math.round(kmRemaining / kmPerDay);
                    const estimatedDate = new Date();
                    estimatedDate.setDate(estimatedDate.getDate() + estimatedDaysLeft);
                    
                    forecastEl.innerText = `Faltam ${kmRemaining.toLocaleString('pt-BR')} km (~${formatDateBR(FuelCore.toLocalISODate(estimatedDate))})`;
                    subtextEl.innerText = `Último rodízio em ${tireConfig.lastKm.toLocaleString('pt-BR')} km`;
                } else {
                    forecastEl.innerText = `Faltam ${kmRemaining.toLocaleString('pt-BR')} km`;
                    subtextEl.innerText = `Último rodízio em ${tireConfig.lastKm.toLocaleString('pt-BR')} km`;
                }
            } else {
                forecastEl.innerText = `Faltam ${kmRemaining.toLocaleString('pt-BR')} km`;
                subtextEl.innerText = `Último rodízio em ${tireConfig.lastKm.toLocaleString('pt-BR')} km`;
            }
        }
    }

    function saveRevisionConfig(e) {
        e.preventDefault();
        const interval = parseFloat(document.getElementById('revisionIntervalInput').value);
        if (!Number.isFinite(interval) || interval <= 0) {
            showToast('Informe um intervalo de revisão maior que zero.', 'fa-triangle-exclamation', 'text-amber-500');
            return;
        }
        const newConfig = { interval };
        if (!writeJSON(vehicleKey(REVISION_STORAGE_KEY), newConfig)) return;
        revisionConfig = newConfig;
        closeRevisionModal();
        renderRevisionForecast();
        showToast('Configuração de Manutenção salva!', 'fa-circle-check', 'text-blue-500');
    }

    function openRevisionModal() {
        if (!isProPlan()) {
            blockLiteFeature();
            return;
        }
        document.getElementById('revisionIntervalInput').value = revisionConfig.interval || 10000;
        showModal('revisionModal');
    }

    function closeRevisionModal() {
        hideModal('revisionModal');
    }

    function saveTireConfig(e) {
        e.preventDefault();
        const interval = parseFloat(document.getElementById('tireIntervalInput').value);
        const lastKm = parseFloat(document.getElementById('tireLastKmInput').value);
        if (!Number.isFinite(interval) || interval <= 0) {
            showToast('Informe um intervalo de rodízio maior que zero.', 'fa-triangle-exclamation', 'text-amber-500');
            return;
        }
        if (!Number.isFinite(lastKm) || lastKm < 0) {
            showToast('O odômetro do último rodízio não pode ser negativo.', 'fa-triangle-exclamation', 'text-amber-500');
            return;
        }
        const newConfig = { interval, lastKm };
        // Antes gravava em TIRE_STORAGE_KEY (sem veículo) e lia com vehicleKey(): a config sumia nos demais veículos
        if (!writeJSON(vehicleKey(TIRE_STORAGE_KEY), newConfig)) return;
        tireConfig = newConfig;
        closeTireModal();
        renderTireStatus();
        showToast('Configuração de Rodízio salva!', 'fa-circle-check', 'text-amber-500');
    }

    function openTireModal() {
        if (!isProPlan()) {
            blockLiteFeature();
            return;
        }
        document.getElementById('tireIntervalInput').value = tireConfig.interval || 10000;
        document.getElementById('tireLastKmInput').value = tireConfig.lastKm || 0;
        showModal('tireModal');
    }

    function closeTireModal() {
        hideModal('tireModal');
    }

    function saveCnhConfig(e) {
        e.preventDefault();
        clearInlineError('cnhFormError');
        const expiryDate = document.getElementById('cnhExpiryInput').value;
        const hasToxic = document.getElementById('hasToxicCheckbox').checked;
        const toxicExpiryDate = hasToxic ? document.getElementById('toxicExpiryInput').value : '';

        if (!expiryDate) {
            showInlineError('cnhFormError', 'Informe o vencimento da CNH.', 'cnhExpiryInput');
            return;
        }
        if (hasToxic && !toxicExpiryDate) {
            showInlineError('cnhFormError', 'Informe o vencimento do Exame Toxicológico.', 'toxicExpiryInput');
            return;
        }

        const newConfig = { expiryDate, hasToxic, toxicExpiryDate };
        if (!writeJSON(CNH_STORAGE_KEY, newConfig)) return;
        cnhConfig = newConfig;
        closeCnhModal();
        renderCnhStatus();
        showToast('Validades salvas com sucesso!', 'fa-circle-check', 'text-purple-500');
    }

    function openCnhModal() {
        if (!isProPlan()) {
            blockLiteFeature('O cadastro de validade da CNH e do Toxicológico é exclusivo do plano PRO. Assine para ativar os alertas de vencimento!');
            return;
        }
        document.getElementById('cnhExpiryInput').value = cnhConfig.expiryDate || '';
        document.getElementById('hasToxicCheckbox').checked = cnhConfig.hasToxic || false;
        document.getElementById('toxicExpiryInput').value = cnhConfig.toxicExpiryDate || '';
        toggleToxicField();
        clearInlineError('cnhFormError');

        showModal('cnhModal');
    }

    function closeCnhModal() {
        hideModal('cnhModal');
    }

    function toggleToxicField() {
        const hasToxic = document.getElementById('hasToxicCheckbox').checked;
        const toxicGroup = document.getElementById('toxicFieldGroup');
        if (hasToxic) {
            toxicGroup.classList.remove('hidden');
        } else {
            toxicGroup.classList.add('hidden');
        }
    }

    function renderCnhStatus() {
        const cnhDateText = document.getElementById('cnhDateText');
        const cnhDaysBadge = document.getElementById('cnhDaysBadge');
        const toxicCard = document.getElementById('toxicCard');
        const toxicDateText = document.getElementById('toxicDateText');
        const toxicDaysBadge = document.getElementById('toxicDaysBadge');
        const alertBanner = document.getElementById('cnhAlertBanner');
        const alertText = document.getElementById('cnhAlertBannerText');

        let showAlert = false;
        let alertMessages = [];

        const cnhEval = calculateCnhStatus(cnhConfig);

        if (cnhEval.status !== 'NO_DATA') {
            cnhDateText.innerText = `Vence em: ${formatDateBR(cnhConfig.expiryDate)}`;
            if (cnhEval.status === 'EXPIRED') {
                cnhDaysBadge.innerText = 'VENCIDA';
                cnhDaysBadge.className = 'font-black text-xs px-2 py-0.5 rounded bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/30';
                showAlert = true;
                alertMessages.push('CNH Vencida!');
            } else if (cnhEval.status === 'WARNING') {
                cnhDaysBadge.innerText = `${cnhEval.diffDays} dias`;
                cnhDaysBadge.className = 'font-black text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30';
                showAlert = true;
                alertMessages.push(`CNH vence em ${cnhEval.diffDays} dias`);
            } else {
                cnhDaysBadge.innerText = `${cnhEval.diffDays} dias`;
                cnhDaysBadge.className = 'font-black text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30';
            }
        } else {
            cnhDateText.innerText = 'Data não cadastrada';
            cnhDaysBadge.innerText = '-';
            cnhDaysBadge.className = 'font-black text-sm text-stone-400';
        }

        if (cnhConfig.hasToxic && cnhConfig.toxicExpiryDate) {
            toxicCard.classList.remove('hidden');
            toxicDateText.innerText = `Vence em: ${formatDateBR(cnhConfig.toxicExpiryDate)}`;
            const toxicEval = calculateCnhStatus({ expiryDate: cnhConfig.toxicExpiryDate });

            if (toxicEval.status === 'EXPIRED') {
                toxicDaysBadge.innerText = 'VENCIDO';
                toxicDaysBadge.className = 'font-black text-xs px-2 py-0.5 rounded bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/30';
                showAlert = true;
                alertMessages.push('Toxicológico Vencido!');
            } else if (toxicEval.status === 'WARNING') {
                toxicDaysBadge.innerText = `${toxicEval.diffDays} dias`;
                toxicDaysBadge.className = 'font-black text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30';
                showAlert = true;
                alertMessages.push(`Toxicológico vence em ${toxicEval.diffDays} dias`);
            } else {
                toxicDaysBadge.innerText = `${toxicEval.diffDays} dias`;
                toxicDaysBadge.className = 'font-black text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30';
            }
        } else {
            toxicCard.classList.add('hidden');
        }

        if (showAlert && alertBanner) {
            alertText.innerText = `Atenção: ${alertMessages.join(' | ')}`;
            alertBanner.classList.remove('hidden');
        } else if (alertBanner) {
            alertBanner.classList.add('hidden');
        }
    }

    function renderCharts() {
        if (typeof Chart === 'undefined') return;

        const isDark = document.documentElement.classList.contains('dark');
        const textColor = isDark ? '#94a3b8' : '#475569';
        const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';

        const labels = [];
        const dataKml = [];

        getConsumptionSegments(true).forEach(s => {
            labels.push(formatDateBR(s.end.date));
            dataKml.push(safeRound(s.kml, 2));
        });

        const ctx1 = document.getElementById('consumptionChart')?.getContext('2d');
        if (ctx1) {
            if (chartInstance) chartInstance.destroy();

            chartInstance = new Chart(ctx1, {
                type: 'line',
                data: {
                    labels: labels.length ? labels : ['Sem dados'],
                    datasets: [{
                        label: 'Km/L',
                        data: dataKml.length ? dataKml : [0],
                        borderColor: '#f97316',
                        backgroundColor: 'rgba(249, 115, 22, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.3,
                        pointRadius: 4,
                        pointHoverRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        x: {
                            ticks: { color: textColor, font: { size: 10 } },
                            grid: { color: gridColor }
                        },
                        y: {
                            ticks: { color: textColor, font: { size: 10 } },
                            grid: { color: gridColor }
                        }
                    }
                }
            });
        }

        const ctx2 = document.getElementById('fuelDistChart')?.getContext('2d');
        if (ctx2) {
            if (distChartInstance) distChartInstance.destroy();

            let countA = 0, countG = 0, countM = 0;
            records.forEach(r => {
                if (r.valorA > 0 && r.valorG > 0) countM++;
                else if (r.valorA > 0) countA++;
                else if (r.valorG > 0) countG++;
            });

            distChartInstance = new Chart(ctx2, {
                type: 'doughnut',
                data: {
                    labels: ['Etanol', 'Gasolina', 'Misto'],
                    datasets: [{
                        data: [countA, countG, countM],
                        backgroundColor: ['#10b981', '#f97316', '#8b5cf6'],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { color: textColor, font: { size: 11 } }
                        }
                    }
                }
            });
        }

        generateInsightText();
    }

    function init() {
        initTheme();
        if (navigator.storage && typeof navigator.storage.persist === 'function') {
            navigator.storage.persist().catch(() => { });
        }
        initOfflineNetworkMonitoring();
        const inputData = document.getElementById('inputData');
        if (inputData) { inputData.value = FuelCore.todayLocalISO(); inputData.max = FuelCore.todayLocalISO(); }

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            const installBtn = document.getElementById('pwaInstallBtn');
            if (installBtn) installBtn.classList.remove('hidden');
        });

        document.addEventListener('click', function(event) {
            const dropdown = document.getElementById('settingsDropdown');
            const gearBtn = event.target.closest('button[onclick*="toggleSettingsMenu"]');
            if (dropdown && !dropdown.classList.contains('hidden') && !gearBtn && !dropdown.contains(event.target)) {
                dropdown.classList.add('hidden');
                const btn = document.getElementById('btnSettingsMenu');
                if (btn) btn.setAttribute('aria-expanded', 'false');
            }
        });

        const vehicleListEl = document.getElementById('vehicleListContainer');
        if (vehicleListEl) {
            vehicleListEl.addEventListener('click', function (event) {
                const btn = event.target.closest('[data-action]');
                if (!btn || !vehicleListEl.contains(btn)) return;
                if (btn.dataset.action === 'edit-vehicle') editVehicle(btn.dataset.id);
                else if (btn.dataset.action === 'delete-vehicle') deleteVehicle(btn.dataset.id);
            });
        }

        if (FuelBilling.isDev()) {
            if (localStorage.getItem(PRO_FLAG_KEY) === null) localStorage.setItem(PRO_FLAG_KEY, 'false');
            const devMenu = document.getElementById('devPlanMenu');
            if (devMenu) devMenu.classList.remove('hidden'); // botão "Dev: Lite/Pro" só aparece no modo dev
        } else {
            try { localStorage.removeItem(PRO_FLAG_KEY); } catch (e) { } // produção: a flag de teste não vale mais
        }
        FuelBilling.onChange(onPlanChanged);

        document.addEventListener('keydown', handleGlobalKeydown);
        [['fuelForm', 'formError'], ['vehicleForm', 'vehicleFormError'], ['cnhForm', 'cnhFormError']].forEach(([formId, errId]) => {
            const f = document.getElementById(formId);
            if (f) f.addEventListener('input', () => clearInlineError(errId));
        });

        loadVehicles();
        renderVehicleSelector();
        renderVehicleList();
        loadRecords();
        loadTireConfig();
        loadCnhConfig();
        loadRevisionConfig();
        loadPlanStatus();
        renderPlanBadge();
        recalculateMetricsAndRender();
        FuelBilling.refresh(); // produção: sincroniza com o Google Play (restaura/confirma/revoga); dev: não faz nada
    }

    // Inicialização ao carregar o DOM
    window.addEventListener('DOMContentLoaded', init);

    // API pública exposta estritamente para os handlers de eventos do DOM
    return {
        maskDecimalTwoDigits,
        calcularDecisaoPosto,
        switchTab,
        setAvgMode,
        setAnalysisPeriod,
        updateAnalysisCards,
        setKmlFilterCriterion,
        setHistoryFilter,
        handleFormSubmit,
        editRecord,
        deleteRecord,
        resetForm,
        updateOdometerPlaceholder,
        renderHistoryList,
        toggleTheme,
        shareAppWithFriend,
        toggleSettingsMenu,
        openManualModal,
        closeManualModal,
        handleExportJSON,
        importJSON,
        handleExportExcel,
        handleResetDatabase,
        saveRevisionConfig,
        openRevisionModal,
        closeRevisionModal,
        saveTireConfig,
        openTireModal,
        closeTireModal,
        saveCnhConfig,
        openCnhModal,
        closeCnhModal,
        toggleToxicField,
        closeImportModal,
        confirmImport,
        onImportTargetChange,
        installPWA,
        openUpgradeModal,
        closeUpgradeModal,
        processProUpgrade,
        switchVehicle,
        openVehicleModal,
        closeVehicleModal,
        saveVehicle,
        renderVehicleList,
        editVehicle,
        deleteVehicle,
        maskPlateInput,
        exportFullBackup,
        importFullBackup,
        handleFullImportFile,
        openBackupModal,
        closeBackupModal,
        switchBackupTab
    };
})();
