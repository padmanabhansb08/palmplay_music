/**
 * PalmPlay PWA — service worker registration and install prompt
 */
(function () {
    function getPwaBase() {
        if (window.PalmPlayRoutes?.base) return window.PalmPlayRoutes.base;
        const p = window.location.pathname;
        if (p === '/app' || p.startsWith('/app/')) return '/app';
        if (p.includes('/pamplay-frontend')) return '/pamplay-frontend';
        return '/pamplay-frontend';
    }

    function wireManifestLink() {
        const base = getPwaBase();
        const href = base === '/app' ? '/pamplay-frontend/manifest.webmanifest' : `${base}/manifest.webmanifest`;
        let link = document.querySelector('link[rel="manifest"]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'manifest';
            document.head.appendChild(link);
        }
        link.href = href;

        let apple = document.querySelector('link[rel="apple-touch-icon"]');
        if (!apple) {
            apple = document.createElement('link');
            apple.rel = 'apple-touch-icon';
            document.head.appendChild(apple);
        }
        const iconBase = base === '/app' ? '/pamplay-frontend' : base;
        apple.href = `${iconBase}/assets/gallery/p1.png`;
    }

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;

        const base = getPwaBase();
        const swUrl = base === '/app' ? '/app/sw.js' : `${base}/sw.js`;
        const scope = base === '/app' ? '/app/' : `${base}/`;

        try {
            const reg = await navigator.serviceWorker.register(swUrl, { scope });
            console.log('PalmPlay SW registered', reg.scope);

            reg.addEventListener('updatefound', () => {
                const worker = reg.installing;
                if (!worker) return;
                worker.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                        if (typeof showToast === 'function') {
                            showToast('Update available — refresh to load', 'fa-sync');
                        }
                    }
                });
            });
        } catch (err) {
            console.warn('PalmPlay SW registration failed', err);
        }
    }

    function wireInstallPrompt() {
        let deferredPrompt = null;

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            showInstallBanner();
        });

        function showInstallBanner() {
            if (document.getElementById('pwa-install-banner')) return;
            const banner = document.createElement('div');
            banner.id = 'pwa-install-banner';
            banner.className = 'pwa-install-banner';
            banner.innerHTML = `
                <span><i class="fas fa-download"></i> Install PalmPlay for quick access</span>
                <div class="pwa-install-actions">
                    <button type="button" class="pwa-install-btn" id="pwa-install-accept">Install</button>
                    <button type="button" class="pwa-install-dismiss" id="pwa-install-dismiss" aria-label="Dismiss">×</button>
                </div>
            `;
            document.body.appendChild(banner);

            document.getElementById('pwa-install-dismiss')?.addEventListener('click', () => {
                banner.remove();
                deferredPrompt = null;
            });

            document.getElementById('pwa-install-accept')?.addEventListener('click', async () => {
                if (!deferredPrompt) return;
                deferredPrompt.prompt();
                await deferredPrompt.userChoice;
                deferredPrompt = null;
                banner.remove();
            });
        }

        window.addEventListener('appinstalled', () => {
            document.getElementById('pwa-install-banner')?.remove();
            if (typeof showToast === 'function') {
                showToast('PalmPlay installed!', 'fa-check-circle');
            }
        });
    }

    window.PalmPlayPWA = { register: registerServiceWorker, wireManifest: wireManifestLink };

    wireManifestLink();
    registerServiceWorker();
    wireInstallPrompt();
})();
