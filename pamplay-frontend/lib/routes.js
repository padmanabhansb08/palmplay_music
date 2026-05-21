/**
 * PalmPlay URL helpers — works with /app (Vercel) and /pamplay-frontend (local).
 */
(function () {
    function detectBase() {
        const p = window.location.pathname;
        if (p === '/app' || p.startsWith('/app/')) return '/app';
        const idx = p.indexOf('/pamplay-frontend');
        if (idx !== -1) return '/pamplay-frontend';
        return '/pamplay-frontend';
    }

    const base = detectBase();
    const useCleanUrls = base === '/app';

    const pages = {
        home: useCleanUrls ? '/app' : `${base}/home.html`,
        explore: useCleanUrls ? '/app/explore' : `${base}/explore.html`,
        discover: useCleanUrls ? '/app/explore#discover' : `${base}/explore.html#discover`,
        login: useCleanUrls ? '/app/login' : `${base}/login.html`,
        signup: useCleanUrls ? '/app/signup' : `${base}/signup.html`,
        premium: useCleanUrls ? '/app/premium' : `${base}/premium.html`,
    };

    function isExplorePage() {
        const p = window.location.pathname;
        return p.includes('/explore') || p.endsWith('explore.html');
    }

    function isHomePage() {
        const p = window.location.pathname;
        return p.endsWith('home.html') || p === '/app' || p === '/app/';
    }

    function go(pageKey) {
        const url = pages[pageKey];
        if (url) window.location.href = url;
    }

    function applyLinkRoutes() {
        document.querySelectorAll('[data-pp-route]').forEach((el) => {
            const key = el.getAttribute('data-pp-route');
            if (pages[key]) el.setAttribute('href', pages[key]);
        });
    }

    window.PalmPlayRoutes = {
        base,
        pages,
        page: (key) => pages[key] || pages.home,
        go,
        isExplorePage,
        isHomePage,
        applyLinkRoutes,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyLinkRoutes);
    } else {
        applyLinkRoutes();
    }
})();
