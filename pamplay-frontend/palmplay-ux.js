/**
 * PalmPlay UX layer — mobile nav, now playing, queue, settings, transitions
 */
(function () {
    const PalmPlayUX = {
        queueOpen: false,
        nowPlayingOpen: false,

        init() {
            this.injectShellIfMissing();
            this.bindSidebar();
            this.bindBottomNav();
            this.bindNowPlaying();
            this.bindQueue();
            this.bindSettings();
            this.bindHistory();
            this.showKeyboardHint();
            this.defaultRoute();
        },

        injectShellIfMissing() {
            if (!document.getElementById('bottom-nav')) {
                const nav = document.createElement('nav');
                nav.id = 'bottom-nav';
                nav.className = 'bottom-nav';
                nav.innerHTML = `
                    <button type="button" class="bottom-nav-item" data-bottom-nav="home" aria-label="Home">
                        <i class="fas fa-home"></i><span>Home</span>
                    </button>
                    <button type="button" class="bottom-nav-item" data-bottom-nav="discover" aria-label="Discover">
                        <i class="fas fa-search"></i><span>Discover</span>
                    </button>
                    <button type="button" class="bottom-nav-item" data-bottom-nav="explore" aria-label="Explore">
                        <i class="fas fa-compass"></i><span>Explore</span>
                    </button>
                    <button type="button" class="bottom-nav-item" data-bottom-nav="library" aria-label="Library">
                        <i class="fas fa-heart"></i><span>Library</span>
                    </button>
                `;
                document.getElementById('app').appendChild(nav);
            }
            if (!document.getElementById('sidebar-overlay')) {
                const ov = document.createElement('div');
                ov.id = 'sidebar-overlay';
                ov.className = 'sidebar-overlay';
                document.body.appendChild(ov);
            }
            if (!document.getElementById('now-playing')) {
                const np = document.createElement('div');
                np.id = 'now-playing';
                np.className = 'now-playing-panel';
                np.setAttribute('aria-hidden', 'true');
                np.innerHTML = `
                    <div class="now-playing-header">
                        <button type="button" id="np-close" aria-label="Close"><i class="fas fa-chevron-down"></i></button>
                        <span style="font-size:12px;color:var(--text-subdued);font-weight:600;letter-spacing:0.08em;">NOW PLAYING</span>
                        <button type="button" id="np-queue" aria-label="Queue"><i class="fas fa-list-ul"></i></button>
                    </div>
                    <div class="now-playing-art" id="np-art"></div>
                    <div class="now-playing-meta">
                        <h2 id="np-title">—</h2>
                        <p id="np-artist">—</p>
                    </div>
                    <div class="now-playing-controls">
                        <i class="fas fa-step-backward np-prev" style="font-size:22px;cursor:pointer;"></i>
                        <div class="play-pause-btn np-play"><i class="fas fa-play"></i></div>
                        <i class="fas fa-step-forward np-next" style="font-size:22px;cursor:pointer;"></i>
                    </div>
                `;
                document.body.appendChild(np);
            }
            if (!document.getElementById('queue-drawer')) {
                const q = document.createElement('div');
                q.id = 'queue-drawer';
                q.className = 'queue-drawer';
                q.innerHTML = `
                    <div class="queue-drawer-header">
                        <h3>Up next</h3>
                        <button type="button" id="queue-close" aria-label="Close queue"><i class="fas fa-times"></i></button>
                    </div>
                    <div class="queue-list" id="queue-list"></div>
                `;
                document.body.appendChild(q);
            }
        },

        bindSidebar() {
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.getElementById('sidebar-overlay');
            let toggle = document.getElementById('sidebar-toggle');
            if (!toggle) {
                toggle = document.createElement('button');
                toggle.id = 'sidebar-toggle';
                toggle.className = 'sidebar-toggle control-btn';
                toggle.setAttribute('aria-label', 'Menu');
                toggle.innerHTML = '<i class="fas fa-bars"></i>';
                const navControls = document.querySelector('.nav-controls');
                if (navControls) navControls.prepend(toggle);
            }
            const close = () => {
                sidebar?.classList.remove('open');
                overlay?.classList.remove('visible');
            };
            toggle.onclick = () => {
                sidebar?.classList.toggle('open');
                overlay?.classList.toggle('visible', sidebar?.classList.contains('open'));
            };
            overlay?.addEventListener('click', close);
        },

        activateBottomNav(key) {
            document.querySelectorAll('.bottom-nav-item').forEach((b) => {
                b.classList.toggle('active', b.dataset.bottomNav === key);
            });
        },

        syncSidebarNav(label) {
            document.querySelectorAll('.nav-item').forEach((l) => {
                const t = l.textContent.trim().toLowerCase();
                l.classList.toggle('active', t === label);
            });
        },

        bindBottomNav() {
            const isExplorePage = window.location.pathname.includes('explore.html');
            const isHomePage = window.location.pathname.includes('home.html');

            document.querySelectorAll('[data-bottom-nav]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const key = btn.dataset.bottomNav;
                    this.activateBottomNav(key);

                    if (key === 'home') {
                        if (!isHomePage) {
                            window.location.href = 'home.html';
                            return;
                        }
                        window.PalmPlayNav?.go('home');
                        return;
                    }
                    if (key === 'explore') {
                        if (!isExplorePage) {
                            window.location.href = 'explore.html';
                            return;
                        }
                        window.PalmPlayNav?.go('explore');
                        return;
                    }
                    if (key === 'discover') {
                        if (!isExplorePage && !isHomePage) {
                            window.location.href = 'explore.html#discover';
                            return;
                        }
                        window.PalmPlayNav?.go('search');
                        return;
                    }
                    if (key === 'library') {
                        document.querySelector('.sidebar')?.classList.add('open');
                        document.getElementById('sidebar-overlay')?.classList.add('visible');
                        const lib = document.querySelector('.library-header');
                        if (lib) lib.scrollIntoView({ behavior: 'smooth' });
                        document.querySelector('.playlist-item')?.click();
                    }
                });
            });
        },

        bindNowPlaying() {
            const panel = document.getElementById('now-playing');
            const open = () => {
                this.syncNowPlaying();
                panel?.classList.add('open');
                panel?.setAttribute('aria-hidden', 'false');
                this.nowPlayingOpen = true;
            };
            const close = () => {
                panel?.classList.remove('open');
                panel?.setAttribute('aria-hidden', 'true');
                this.nowPlayingOpen = false;
            };
            document.getElementById('player-track-info')?.addEventListener('click', open);
            document.querySelector('.track-info')?.addEventListener('click', (e) => {
                if (!e.target.closest('.player-like-btn, .control-btn')) open();
            });
            document.getElementById('np-close')?.addEventListener('click', close);
            document.getElementById('np-queue')?.addEventListener('click', () => {
                close();
                this.toggleQueue(true);
            });
            document.querySelector('.np-prev')?.addEventListener('click', () => document.querySelector('.fa-step-backward')?.click());
            document.querySelector('.np-next')?.addEventListener('click', () => document.querySelector('.fa-step-forward')?.click());
            document.querySelector('.np-play')?.addEventListener('click', () => document.querySelector('.play-pause-btn')?.click());
            panel?.addEventListener('click', (e) => {
                if (e.target === panel) close();
            });
            window.addEventListener('palmplay:trackchange', () => this.syncNowPlaying());
        },

        syncNowPlaying() {
            const name = document.querySelector('.track-name')?.textContent;
            const artist = document.querySelector('.artist-name')?.textContent;
            const art = document.querySelector('.album-art')?.style.backgroundImage;
            if (name && name !== 'Select a song') {
                const t = document.getElementById('np-title');
                const a = document.getElementById('np-artist');
                const ar = document.getElementById('np-art');
                if (t) t.textContent = name;
                if (a) a.textContent = artist;
                if (ar && art) ar.style.backgroundImage = art;
            }
            const icon = document.querySelector('.np-play i');
            const main = document.querySelector('.play-pause-btn i');
            if (icon && main) icon.className = main.className;
        },

        bindQueue() {
            const drawer = document.getElementById('queue-drawer');
            const open = () => {
                this.renderQueue();
                drawer?.classList.add('open');
                this.queueOpen = true;
                document.getElementById('queue-btn')?.classList.add('active');
            };
            const close = () => {
                drawer?.classList.remove('open');
                this.queueOpen = false;
                document.getElementById('queue-btn')?.classList.remove('active');
            };
            document.getElementById('queue-btn')?.addEventListener('click', () => this.toggleQueue());
            document.getElementById('queue-close')?.addEventListener('click', close);
            window.addEventListener('palmplay:trackchange', () => {
                if (this.queueOpen) this.renderQueue();
            });
            window.toggleQueue = (force) => this.toggleQueue(force);
        },

        toggleQueue(force) {
            const drawer = document.getElementById('queue-drawer');
            if (force === true || !drawer?.classList.contains('open')) {
                this.renderQueue();
                drawer?.classList.add('open');
                this.queueOpen = true;
                document.getElementById('queue-btn')?.classList.add('active');
            } else {
                drawer?.classList.remove('open');
                this.queueOpen = false;
                document.getElementById('queue-btn')?.classList.remove('active');
            }
        },

        renderQueue() {
            const list = document.getElementById('queue-list');
            if (!list || !window.PalmPlayQueue) return;
            const items = window.PalmPlayQueue.getUpNext();
            if (!items.length) {
                list.innerHTML = '<p class="queue-empty">Play a song to build your queue.</p>';
                return;
            }
            list.innerHTML = items.map((item, i) => `
                <div class="queue-item ${item.isCurrent ? 'playing' : ''}" data-q-pl="${item.plIndex}" data-q-ti="${item.tIndex}">
                    <div class="queue-item-art" style="background-image:url(${item.art})"></div>
                    <div class="queue-item-info">
                        <div class="queue-item-name">${item.name}</div>
                        <div class="queue-item-artist">${item.artist}</div>
                    </div>
                </div>
            `).join('');
            list.querySelectorAll('.queue-item').forEach((el) => {
                el.onclick = () => {
                    const pl = parseInt(el.dataset.qPl, 10);
                    const ti = parseInt(el.dataset.qTi, 10);
                    if (window.PalmPlayQueue.playAt) window.PalmPlayQueue.playAt(pl, ti);
                };
            });
        },

        bindSettings() {
            const wrap = document.querySelector('.user-controls');
            if (!wrap || document.getElementById('settings-btn')) return;
            const gesture = document.getElementById('gesture-toggle');
            if (gesture) gesture.style.display = 'none';

            const btn = document.createElement('button');
            btn.id = 'settings-btn';
            btn.className = 'control-btn';
            btn.type = 'button';
            btn.setAttribute('aria-label', 'Settings');
            btn.innerHTML = '<i class="fas fa-sliders-h"></i>';

            const pop = document.createElement('div');
            pop.className = 'settings-menu-wrap';
            pop.innerHTML = `
                <div class="settings-popover" id="settings-popover">
                    <button type="button" id="settings-gestures"><i class="fas fa-hand-paper"></i> Gestures</button>
                    <button type="button" id="settings-speed"><i class="fas fa-tachometer-alt"></i> Playback speed</button>
                </div>
            `;
            pop.prepend(btn);
            wrap.insertBefore(pop, wrap.firstChild);

            btn.onclick = (e) => {
                e.stopPropagation();
                document.getElementById('settings-popover')?.classList.toggle('open');
            };
            document.addEventListener('click', () => document.getElementById('settings-popover')?.classList.remove('open'));
            document.getElementById('settings-gestures')?.addEventListener('click', () => {
                if (typeof toggleGestureMode === 'function') toggleGestureMode();
            });
            document.getElementById('settings-speed')?.addEventListener('click', () => {
                document.getElementById('speed-btn')?.click();
            });
        },

        bindHistory() {
            window.PalmPlayNav = window.PalmPlayNav || { stack: [] };
        },

        showKeyboardHint() {
            if (sessionStorage.getItem('palmplay_kb_hint')) return;
            let hint = document.querySelector('.keyboard-hint');
            if (!hint) {
                hint = document.createElement('div');
                hint.className = 'keyboard-hint';
                hint.innerHTML = '<strong>Shortcuts</strong><br>Space play · ← → skip · ↑ ↓ volume · M mute · L like · Q queue';
                document.body.appendChild(hint);
            }
            setTimeout(() => {
                hint.classList.add('visible');
                sessionStorage.setItem('palmplay_kb_hint', '1');
                setTimeout(() => hint.classList.remove('visible'), 6000);
            }, 2000);
        },

        defaultRoute() {
            const hash = window.location.hash.replace('#', '');
            if (hash === 'discover' && window.PalmPlayNav) {
                setTimeout(() => window.PalmPlayNav.go('search'), 200);
                this.activateBottomNav('discover');
                return;
            }
            if (window.location.pathname.includes('explore.html')) {
                const active = document.querySelector('.nav-item.active');
                const label = active?.textContent.trim().toLowerCase();
                if (label === 'search') {
                    this.activateBottomNav('discover');
                } else if (label === 'explore') {
                    this.activateBottomNav('explore');
                }
            } else if (window.location.pathname.includes('home.html')) {
                this.activateBottomNav('home');
            }
        }
    };

    window.PalmPlayUX = PalmPlayUX;

    document.addEventListener('DOMContentLoaded', () => {
        PalmPlayUX.init();
    });
})();
