/**
 * Sets <base href> for /app (Vercel) vs /pamplay-frontend (local).
 * Must be inlined in HTML before any relative stylesheet/script, not loaded via relative src.
 */
(function () {
    if (document.querySelector('base[data-pp-base]')) return;
    const p = location.pathname;
    let base = '/pamplay-frontend/';
    if (p === '/app' || p.startsWith('/app/')) base = '/app/';
    const el = document.createElement('base');
    el.setAttribute('data-pp-base', '1');
    el.href = base;
    document.head.insertBefore(el, document.head.firstChild);
})();
