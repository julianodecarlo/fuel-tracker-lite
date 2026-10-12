// core.js - Funções PURAS do Fuel Tracker (sem DOM e sem localStorage).
// Script clássico: expõe o objeto global `FuelCore` (e module.exports para testes em Node).
const FuelCore = (() => {
    'use strict';

    const MAX_ODOMETER = 9999999;

    // Arredondamento decimal sem erros de ponto flutuante (1.005 -> 1.01), simétrico para negativos.
    function safeRound(value, decimals = 2) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        const abs = Math.abs(n);
        if (abs < 1e-6) return 0;
        if (abs >= 1e21) return n;
        return Math.sign(n) * Number(Math.round(Number(abs + 'e' + decimals)) + 'e-' + decimals);
    }

    // Aceita "1.234,56" (BR), "3,69" e "3.69" (decimal com ponto, padrão JSON). Rejeita "1,2,3", "1e3", "abc".
    function parseDecimalValue(val) {
        if (typeof val === 'number') return Number.isFinite(val) ? safeRound(val, 2) : 0;
        const s = String(val === null || val === undefined ? '' : val).trim();
        if (!s) return 0;
        const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
        if (!/^-?\d+(\.\d+)?$/.test(normalized)) return 0;
        return safeRound(parseFloat(normalized), 2);
    }

    // Data LOCAL no formato YYYY-MM-DD (toISOString usa UTC e devolve "amanhã" após 21h no Brasil).
    function toLocalISODate(d = new Date()) {
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    function todayLocalISO() {
        return toLocalISODate(new Date());
    }

    // Escapa texto E aspas: seguro para conteúdo e para atributos HTML.
    function escapeHtml(s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function toBool(v) {
        return v === true || v === 'true' || v === 1 || v === '1';
    }

    // --- Consumo (km/L) ---
    const litersOf = r =>
        (r.precoA > 0 ? r.valorA / r.precoA : 0) + (r.precoG > 0 ? r.valorG / r.precoG : 0);
    const fuelOf = r => (r.valorA > 0 && r.valorG > 0 ? 'M' : r.valorA > 0 ? 'A' : 'G');

    /**
     * Segmentos entre tanques cheios CONSECUTIVOS (método do tanque cheio).
     * Abastecimentos parciais só acumulam litros/combustível e nunca fecham um segmento.
     * Tudo antes do 1º tanque cheio é ignorado (nível do tanque desconhecido).
     * `start` = tanque cheio que abre o segmento, `end` = tanque cheio que o fecha (mesmas referências de `records`).
     * O combustível do segmento é o do tanque inicial + o dos parciais; se houver mais de um tipo, é 'M'.
     */
    function computeConsumptionSegments(records) {
        const sorted = [...records].sort((a, b) => a.odo - b.odo);
        const segments = [];
        let anchor = null;
        let liters = 0;
        let fuels = new Set();
        for (const r of sorted) {
            if (!anchor) {
                if (r.fullTank) { anchor = r; fuels = new Set([fuelOf(r)]); }
                continue;
            }
            liters += litersOf(r);
            if (!r.fullTank) { fuels.add(fuelOf(r)); continue; }
            const km = r.odo - anchor.odo;
            if (km > 0 && liters > 0) {
                segments.push({
                    start: anchor, end: r, km, liters, kml: km / liters,
                    fuel: fuels.size === 1 ? [...fuels][0] : 'M'
                });
            }
            anchor = r;
            liters = 0;
            fuels = new Set([fuelOf(r)]);
        }
        return segments;
    }

    // Média ponderada: Σkm / ΣL (a média aritmética das razões superestima o consumo).
    function weightedKml(segments) {
        const km = segments.reduce((s, x) => s + x.km, 0);
        const L = segments.reduce((s, x) => s + x.liters, 0);
        return L > 0 ? km / L : 0;
    }

    // --- Validação rígida de registro (portão final de qualquer dado vindo de fora) ---
    // Devolve um registro limpo e tipado, ou null se estiver corrompido.
    function sanitizeRecord(item) {
        if (!item || typeof item !== 'object') return null;

        const date = String(item.date !== undefined && item.date !== null ? item.date
            : (item.data !== undefined && item.data !== null ? item.data : ''));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        const parsed = new Date(date + 'T00:00:00Z');
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;

        let rawOdo = item.odo !== undefined ? item.odo : item.odometro;
        if (typeof rawOdo === 'string') rawOdo = /^\s*\d+\s*$/.test(rawOdo) ? Number(rawOdo) : NaN;
        if (typeof rawOdo !== 'number' || !Number.isInteger(rawOdo) || rawOdo < 0 || rawOdo > MAX_ODOMETER) return null;

        const rec = {
            date,
            odo: rawOdo,
            precoA: parseDecimalValue(item.precoA),
            valorA: parseDecimalValue(item.valorA),
            precoG: parseDecimalValue(item.precoG),
            valorG: parseDecimalValue(item.valorG),
            fullTank: item.fullTank === undefined ? true : toBool(item.fullTank)
        };
        if ([rec.precoA, rec.precoG, rec.valorA, rec.valorG].some(v => v < 0)) return null;
        if (rec.valorA <= 0 && rec.valorG <= 0) return null;
        return rec;
    }

    // --- Período de análise ---
    // periodKey: '30d' (últimos 30 dias), 'month' (mês atual), 'year' (ano atual), 'all' (sem filtro).
    // Compara strings YYYY-MM-DD (data local, sem desvio de fuso). Chave desconhecida = 'all'.
    function filterRecordsByPeriod(records, periodKey, refDate = new Date()) {
        const list = Array.isArray(records) ? records : [];
        const ref = refDate instanceof Date && !Number.isNaN(refDate.getTime()) ? refDate : new Date();
        const todayISO = toLocalISODate(ref);
        if (periodKey === '30d') {
            const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 30);
            const startISO = toLocalISODate(start);
            return list.filter(r => r && r.date >= startISO);
        }
        if (periodKey === 'month') {
            const prefix = todayISO.slice(0, 7);
            return list.filter(r => r && String(r.date).slice(0, 7) === prefix);
        }
        if (periodKey === 'year') {
            const prefix = todayISO.slice(0, 4);
            return list.filter(r => r && String(r.date).slice(0, 4) === prefix);
        }
        return [...list];
    }

    // Soma litros e valor gasto (A + G) dos registros informados.
    function calculatePeriodTotals(records) {
        let liters = 0;
        let spent = 0;
        (Array.isArray(records) ? records : []).forEach(r => {
            liters += litersOf(r);
            spent += (r.valorA || 0) + (r.valorG || 0);
        });
        return { liters: safeRound(liters, 1), spent: safeRound(spent, 2) };
    }

    return {
        MAX_ODOMETER,
        safeRound, parseDecimalValue, toLocalISODate, todayLocalISO, escapeHtml, toBool,
        litersOf, fuelOf, computeConsumptionSegments, weightedKml, sanitizeRecord,
        filterRecordsByPeriod, calculatePeriodTotals
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FuelCore;
}
