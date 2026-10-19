// scripts/copy-web.js - Copia SOMENTE os arquivos web do app para a pasta www/ (webDir do Capacitor).
// Uso: node scripts/copy-web.js   (ou: npm run build:web)
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'www');

const FILES = ['index.html', 'diagnostico.html', 'app.js', 'core.js', 'billing.js', 'sw.js', 'manifest.json'];
const DIRS = ['icons', 'vendor'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const f of FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) throw new Error('Arquivo obrigatório não encontrado: ' + f);
    fs.copyFileSync(src, path.join(OUT, f));
}
for (const d of DIRS) {
    const src = path.join(ROOT, d);
    if (!fs.existsSync(src)) throw new Error('Pasta obrigatória não encontrada: ' + d);
    fs.cpSync(src, path.join(OUT, d), { recursive: true });
}

console.log('[copy-web] OK: ' + FILES.length + ' arquivos + pastas ' + DIRS.join(', ') + ' -> ' + OUT);
