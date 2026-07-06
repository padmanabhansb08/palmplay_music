/**
 * PalmPlay SPA Router — intercepts nav clicks and saves playback state
 * so the audio resumes seamlessly after page navigation.
 */
(function () {
    const PLAYBACK_KEY = 'pp_playback_state';

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
        home:    useCleanUrls ? '/app'                 : `${base}/home.html`,
        explore: useCleanUrls ? '/app/explore'         : `${base}/explore.html`,
        discover:useCleanUrls ? '/app/explore#discover': `${base}/explore.html#discover`,
        login:   useCleanUrls ? '/app/login'           : `${base}/login.html`,
        signup:  useCleanUrls ? '/app/signup'          : `${base}/signup.html`,
        premium: useCleanUrls ? '/app/premium'         : `${base}/premium.html`,
    };

    function isExplorePage() {
        const p = window.location.pathname;
        return p.includes('/explore') || p.endsWith('explore.html');
    }

    function isHomePage() {
        const p = window.location.pathname;
        return p.endsWith('home.html') || p === '/app' || p === '/app/';
    }

    /** Save current playback state to sessionStorage before leaving the page */
    function savePlaybackState() {
        try {
            // Grab the audio element (created by app.js at module level)
            const audioEl = document.querySelector('audio') ||
                            document.getElementById('palmplay-audio');
            const trackName = document.querySelector('.track-name')?.textContent || '';
            const artistName = document.querySelector('.artist-name')?.textContent || '';
            const albumArtBg = document.querySelector('.album-art')?.style.backgroundImage || '';

            if (!audioEl || !audioEl.src || trackName === 'Select a song' || !trackName) return;

            const payload = {
                src: audioEl.src,
                currentTime: audioEl.currentTime,
                paused: audioEl.paused,
                volume: audioEl.volume,
                trackName,
                artistName,
                albumArtBg,
                savedAt: Date.now(),
            };
            sessionStorage.setItem(PLAYBACK_KEY, JSON.stringify(payload));
        } catch (e) {
            // sessionStorage not available — silent fail
        }
    }

    function go(pageKey) {
        const url = pages[pageKey];
        if (!url) return;
        savePlaybackState();
        document.body.classList.add('page-leaving');
        setTimeout(() => {
            window.location.href = url;
        }, 150);
    }

    function applyLinkRoutes() {
        document.querySelectorAll('[data-pp-route]').forEach((el) => {
            const key = el.getAttribute('data-pp-route');
            if (pages[key]) el.setAttribute('href', pages[key]);
        });
    }

    // Intercept all internal anchor clicks to save state first
    document.addEventListener('click', function (e) {
        const anchor = e.target.closest('a[href]');
        if (!anchor) return;
        const href = anchor.getAttribute('href') || '';
        // Only intercept internal page links (not #hash, not external)
        const isInternal =
            href.includes('home.html') ||
            href.includes('explore.html') ||
            (href.startsWith('/app') && !href.includes('login') &&
             !href.includes('signup') && !href.includes('premium'));
        if (isInternal) {
            e.preventDefault();
            savePlaybackState();
            document.body.classList.add('page-leaving');
            setTimeout(() => {
                window.location.href = anchor.href || href;
            }, 150);
        }
    }, true);

    // Also save on beforeunload as a safety net
    window.addEventListener('beforeunload', savePlaybackState);

    window.PalmPlayRoutes = {
        base,
        pages,
        page: (key) => pages[key] || pages.home,
        go,
        isExplorePage,
        isHomePage,
        applyLinkRoutes,
        savePlaybackState,
        PLAYBACK_KEY,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyLinkRoutes);
    } else {
        applyLinkRoutes();
    }
})();
