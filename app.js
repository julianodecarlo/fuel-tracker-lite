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
    let chartInstance = null;
    let distChartInstance = null;
    let deferredPrompt = null;

    let isHistoryDirty = true;

    // --- 1. FUNÇÕES PURAS (SEM DEPENDÊNCIA DE DOM) ---
    function safeRound(value, decimals = 2) {
        return Number(Math.round(parseFloat(value + 'e' + decimals)) + 'e-' + decimals);
    }

    function parseDecimalValue(val) {
        if (!val) return 0;
        if (typeof val === 'number') return safeRound(val, 2);
        let normalized = val.toString().replace(/\./g, '').replace(',', '.');
        let parsed = parseFloat(normalized);
        return isNaN(parsed) ? 0 : safeRound(parsed, 2);
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

    function sanitizeHTML(str) {
        const temp = document.createElement('div');
        temp.textContent = str;
        return temp.innerHTML;
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
        const saved = localStorage.getItem(VEHICLES_STORAGE_KEY);
        if (saved) {
            try { vehicles = JSON.parse(saved); } catch (e) { vehicles = []; }
        } else {
            vehicles = [];
        }
        if (!Array.isArray(vehicles) || !vehicles.length) {
            vehicles = [{ id: DEFAULT_VEHICLE_ID, name: 'Meu Veículo', plate: '' }];
            saveVehicles();
        }
        const savedActive = localStorage.getItem(ACTIVE_VEHICLE_STORAGE_KEY);
        activeVehicleId = vehicles.some(v => v.id === savedActive) ? savedActive : vehicles[0].id;
    }

    function saveVehicles() {
        localStorage.setItem(VEHICLES_STORAGE_KEY, JSON.stringify(vehicles));
    }

    function saveActiveVehicle() {
        localStorage.setItem(ACTIVE_VEHICLE_STORAGE_KEY, activeVehicleId);
    }

    function getActiveVehicle() {
        return vehicles.find(v => v.id === activeVehicleId) || vehicles[0];
    }

    function loadRecords() {
        const data = localStorage.getItem(vehicleKey(STORAGE_KEY));
        if (data) {
            try {
                records = JSON.parse(data);
            } catch (e) {
                records = [];
            }
        } else {
            records = [];
        }
        isHistoryDirty = true;
    }

    function saveRecords() {
        try {
            localStorage.setItem(vehicleKey(STORAGE_KEY), JSON.stringify(records));
            isHistoryDirty = true;
        } catch (e) {
            if (e.name === 'QuotaExceededError' || e.code === 22) {
                showToast('Erro: Limite de armazenamento local excedido!', 'fa-triangle-exclamation', 'text-rose-500');
            } else {
                showToast('Erro ao salvar os dados localmente.', 'fa-triangle-exclamation', 'text-rose-500');
            }
        }
    }

    function loadTireConfig() {
        const saved = localStorage.getItem(vehicleKey(TIRE_STORAGE_KEY));
        if (saved) {
            try { tireConfig = JSON.parse(saved); } catch (e) { }
        }
    }

    function loadCnhConfig() {
        const saved = localStorage.getItem(CNH_STORAGE_KEY);
        if (saved) {
            try { cnhConfig = JSON.parse(saved); } catch (e) { }
        }
    }

    function loadRevisionConfig() {
        const saved = localStorage.getItem(vehicleKey(REVISION_STORAGE_KEY));
        if (saved) {
            try { revisionConfig = JSON.parse(saved); } catch (e) { }
        }
    }

    function loadPlanStatus() {
        const saved = localStorage.getItem(PLAN_STORAGE_KEY);
        if (saved) {
            try { planStatus = JSON.parse(saved); } catch (e) { }
        }
    }

    function savePlanStatus() {
        localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(planStatus));
        renderPlanBadge();
    }

    function validateImportedRecords(data) {
        if (!Array.isArray(data)) return false;
        return data.every(item => {
            return item && typeof item === 'object' &&
                (item.date || item.data) &&
                (item.odo !== undefined || item.odometro !== undefined);
        });
    }

    function normalizeImportedRecord(item) {
        const date = item.date || item.data || new Date().toISOString().split('T')[0];
        const odo = Math.abs(Number(item.odo !== undefined ? item.odo : item.odometro)) || 0;
        const fullTank = item.fullTank !== undefined ? Boolean(item.fullTank) :
            (item.full !== undefined ? Boolean(item.full) :
            (item.tanqueCheio !== undefined ? Boolean(item.tanqueCheio) : true));

        if (item.valorA !== undefined || item.valorG !== undefined) {
            return {
                date: String(date),
                odo: parseInt(odo, 10),
                precoA: parseDecimalValue(item.precoA),
                valorA: parseDecimalValue(item.valorA),
                precoG: parseDecimalValue(item.precoG),
                valorG: parseDecimalValue(item.valorG),
                fullTank: Boolean(fullTank)
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
            date: String(date),
            odo: parseInt(odo, 10),
            precoA: parseDecimalValue(precoA),
            valorA: parseDecimalValue(valorA),
            precoG: parseDecimalValue(precoG),
            valorG: parseDecimalValue(valorG),
            fullTank: Boolean(fullTank)
        };
    }

    // --- 3. MIGRAÇÃO E CHECKOUT PRO ---
    function isProPlan() {
        return localStorage.getItem(PRO_FLAG_KEY) === 'true';
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
        const modal = document.getElementById('upgradeModal');
        if (modal) {
            modal.classList.remove('opacity-0', 'pointer-events-none');
            modal.classList.add('opacity-100');
        }
    }

    function closeUpgradeModal() {
        const modal = document.getElementById('upgradeModal');
        if (modal) {
            modal.classList.remove('opacity-100');
            modal.classList.add('opacity-0', 'pointer-events-none');
        }
    }

    // Alternar plano para testes (Dev)
    window.toggleDevPlan = function () {
        const next = isProPlan() ? 'false' : 'true';
        localStorage.setItem(PRO_FLAG_KEY, next);
        alert(next === 'true' ? 'Modo de Teste: Alterado para PRO' : 'Modo de Teste: Alterado para LITE');
        location.reload();
    };

    
    function processProUpgrade(paymentMethod) {
        // Simulação do gateway de pagamento (Stripe / Mercado Pago / PIX)
        showToast('Processando pagamento...', 'fa-spinner', 'text-sky-500');

        setTimeout(() => {
            planStatus.isPro = true;
            planStatus.expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
            localStorage.setItem(PRO_FLAG_KEY, 'true');
            savePlanStatus();
            closeUpgradeModal();
            showToast('Parabéns! Você agora é PRO!', 'fa-circle-check', 'text-emerald-500');
        }, 1500);
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
        const modal = document.getElementById('manualModal');
        if (modal) {
            modal.classList.remove('opacity-0', 'pointer-events-none');
            modal.classList.add('opacity-100');
        }
    }

    function closeManualModal() {
        const modal = document.getElementById('manualModal');
        if (modal) {
            modal.classList.remove('opacity-100');
            modal.classList.add('opacity-0', 'pointer-events-none');
        }
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
            alert('Por favor, preencha a data e o odômetro corretamente.');
            return;
        }

        if (valorA <= 0 && valorG <= 0) {
            alert('Informe ao menos um valor gasto (Etanol ou Gasolina).');
            return;
        }

        const odoError = validateOdometer(odo, date, editIndex);
        if (odoError) {
            alert(odoError);
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

        if (editIndex >= 0 && editIndex < records.length) {
            records[editIndex] = newRecord;
            showToast('Registro atualizado com sucesso!', 'fa-pen-to-square', 'text-sky-500');
        } else {
            records.push(newRecord);
            showToast('Abastecimento cadastrado!', 'fa-circle-check', 'text-emerald-500');
        }

        saveRecords();
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
        if (confirm('Tem certeza que deseja excluir este registro?')) {
            records.splice(index, 1);
            saveRecords();
            recalculateMetricsAndRender();
            showToast('Registro excluído.', 'fa-trash', 'text-rose-500');
        }
    }

    function resetForm() {
        document.getElementById('fuelForm').reset();
        document.getElementById('editIndex').value = -1;
        document.getElementById('inputData').value = new Date().toISOString().split('T')[0];
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
            `<option value="${sanitizeHTML(v.id)}"${v.id === activeVehicleId ? ' selected' : ''}>${sanitizeHTML(v.name)}${v.plate ? ' • ' + sanitizeHTML(v.plate) : ''}</option>`
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
                        <span class="font-bold text-stone-900 dark:text-white truncate">${sanitizeHTML(v.name)}</span>
                        ${isActive ? '<span class="text-[9px] uppercase font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-500/20 px-1.5 py-0.5 rounded">Ativo</span>' : ''}
                    </div>
                    <span class="text-[10px] text-stone-500 dark:text-slate-400">${v.plate ? sanitizeHTML(v.plate) : 'Sem placa'}</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" onclick="FuelTrackerApp.editVehicle('${sanitizeHTML(v.id)}')" aria-label="Editar veículo" class="w-7 h-7 rounded-lg bg-stone-200 dark:bg-slate-800 text-sky-600 dark:text-sky-400 hover:bg-stone-300 dark:hover:bg-slate-700 transition flex items-center justify-center focus:outline-none focus:ring-1 focus:ring-sky-500">
                        <i class="fa-solid fa-pen text-[10px]" aria-hidden="true"></i>
                    </button>
                    <button type="button" onclick="FuelTrackerApp.deleteVehicle('${sanitizeHTML(v.id)}')" aria-label="Excluir veículo" class="w-7 h-7 rounded-lg bg-stone-200 dark:bg-slate-800 text-rose-600 dark:text-rose-400 hover:bg-stone-300 dark:hover:bg-slate-700 transition flex items-center justify-center focus:outline-none focus:ring-1 focus:ring-rose-500">
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
        renderVehicleList();
        const modal = document.getElementById('vehicleModal');
        if (modal) {
            modal.classList.remove('opacity-0', 'pointer-events-none');
            modal.classList.add('opacity-100');
        }
    }

    function closeVehicleModal() {
        const modal = document.getElementById('vehicleModal');
        if (modal) {
            modal.classList.remove('opacity-100');
            modal.classList.add('opacity-0', 'pointer-events-none');
        }
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
        if (!confirm(`Excluir o veículo "${vehicle.name}"? Os abastecimentos vinculados a ele também não serão mais exibidos.`)) return;

        const wasActive = id === activeVehicleId;
        vehicles = vehicles.filter(v => v.id !== id);
        saveVehicles();

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

        if (!name) {
            alert('Informe o nome/modelo do veículo.');
            return;
        }
        if (!isValidPlate(plate)) {
            alert('Placa inválida. Use o formato XXX-XXXX (ex: ABC-1234).');
            return;
        }

        const existingIndex = editId ? vehicles.findIndex(v => v.id === editId) : -1;
        if (existingIndex >= 0) {
            vehicles[existingIndex] = { ...vehicles[existingIndex], name, plate };
            showToast(`Veículo "${name}" atualizado!`, 'fa-pen', 'text-sky-500');
        } else {
            vehicles.push({ id: 'v_' + Date.now().toString(36), name, plate });
            showToast(`Veículo "${name}" cadastrado!`, 'fa-car', 'text-emerald-500');
        }

        saveVehicles();
        renderVehicleSelector();
        renderVehicleList();
        recalculateMetricsAndRender();

        document.getElementById('vehicleEditId').value = '';
        document.getElementById('vehicleForm').reset();
        closeVehicleModal();
    }

    function handleResetDatabase() {
        if (confirm('ATENÇÃO: Todos os abastecimentos e configurações serão apagados permanentemente!\n\nDeseja continuar?')) {
            localStorage.removeItem(vehicleKey(STORAGE_KEY));
            localStorage.removeItem(vehicleKey(TIRE_STORAGE_KEY));
            localStorage.removeItem(CNH_STORAGE_KEY);
            localStorage.removeItem(vehicleKey(REVISION_STORAGE_KEY));
            records = [];
            tireConfig = { interval: 10000, lastKm: 0 };
            cnhConfig = { expiryDate: '', hasToxic: false, toxicExpiryDate: '' };
            revisionConfig = { interval: 10000 };
            saveRecords();
            recalculateMetricsAndRender();
            toggleSettingsMenu();
            showToast('Base de dados zerada.', 'fa-trash-arrow-up', 'text-red-500');
        }
    }

    function handleExportJSON() {
        toggleSettingsMenu();
        const backupData = {
            records,
            tireConfig,
            cnhConfig,
            revisionConfig,
            planStatus,
            vehicles,
            activeVehicleId
        };
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData, null, 2));
        const dlAnchorElem = document.createElement('a');
        dlAnchorElem.setAttribute("href", dataStr);
        if (isProPlan()) {
            const plate = getActiveVehicle().plate || 'SEM-PLACA';
            dlAnchorElem.setAttribute("download", `fuel_tracker_backup_placa ${plate}_${new Date().toISOString().split('T')[0]}.json`);
        } else {
            dlAnchorElem.setAttribute("download", `fuel_tracker_backup_${new Date().toISOString().split('T')[0]}.json`);
        }
        dlAnchorElem.click();
        showToast('Backup JSON exportado!', 'fa-download', 'text-purple-500');
    }

    function importJSON(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const imported = JSON.parse(e.target.result);
                let rawRecords;

                if (Array.isArray(imported)) {
                    rawRecords = imported;
                } else if (imported && typeof imported === 'object') {
                    rawRecords = Array.isArray(imported.records) ? imported.records : [];
                    if (imported.tireConfig) {
                        tireConfig = imported.tireConfig;
                        localStorage.setItem(vehicleKey(TIRE_STORAGE_KEY), JSON.stringify(tireConfig));
                    }
                    if (imported.cnhConfig) {
                        cnhConfig = imported.cnhConfig;
                        localStorage.setItem(CNH_STORAGE_KEY, JSON.stringify(cnhConfig));
                    }
                    if (imported.revisionConfig) {
                        revisionConfig = imported.revisionConfig;
                        localStorage.setItem(vehicleKey(REVISION_STORAGE_KEY), JSON.stringify(revisionConfig));
                    }
                    if (imported.planStatus) {
                        planStatus = imported.planStatus;
                        savePlanStatus();
                    }
                    if (Array.isArray(imported.vehicles) && imported.vehicles.length) {
                        vehicles = imported.vehicles
                            .filter(v => v && v.id && v.name)
                            .map(v => ({ id: String(v.id), name: String(v.name), plate: v.plate ? normalizePlate(String(v.plate).toUpperCase()) : '' }));
                        saveVehicles();
                    }
                    if (imported.activeVehicleId && vehicles.some(v => v.id === imported.activeVehicleId)) {
                        activeVehicleId = imported.activeVehicleId;
                        saveActiveVehicle();
                    }
                    renderVehicleSelector();
                } else {
                    alert('Formato JSON inválido.');
                    return;
                }

                if (!validateImportedRecords(rawRecords)) {
                    alert('Formato de dados do backup inválido.');
                    return;
                }

                records = rawRecords.map(normalizeImportedRecord);

                saveRecords();
                recalculateMetricsAndRender();
                showToast('Dados restaurados com sucesso!', 'fa-upload', 'text-blue-500');
            } catch (err) {
                alert('Erro ao ler o arquivo JSON. Verifique se o arquivo está correto.');
            }
            event.target.value = '';
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

            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData, null, 2));
            const dlAnchorElem = document.createElement('a');
            dlAnchorElem.setAttribute("href", dataStr);
            dlAnchorElem.setAttribute("download", fileName);
            dlAnchorElem.click();

            showToast(`Backup geral de ${exportedVehicles.length} veículo(s) exportado!`, 'fa-download', 'text-emerald-500');
        } catch (err) {
            showToast('Erro ao gerar o backup geral.', 'fa-triangle-exclamation', 'text-rose-500');
        }
    }

    function importFullBackup() {
        const input = document.getElementById('importFullFile');
        if (input) input.click();
    }

    function handleFullImportFile(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const imported = JSON.parse(e.target.result);

                if (!imported || typeof imported !== 'object' || !Array.isArray(imported.vehicles) || !imported.vehicles.length) {
                    alert('Arquivo de backup geral inválido. Utilize um arquivo "Exportar Tudo" do Fuel Tracker.');
                    return;
                }

                const count = imported.vehicles.length;
                const approved = confirm(`A restauração do backup geral substituirá TODOS os veículos, históricos e configurações atuais (${count} veículo(s) no arquivo). Deseja continuar?`);
                if (!approved) return;

                const cleanedVehicles = [];
                imported.vehicles.forEach(v => {
                    if (!v || v.id === undefined || v.id === null || v.id === '') return;
                    const id = String(v.id);
                    cleanedVehicles.push({
                        id,
                        name: String(v.name || 'Veículo'),
                        plate: v.plate ? normalizePlate(String(v.plate).toUpperCase()) : ''
                    });
                    localStorage.setItem(getVehicleScopedKey(STORAGE_KEY, id), JSON.stringify(Array.isArray(v.records) ? v.records : []));
                    if (v.tireConfig) {
                        localStorage.setItem(getVehicleScopedKey(TIRE_STORAGE_KEY, id), JSON.stringify(v.tireConfig));
                    }
                    if (v.revisionConfig) {
                        localStorage.setItem(getVehicleScopedKey(REVISION_STORAGE_KEY, id), JSON.stringify(v.revisionConfig));
                    }
                });

                if (!cleanedVehicles.length) {
                    alert('O backup não contém veículos válidos.');
                    return;
                }

                localStorage.setItem(VEHICLES_STORAGE_KEY, JSON.stringify(cleanedVehicles));
                const activeId = imported.activeVehicleId && cleanedVehicles.some(v => v.id === String(imported.activeVehicleId))
                    ? String(imported.activeVehicleId)
                    : cleanedVehicles[0].id;
                localStorage.setItem(ACTIVE_VEHICLE_STORAGE_KEY, activeId);

                if (imported.cnhConfig) {
                    localStorage.setItem(CNH_STORAGE_KEY, JSON.stringify(imported.cnhConfig));
                }
                if (imported.planStatus) {
                    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(imported.planStatus));
                }

                showToast('Backup geral restaurado! Recarregando o aplicativo...', 'fa-upload', 'text-blue-500');
                setTimeout(() => { window.location.reload(); }, 800);
            } catch (err) {
                alert('Erro ao ler o arquivo JSON. Verifique se o arquivo está correto.');
            }
            event.target.value = '';
        };
        reader.readAsText(file);
    }

    function openBackupModal() {
        const modal = document.getElementById('backupModal');
        if (modal) {
            modal.classList.remove('opacity-0', 'pointer-events-none');
            modal.classList.add('opacity-100');
            switchBackupTab('active');
        }
    }

    function closeBackupModal() {
        const modal = document.getElementById('backupModal');
        if (modal) {
            modal.classList.remove('opacity-100');
            modal.classList.add('opacity-0', 'pointer-events-none');
        }
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
        toggleSettingsMenu();
        if (!isProPlan()) {
            openUpgradeModal();
            return;
        }
        if (!records.length) {
            alert('Não há dados cadastrados para exportar.');
            return;
        }

        if (typeof XLSX === 'undefined') {
            alert('Biblioteca Excel não carregada. Verifique sua conexão.');
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
        XLSX.writeFile(wb, `fuel_tracker_relatorio_${new Date().toISOString().split('T')[0]}.xlsx`);
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

    function getFullTankKmlsByFuel() {
        const sorted = [...records].sort((a, b) => a.odo - b.odo);
        const kmlsA = [];
        const kmlsG = [];

        for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const curr = sorted[i];
            if (!curr.fullTank) continue;

            const deltaKm = curr.odo - prev.odo;
            if (deltaKm <= 0) continue;

            const litersA = curr.precoA > 0 ? (curr.valorA / curr.precoA) : 0;
            const litersG = curr.precoG > 0 ? (curr.valorG / curr.precoG) : 0;
            const totalLiters = litersA + litersG;
            if (totalLiters <= 0) continue;

            const kml = deltaKm / totalLiters;
            if (kml < KML_MIN || kml > KML_MAX) continue;

            if (prev.valorA > 0 && prev.valorG === 0) {
                kmlsA.push(kml);
            } else if (prev.valorG > 0 && prev.valorA === 0) {
                kmlsG.push(kml);
            }
        }

        return { kmlsA, kmlsG };
    }

    function getFatorRendimentoDinamico() {
        const { kmlsA, kmlsG } = getFullTankKmlsByFuel();

        if (!kmlsA.length || !kmlsG.length) {
            return 0.70;
        }

        const avgKmlA = kmlsA.reduce((a, b) => a + b, 0) / kmlsA.length;
        const avgKmlG = kmlsG.reduce((a, b) => a + b, 0) / kmlsG.length;

        return safeRound(avgKmlA / avgKmlG, 4);
    }

    function generateInsightText() {
        const insightEl = document.getElementById('insightText');
        if (!insightEl) return;

        if (records.length < 3) {
            insightEl.innerText = "Cadastre pelo menos 3 abastecimentos com tanque cheio para receber análises e sugestões personalizadas de economia.";
            return;
        }

        const { kmlsA, kmlsG } = getFullTankKmlsByFuel();

        if (kmlsA.length && kmlsG.length) {
            const avgA = kmlsA.reduce((a, b) => a + b, 0) / kmlsA.length;
            const avgG = kmlsG.reduce((a, b) => a + b, 0) / kmlsG.length;
            const ratio = ((avgA / avgG) * 100).toFixed(1);
            insightEl.innerText = `O seu motor entrega ${avgA.toFixed(2)} km/L no Etanol e ${avgG.toFixed(2)} km/L na Gasolina. O seu rendimento com Etanol equivale a ${ratio}% da Gasolina. Abasteça com Etanol sempre que o preço por litro for menor que ${ratio}% do valor da gasolina!`;
        } else if (kmlsA.length) {
            const avgA = kmlsA.reduce((a, b) => a + b, 0) / kmlsA.length;
            insightEl.innerText = `Sua média com Etanol é de ${avgA.toFixed(2)} km/L. Experimente abastecer com Gasolina com tanque cheio para liberar a comparação automatizada entre os dois combustíveis!`;
        } else if (kmlsG.length) {
            const avgG = kmlsG.reduce((a, b) => a + b, 0) / kmlsG.length;
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
            labelFator.innerText = `Fator: ${(fator * 100).toFixed(1)}%`;
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

    function recalculateMetricsAndRender() {
        const sorted = [...records].sort((a, b) => a.odo - b.odo);

        let totalKm = 0;
        let totalGasto = 0;
        let currentOdo = 0;

        if (sorted.length > 0) {
            currentOdo = sorted[sorted.length - 1].odo;
            if (sorted.length > 1) {
                totalKm = sorted[sorted.length - 1].odo - sorted[0].odo;
            }
            totalGasto = safeRound(sorted.reduce((acc, r) => acc + (r.valorA || 0) + (r.valorG || 0), 0), 2);
        }

        const kpiTotalKm = document.getElementById('kpiTotalKm');
        const kpiOdometro = document.getElementById('kpiOdometro');
        const kpiGastoTotal = document.getElementById('kpiGastoTotal');
        const kpiCustoMedio = document.getElementById('kpiCustoMedio');

        if (kpiTotalKm) kpiTotalKm.innerText = `${totalKm.toLocaleString('pt-BR')} km`;
        if (kpiOdometro) kpiOdometro.innerText = `Odômetro: ${currentOdo.toLocaleString('pt-BR')} km`;
        if (kpiGastoTotal) kpiGastoTotal.innerText = `R$ ${formatDecimalTwoDigits(totalGasto)}`;

        const custoKm = totalKm > 0 ? safeRound(totalGasto / totalKm, 2) : 0;
        if (kpiCustoMedio) kpiCustoMedio.innerText = `Custo/km: R$ ${formatDecimalTwoDigits(custoKm)}`;

        let alcoholKmls = [];
        let gasKmls = [];
        let mixedKmls = [];

        for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const curr = sorted[i];

            const deltaKm = curr.odo - prev.odo;
            if (deltaKm <= 0) continue;

            if (currentKmlCriterion === 'tank' && !curr.fullTank) continue;

            const litersA = curr.precoA > 0 ? (curr.valorA / curr.precoA) : 0;
            const litersG = curr.precoG > 0 ? (curr.valorG / curr.precoG) : 0;
            const totalLiters = litersA + litersG;

            if (totalLiters <= 0) continue;

            const kml = deltaKm / totalLiters;

            if (currentKmlCriterion === 'range' && (kml < KML_MIN || kml > KML_MAX)) continue;
            if (currentKmlCriterion === 'both' && (!curr.fullTank || kml < KML_MIN || kml > KML_MAX)) continue;

            if (prev.valorA > 0 && prev.valorG === 0) {
                alcoholKmls.push(kml);
            } else if (prev.valorG > 0 && prev.valorA === 0) {
                gasKmls.push(kml);
            } else if (prev.valorA > 0 && prev.valorG > 0) {
                mixedKmls.push(kml);
            }
        }

        if (currentAvgMode === 'last5') {
            alcoholKmls = alcoholKmls.slice(-5);
            gasKmls = gasKmls.slice(-5);
            mixedKmls = mixedKmls.slice(-5);
        }

        const calcAvg = arr => arr.length ? safeRound(arr.reduce((a, b) => a + b, 0) / arr.length, 2) : 0;

        const avgA = calcAvg(alcoholKmls);
        const avgG = calcAvg(gasKmls);
        const avgM = calcAvg(mixedKmls);

        const avgAlcoholVal = document.getElementById('avgAlcoholVal');
        const avgGasVal = document.getElementById('avgGasVal');
        const avgMixedVal = document.getElementById('avgMixedVal');

        if (avgAlcoholVal) avgAlcoholVal.innerText = avgA > 0 ? formatDecimalTwoDigits(avgA) : '0,00';
        if (avgGasVal) avgGasVal.innerText = avgG > 0 ? formatDecimalTwoDigits(avgG) : '0,00';
        if (avgMixedVal) avgMixedVal.innerText = avgM > 0 ? formatDecimalTwoDigits(avgM) : '0,00';

        const today = new Date();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(today.getDate() - 30);

        const recentRecords = sorted.filter(r => new Date(r.date) >= thirtyDaysAgo);
        let litros30Dias = 0;
        let gasto30Dias = 0;

        recentRecords.forEach(r => {
            const lA = r.precoA > 0 ? (r.valorA / r.precoA) : 0;
            const lG = r.precoG > 0 ? (r.valorG / r.precoG) : 0;
            litros30Dias += (lA + lG);
            gasto30Dias += ((r.valorA || 0) + (r.valorG || 0));
        });

        const metricLitrosMes = document.getElementById('metricLitrosMes');
        const metricGastoMes = document.getElementById('metricGastoMes');

        if (metricLitrosMes) metricLitrosMes.innerText = `${safeRound(litros30Dias, 1).toFixed(1).replace('.', ',')} L`;
        if (metricGastoMes) metricGastoMes.innerText = `R$ ${formatDecimalTwoDigits(safeRound(gasto30Dias, 2))}`;

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

        const calculated = sorted.map((r, index) => {
            let kmlText = null;
            
            if (index < sorted.length - 1) {
                const nextRec = sorted[index + 1];
                const deltaKm = nextRec.odo - r.odo;
                
                const litersA = nextRec.precoA > 0 ? (nextRec.valorA / nextRec.precoA) : 0;
                const litersG = nextRec.precoG > 0 ? (nextRec.valorG / nextRec.precoG) : 0;
                const totalLiters = litersA + litersG;

                if (deltaKm > 0 && totalLiters > 0 && nextRec.fullTank) {
                    const kml = deltaKm / totalLiters;
                    kmlText = `${formatDecimalTwoDigits(kml)} km/L`;
                }
            }

            return { ...r, kmlText, recordIndex: records.indexOf(r) };
        });

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
                            <span>${sanitizeHTML(formatDateBR(r.date))}</span>
                            <span class="text-[10px] bg-stone-200 dark:bg-slate-700 text-stone-600 dark:text-slate-300 px-1.5 py-0.5 rounded">${r.odo.toLocaleString('pt-BR')} km</span>
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

        const calculated = sorted.map((r, index) => {
            let kmlText = null;

            if (index < sorted.length - 1) {
                const nextRec = sorted[index + 1];
                const deltaKm = nextRec.odo - r.odo;
                
                const litersA = nextRec.precoA > 0 ? (nextRec.valorA / nextRec.precoA) : 0;
                const litersG = nextRec.precoG > 0 ? (nextRec.valorG / nextRec.precoG) : 0;
                const totalLiters = litersA + litersG;

                if (deltaKm > 0 && totalLiters > 0 && nextRec.fullTank) {
                    const kml = deltaKm / totalLiters;
                    kmlText = `${formatDecimalTwoDigits(kml)} km/L`;
                }
            }

            return { ...r, originalIndex: index, kmlText };
        });

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
                            <span class="font-bold text-stone-900 dark:text-white">${sanitizeHTML(formatDateBR(r.date))}</span>
                            <span class="text-[10px] font-bold bg-stone-200 dark:bg-slate-700 text-stone-700 dark:text-slate-300 px-2 py-0.5 rounded-lg">${r.odo.toLocaleString('pt-BR')} km</span>
                            ${tankBadge}
                            ${r.kmlText ? `<span class="text-[11px] font-black text-amber-700 dark:text-amber-400 bg-amber-500/15 dark:bg-amber-500/20 px-2 py-0.5 rounded-md border border-amber-500/40">${r.kmlText}</span>` : ''}
                        </div>
                        <div class="flex items-center gap-1">
                            <button onclick="FuelTrackerApp.editRecord(${r.originalIndex})" class="w-7 h-7 rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 flex items-center justify-center transition" title="Editar">
                                <i class="fa-solid fa-pen text-xs"></i>
                            </button>
                            <button onclick="FuelTrackerApp.deleteRecord(${r.originalIndex})" class="w-7 h-7 rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 flex items-center justify-center transition" title="Excluir">
                                <i class="fa-solid fa-trash text-xs"></i>
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

                forecastEl.innerText = `Próxima revisão aos ${nextTarget.toLocaleString('pt-BR')} km (~${formatDateBR(estimatedDate.toISOString().split('T')[0])})`;
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
                    
                    forecastEl.innerText = `Faltam ${kmRemaining.toLocaleString('pt-BR')} km (~${formatDateBR(estimatedDate.toISOString().split('T')[0])})`;
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
        const interval = parseFloat(document.getElementById('revisionIntervalInput').value) || 10000;
        revisionConfig = { interval };
        localStorage.setItem(vehicleKey(REVISION_STORAGE_KEY), JSON.stringify(revisionConfig));
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
        const modal = document.getElementById('revisionModal');
        if (modal) {
            modal.classList.remove('opacity-0', 'pointer-events-none');
            modal.classList.add('opacity-100');
        }
    }

    function closeRevisionModal() {
        const modal = document.getElementById('revisionModal');
        if (modal) {
            modal.classList.remove('opacity-100');
            modal.classList.add('opacity-0', 'pointer-events-none');
        }
    }

    function saveTireConfig(e) {
        e.preventDefault();
        const interval = parseFloat(document.getElementById('tireIntervalInput').value) || 10000;
        const lastKm = parseFloat(document.getElementById('tireLastKmInput').value) || 0;
        
        tireConfig = { interval, lastKm };
        localStorage.setItem(TIRE_STORAGE_KEY, JSON.stringify(tireConfig));
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
        const modal = document.getElementById('tireModal');
        if (modal) {
            modal.classList.remove('opacity-0', 'pointer-events-none');
            modal.classList.add('opacity-100');
        }
    }

    function closeTireModal() {
        const modal = document.getElementById('tireModal');
        if (modal) {
            modal.classList.remove('opacity-100');
            modal.classList.add('opacity-0', 'pointer-events-none');
        }
    }

    function saveCnhConfig(e) {
        e.preventDefault();
        const expiryDate = document.getElementById('cnhExpiryInput').value;
        const hasToxic = document.getElementById('hasToxicCheckbox').checked;
        const toxicExpiryDate = hasToxic ? document.getElementById('toxicExpiryInput').value : '';

        cnhConfig = { expiryDate, hasToxic, toxicExpiryDate };
        localStorage.setItem(CNH_STORAGE_KEY, JSON.stringify(cnhConfig));
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

        const modal = document.getElementById('cnhModal');
        if (modal) {
            modal.classList.remove('opacity-0', 'pointer-events-none');
            modal.classList.add('opacity-100');
        }
    }

    function closeCnhModal() {
        const modal = document.getElementById('cnhModal');
        if (modal) {
            modal.classList.remove('opacity-100');
            modal.classList.add('opacity-0', 'pointer-events-none');
        }
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

        const sorted = [...records].sort((a, b) => a.odo - b.odo);

        const labels = [];
        const dataKml = [];

        for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const curr = sorted[i];

            const deltaKm = curr.odo - prev.odo;
            if (deltaKm <= 0) continue;

            const litersA = curr.precoA > 0 ? (curr.valorA / curr.precoA) : 0;
            const litersG = curr.precoG > 0 ? (curr.valorG / curr.precoG) : 0;
            const totalLiters = litersA + litersG;

            if (totalLiters <= 0) continue;

            const kml = deltaKm / totalLiters;
            if (kml >= KML_MIN && kml <= KML_MAX) {
                labels.push(formatDateBR(curr.date));
                dataKml.push(safeRound(kml, 2));
            }
        }

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
        initOfflineNetworkMonitoring();
        const inputData = document.getElementById('inputData');
        if (inputData) inputData.value = new Date().toISOString().split('T')[0];

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

        if (localStorage.getItem(PRO_FLAG_KEY) === null) {
            localStorage.setItem(PRO_FLAG_KEY, 'false');
        }

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
    }

    // Inicialização ao carregar o DOM
    window.addEventListener('DOMContentLoaded', init);

    // API pública exposta estritamente para os handlers de eventos do DOM
    return {
        maskDecimalTwoDigits,
        calcularDecisaoPosto,
        switchTab,
        setAvgMode,
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
