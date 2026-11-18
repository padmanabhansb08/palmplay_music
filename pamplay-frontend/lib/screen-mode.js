/* PalmPlay screen modes — TV + very large screens.
 *
 * Loaded synchronously in <head> so scaling is applied before first paint.
 *
 * 1. UI scaling. The CSS is px-based and tuned for phones/laptops. On a TV a
 *    1080p screen reports the SAME width as a 1080p monitor, but is viewed from
 *    ~3 m, so everything is ~2x too small. We scale the whole UI uniformly with
 *    CSS `zoom` so the layout keeps its proven desktop shape:
 *      - TV:            lay out as if the screen were 1280px wide (1080p → 1.5x, 4K → 3x)
 *      - Non-TV > 1920: gentle scale so 2K/4K-at-1x monitors aren't tiny
 *    `100vh` heights get multiplied by zoom, so they are divided back via --ui-zoom.
 *
 * 2. TV remote (D-pad) navigation. app.js binds ←/→ to prev/next track and ↑/↓
 *    to volume, which makes a TV remote unable to move around the page. In TV
 *    mode arrows move focus spatially, Enter activates, Back goes back, and the
 *    remote's media keys control playback.
 *
 * Override for testing / TVs we don't detect:  ?tv=1  (or ?tv=0), remembered.
 */
(function () {
    'use strict';

    var root = document.documentElement;
    var TV_UA = /SMART-?TV|SmartTV|Tizen|Web0S|webOS|NetCast|HbbTV|BRAVIA|\bAFT[A-Z0-9]{1,6}\b|Android ?TV|GoogleTV|CrKey|Roku|Viera|AQUOS|VIDAA|Hisense|TV Safari|Large Screen|PhilipsTV|Opera TV|DTV/i;

    function readOverride() {
        try {
            var q = new URLSearchParams(location.search).get('tv');
            if (q === '1' || q === '0') { localStorage.setItem('palmplay_tv', q); return q === '1'; }
            var s = localStorage.getItem('palmplay_tv');
            if (s === '1' || s === '0') return s === '1';
        } catch (e) { /* storage blocked: fall through */ }
        return null;
    }

    var override = readOverride();
    var isTV = override !== null ? override : TV_UA.test(navigator.userAgent);

    // ── Low-power ("lite") rendering ─────────────────────────────────────────
    // Glass blur (backdrop-filter) and large blurred layers are what make scrolling
    // stutter on TVs and low-end phones/laptops. Lite mode removes them and uses
    // solid backgrounds instead. Auto: TVs, data-saver, <=4 GB RAM or <=4 CPU cores.
    // Override with ?lite=1 / ?lite=0 (remembered).
    function readLite() {
        try {
            var q = new URLSearchParams(location.search).get('lite');
            if (q === '1' || q === '0') { localStorage.setItem('palmplay_lite', q); return q === '1'; }
            var s = localStorage.getItem('palmplay_lite');
            if (s === '1' || s === '0') return s === '1';
        } catch (e) { /* storage blocked */ }
        var c = navigator.connection || {};
        return !!(isTV || c.saveData ||
            (navigator.deviceMemory && navigator.deviceMemory <= 4) ||
            (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4));
    }
    var isLite = readLite();
    root.classList.toggle('perf-lite', isLite);

    function computeZoom(w) {
        if (isTV) return Math.min(4, Math.max(1, w / 1280));
        if (w > 1920) return Math.min(1.6, 1 + (w - 1920) / 1920 * 0.5); // 2560→1.17, 3840→1.5
        return 1;
    }

    function apply() {
        var z = Math.round(computeZoom(window.innerWidth) * 1000) / 1000;
        root.style.zoom = z === 1 ? '' : String(z);
        root.style.setProperty('--ui-zoom', String(z));
        root.classList.toggle('ui-scaled', z !== 1);
        root.classList.toggle('tv-mode', isTV);
    }

    // Styles that only matter in scaled / TV mode (self-contained on purpose).
    var css = [
        /* zoom multiplies vh-based heights; undo that so the app fits the screen */
        'html.ui-scaled body, html.ui-scaled #app { height: calc(100vh / var(--ui-zoom, 1)) !important; }',
        'html.ui-scaled .playlist-picker-list { max-height: min(calc(50vh / var(--ui-zoom, 1)), 320px); }',
        /* TV: big, unmistakable focus ring (10-foot UI) */
        'html.tv-mode :focus { outline: none; }',
        'html.tv-mode :focus-visible, html.tv-mode .tv-focused { outline: 3px solid #fff !important; outline-offset: 3px; border-radius: 10px; box-shadow: 0 0 0 6px rgba(255,23,68,.55) !important; }',
        'html.tv-mode .card { transition: transform .15s ease; }',
        'html.tv-mode .card:focus-visible, html.tv-mode .card.tv-focused { transform: scale(1.06); z-index: 2; }',
        /* hover-only affordances must also show on focus */
        'html.tv-mode .card:focus-visible .play-btn-overlay, html.tv-mode .card.tv-focused .play-btn-overlay { opacity: 1 !important; transform: none !important; }',
        /* player text sized for distance (13px desktop → 24px on a 1080p TV) */
        'html.tv-mode .player-bar .track-name { font-size: 16px !important; }',
        'html.tv-mode .player-bar .artist-name { font-size: 13px !important; }',
        /* low-power mode: no glass blur / big blurred layers; solid bars instead */
        'html.perf-lite *, html.perf-lite *::before, html.perf-lite *::after { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }',
        'html.perf-lite .gradient-orb { display: none !important; }',
        'html.perf-lite #np-bg-layer, html.perf-lite .home-hero-blur { filter: none !important; }',
        'html.perf-lite .sidebar, html.perf-lite .top-header { background-color: rgba(12,12,12,.94) !important; }',
        'html.perf-lite .player-bar, html.perf-lite .bottom-nav, html.perf-lite .mobile-bottom-nav { background-color: rgba(10,10,10,.97) !important; }',
        'html.perf-lite .card:hover { box-shadow: 0 8px 16px rgba(0,0,0,.35); }',
        /* nobody hovers on a TV; keep the custom scrollbar out of the way */
        'html.tv-mode ::-webkit-scrollbar { width: 0; height: 0; }'
    ].join('\n');

    function injectStyles() {
        if (document.getElementById('pp-screen-mode-css')) return;
        var st = document.createElement('style');
        st.id = 'pp-screen-mode-css';
        st.textContent = css;
        (document.head || root).appendChild(st);
    }

    apply();
    injectStyles();
    window.addEventListener('resize', apply);

    // ── TV remote navigation ────────────────────────────────────────────────
    var FOCUSABLE = [
        'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select', 'textarea',
        '[tabindex]:not([tabindex="-1"])', '[role="button"]', '[role="slider"]',
        '.card', '.nav-item', '.chip', '.track-row', '.lang-track-row', '.mobile-nav-item'
    ].join(',');

    function isVisible(el) {
        if (!el.isConnected) return false;
        var r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight * 4 || r.left > window.innerWidth * 4) return false;
        var s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.05 && !el.closest('[aria-hidden="true"], [inert]');
    }

    function candidates() {
        // If a modal / overlay is open, keep focus inside it.
        var scope = document;
        var overlays = ['#modal-container', '#now-playing.open, #now-playing.active, body.np-open #now-playing', '#queue-drawer.open', '.settings-popover.open'];
        for (var i = 0; i < overlays.length; i++) {
            var o = document.querySelector(overlays[i]);
            if (o && isVisible(o) && getComputedStyle(o).display !== 'none') { scope = o; break; }
        }
        return Array.prototype.filter.call(scope.querySelectorAll(FOCUSABLE), function (el) {
            // A card is one stop; don't make the user step through its inner buttons.
            var insideCard = el.parentElement && el.parentElement.closest('.card');
            return !insideCard && isVisible(el);
        });
    }

    function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

    // Spatial navigation, edge-to-edge (same idea as Android TV / WICG spatnav):
    // 1. candidate must lie in the pressed direction;
    // 2. candidates that LINE UP with the current element (overlapping
    //    projection) beat diagonal ones;
    // 3. then nearest edge distance wins, with a small penalty for drifting
    //    sideways.
    // Fixed chrome (header, sidebar, player, bottom nav) is a separate zone:
    // from content, arrows go to the next content row first (even if it's
    // off-screen) and only reach the chrome when no content is left that way.
    var CHROME = '.player-bar, .top-header, .sidebar, .bottom-nav, .mobile-bottom-nav';
    function pick(from, dir) {
        var all = candidates();
        if (!from.closest(CHROME)) {
            var content = all.filter(function (el) { return !el.closest(CHROME); });
            var hit = pickFrom(from, dir, content);
            if (hit) return hit;
        }
        return pickFrom(from, dir, all);
    }

    function pickFrom(from, dir, list) {
        var fr = from.getBoundingClientRect(), fc = center(fr);
        var vertical = dir === 'up' || dir === 'down';
        var best = null, bestScore = Infinity;
        list.forEach(function (el) {
            if (el === from || from.contains(el) || el.contains(from)) return;
            var r = el.getBoundingClientRect(), c = center(r);
            var gap; // distance along the pressed direction, edge to edge
            if (dir === 'down') { if (c.y <= fc.y + 2) return; gap = r.top - fr.bottom; }
            else if (dir === 'up') { if (c.y >= fc.y - 2) return; gap = fr.top - r.bottom; }
            else if (dir === 'right') { if (c.x <= fc.x + 2) return; gap = r.left - fr.right; }
            else { if (c.x >= fc.x - 2) return; gap = fr.left - r.right; }
            if (gap < -Math.min(r.height, r.width, fr.height, fr.width) / 2) return; // mostly overlapping, not "beyond"
            gap = Math.max(0, gap);

            var overlap = vertical
                ? Math.min(r.right, fr.right) - Math.max(r.left, fr.left)
                : Math.min(r.bottom, fr.bottom) - Math.max(r.top, fr.top);
            var side = vertical
                ? Math.max(0, r.left - fr.right, fr.left - r.right)
                : Math.max(0, r.top - fr.bottom, fr.top - r.bottom);
            var drift = vertical ? Math.abs(c.x - fc.x) : Math.abs(c.y - fc.y);

            var score = gap + side * 3 + drift * 0.15 + (overlap > 0 ? 0 : 600);
            if (score < bestScore) { bestScore = score; best = el; }
        });
        return best;
    }

    var lastFocused = null;
    function focusEl(el) {
        if (!el) return;
        if (!el.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.setAttribute('tabindex', '0');
        if (lastFocused && lastFocused !== el) lastFocused.classList.remove('tv-focused');
        el.classList.add('tv-focused');
        lastFocused = el;
        el.focus({ preventScroll: true });
        // Centre it: 'nearest' parks items at the bottom edge, behind the fixed
        // player bar. Instant, because smooth scroll is janky/unreliable on TVs.
        if (!el.closest('.player-bar, .top-header, .sidebar, .bottom-nav')) {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        }
    }

    function firstTarget() {
        var prefer = document.querySelector('.main-view .card, .main-view button, .main-view a[href]');
        return prefer && isVisible(prefer) ? prefer : candidates()[0];
    }

    var DIRS = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' };
    var BACK_CODES = { 10009: 1, 461: 1, 8: 0 }; // Tizen, webOS (Backspace handled separately)

    function onKey(e) {
        if (!isTV) return;
        var t = e.target;
        var typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
        var P = window.PalmPlayer;

        // Remote media keys → playback (works whether or not focus is in a field).
        switch (e.key) {
            case 'MediaPlayPause': if (P) { P.isPlaying() ? P.pause() : P.play(); } e.preventDefault(); return;
            case 'MediaPlay': if (P) P.play(); e.preventDefault(); return;
            case 'MediaPause': case 'MediaStop': if (P) P.pause(); e.preventDefault(); return;
            case 'MediaTrackNext': case 'MediaFastForward': if (P) P.next(); e.preventDefault(); return;
            case 'MediaTrackPrevious': case 'MediaRewind': if (P) P.prev(); e.preventDefault(); return;
        }

        var dir = DIRS[e.key];
        if (dir) {
            // In a text field, ←/→ move the caret; ↑/↓ leave the field.
            if (typing && (dir === 'left' || dir === 'right')) { e.stopPropagation(); return; }
            e.preventDefault();
            e.stopPropagation(); // keep app.js from treating D-pad as next/prev/volume
            var cur = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
            focusEl(cur ? (pick(cur, dir) || cur) : firstTarget());
            return;
        }

        if (e.key === 'Enter' && !typing && t && t !== document.body) {
            // Native buttons/links already activate on Enter; divs-with-onclick don't.
            if (!/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) {
                e.preventDefault();
                e.stopPropagation();
                t.click();
            }
            return;
        }

        if (!typing && (e.key === 'GoBack' || e.key === 'BrowserBack' || e.key === 'Escape' || BACK_CODES[e.keyCode] === 1)) {
            // Close an open overlay first, otherwise navigate back.
            var close = document.querySelector('#now-playing .np-close, #now-playing [aria-label*="lose" i], #modal-cancel, #queue-drawer [aria-label*="lose" i]');
            if (close && isVisible(close)) { e.preventDefault(); close.click(); return; }
            if (e.key !== 'Escape') { e.preventDefault(); history.back(); }
        }
    }

    // Capture phase on window runs before app.js's document-level shortcut handler.
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', function (e) {
        if (!isTV) return;
        if (lastFocused && lastFocused !== e.target) lastFocused.classList.remove('tv-focused');
    });

    window.PalmScreen = {
        isTV: function () { return isTV; },
        setTV: function (v) {
            isTV = !!v;
            try { localStorage.setItem('palmplay_tv', isTV ? '1' : '0'); } catch (e) {}
            apply();
        },
        zoom: function () { return parseFloat(root.style.zoom) || 1; },
        isLite: function () { return isLite; },
        setLite: function (v) {
            isLite = !!v;
            try { localStorage.setItem('palmplay_lite', isLite ? '1' : '0'); } catch (e) {}
            root.classList.toggle('perf-lite', isLite);
        },
    };
})();
