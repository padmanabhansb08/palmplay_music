/**
 * Cloudflare Turnstile for Supabase Auth captcha (when enabled in dashboard).
 */
(function () {
    let widgetId = null;
    let token = null;
    let scriptPromise = null;

    function siteKey() {
        return (window.PALMPLAY_SUPABASE?.turnstileSiteKey || '').trim();
    }

    function isRequired() {
        return !!siteKey();
    }

    function loadScript() {
        if (window.turnstile) return Promise.resolve();
        if (scriptPromise) return scriptPromise;
        scriptPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
            s.async = true;
            s.defer = true;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Failed to load Turnstile'));
            document.head.appendChild(s);
        });
        return scriptPromise;
    }

    async function mount(containerId) {
        const key = siteKey();
        const el = document.getElementById(containerId);
        if (!key || !el) return false;

        el.style.display = 'flex';
        el.style.justifyContent = 'center';
        el.style.marginBottom = '16px';

        await loadScript();
        if (widgetId !== null) {
            try {
                window.turnstile.remove(widgetId);
            } catch (e) {
                /* ignore */
            }
            widgetId = null;
        }
        token = null;

        widgetId = window.turnstile.render(el, {
            sitekey: key,
            theme: 'dark',
            callback: (t) => {
                token = t;
            },
            'expired-callback': () => {
                token = null;
            },
            'error-callback': () => {
                token = null;
            }
        });
        return true;
    }

    function getToken() {
        return token;
    }

    function reset() {
        token = null;
        if (widgetId !== null && window.turnstile) {
            try {
                window.turnstile.reset(widgetId);
            } catch (e) {
                /* ignore */
            }
        }
    }

    function requireTokenOrToast(showToast) {
        if (!isRequired()) return true;
        if (token) return true;
        showToast('Complete the security check below, then try again.');
        return false;
    }

    window.PalmPlayCaptcha = {
        isRequired,
        mount,
        getToken,
        reset,
        requireTokenOrToast
    };
})();
