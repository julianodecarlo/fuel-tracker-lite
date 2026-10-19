// sw.js - Service Worker do Fuel Tracker (100% offline após a 1ª visita)
//
// Estratégias:
//  • Vendor e ícones (não mudam sem trocar de arquivo): CACHE-FIRST.
//  • App shell (navegação, index.html, app.js, core.js, manifest.json): NETWORK-FIRST com timeout.
//    Online, o usuário sempre recebe a versão mais nova; offline (ou rede lenta), usa o cache.
//    Assim ninguém fica preso numa versão antiga caso o CACHE_NAME não seja trocado.
//
// QUANDO TROCAR O NÚMERO em CACHE_NAME (força baixar tudo de novo):
//  • ao adicionar/remover arquivos das listas abaixo;
//  • ao alterar o CONTEÚDO de vendor/ ou icons/ (ex.: recompilar o vendor/tailwind.css) - são cache-first.
// Os arquivos do app (index.html, app.js, core.js, billing.js) atualizam sozinhos quando há internet.
const CACHE_PREFIX = 'fuel-tracker-';
const CACHE_NAME = CACHE_PREFIX + 'v9';
const NETWORK_TIMEOUT_MS = 3000;

// App shell (6 arquivos)
const APP_SHELL = [
    'index.html',
    'app.js',
    'core.js',
    'billing.js',
    'manifest.json',
    'diagnostico.html'
];

// Estáticos de vendor e ícones (12 arquivos) => total pré-cacheado: 18
const STATIC_ASSETS = [
    'vendor/tailwind.css',
    'vendor/chart.umd.js',
    'vendor/xlsx.full.min.js',
    'vendor/fontawesome/css/all.min.css',
    'vendor/fontawesome/webfonts/fa-solid-900.woff2',
    'vendor/fontawesome/webfonts/fa-regular-400.woff2',
    'vendor/fontawesome/webfonts/fa-brands-400.woff2',
    'vendor/fontawesome/webfonts/fa-v4compatibility.woff2',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-512-maskable.png',
    'icons/apple-touch-icon.png'
];

// Caminho relativo ao escopo (funciona em domínio raiz ou subdiretório, ex.: usuario.github.io/projeto/)
const SCOPE_PATH = new URL('./', self.location).pathname;
const SHELL_PATHS = new Set(['', 'index.html', 'app.js', 'core.js', 'billing.js', 'manifest.json', 'diagnostico.html']);

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        const urls = [...APP_SHELL, ...STATIC_ASSETS];
        // Atômico: instala somente se os 18 arquivos forem baixados (garante o funcionamento 100% offline)
        await cache.addAll(urls.map((url) => new Request(url, { cache: 'reload' })));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        // Remove TODAS as versões antigas deste app (ex.: fuel-tracker-v2 ... v8).
        // Só toca em caches com o prefixo do app (a origem pode ser compartilhada com outros projetos).
        await Promise.all(
            keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return; // o app não tem mais dependências externas

    const relPath = url.pathname.startsWith(SCOPE_PATH) ? url.pathname.slice(SCOPE_PATH.length) : url.pathname;
    const isShell = request.mode === 'navigate' || SHELL_PATHS.has(relPath);

    event.respondWith(isShell ? networkFirst(request) : cacheFirst(request));
});

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    try {
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone());
        return response;
    } catch (err) {
        return Response.error();
    }
}

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);

    // Subrecursos revalidam no servidor (evita servir JS velho do cache HTTP do navegador).
    // Navegações não aceitam sobrescrever o modo de cache, então vão como estão.
    const networkRequest = request.mode === 'navigate' ? request : new Request(request, { cache: 'no-cache' });

    const network = fetch(networkRequest).then((response) => {
        // Respostas redirecionadas não podem ser reutilizadas em navegações: não vão para o cache
        if (response && response.ok && !response.redirected) cache.put(request, response.clone());
        return response;
    });
    network.catch(() => { }); // se perder a corrida do timeout, evita "unhandled rejection"

    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS); });

    try {
        return await Promise.race([network, timeout]);
    } catch (err) {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const shell = await cache.match('./index.html');
            if (shell) return shell;
        }
        return Response.error();
    } finally {
        clearTimeout(timer);
    }
}
