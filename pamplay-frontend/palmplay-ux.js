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
            const existingNp = document.getElementById('now-playing');
            if (existingNp && !document.getElementById('np-lyrics-panel')) {
                existingNp.remove();
            }
            if (!document.getElementById('now-playing')) {
                const np = document.createElement('div');
                np.id = 'now-playing';
                np.className = 'now-playing-panel';
                np.setAttribute('aria-hidden', 'true');
                np.innerHTML = `
                    <div class="np-bg-layer" id="np-bg-layer"></div>
                    <div class="np-content">
                        <div class="now-playing-header">
                            <button type="button" id="np-close" aria-label="Close"><i class="fas fa-chevron-down"></i></button>
                            <span class="np-header-label">NOW PLAYING</span>
                            <button type="button" id="np-queue" aria-label="Queue"><i class="fas fa-list-ul"></i></button>
                        </div>
                        
                        <div class="np-main-layout">
                            <div class="np-left-column">
                                <div class="now-playing-art" id="np-art"></div>
                                <div class="now-playing-meta">
                                    <p class="np-album" id="np-album"></p>
                                    <h2 id="np-title">—</h2>
                                    <p id="np-artist">—</p>
                                </div>
                            </div>
                            
                            <div class="np-right-column">
                                <div class="np-tabs">
                                    <button type="button" class="np-tab active" data-np-tab="song">Song</button>
                                    <button type="button" class="np-tab" data-np-tab="lyrics">Lyrics</button>
                                </div>
                                <div class="np-lyrics-panel" id="np-lyrics-panel" hidden>
                                    <div class="np-lyrics" id="np-lyrics">Lyrics appear here when available.</div>
                                </div>
                            </div>
                        </div>

                        <div class="now-playing-footer">
                            <div class="np-control-center">
                                <div class="np-actions">
                                    <button type="button" class="np-action-btn" id="np-like" aria-label="Like"><i class="far fa-heart"></i></button>
                                    <button type="button" class="np-action-btn" id="np-add-playlist" aria-label="Add to playlist"><i class="fas fa-plus"></i></button>
                                    <button type="button" class="np-action-btn" id="np-share" aria-label="Share"><i class="fas fa-share-alt"></i></button>
                                </div>
                                
                                <div class="np-playback-core">
                                    <div class="now-playing-controls">
                                        <button type="button" class="np-transport np-shuffle" id="np-shuffle" aria-label="Shuffle"><i class="fas fa-random"></i></button>
                                        <button type="button" class="np-transport np-prev" aria-label="Previous"><i class="fas fa-step-backward"></i></button>
                                        <div class="play-pause-btn np-play" aria-label="Play"><i class="fas fa-play"></i></div>
                                        <button type="button" class="np-transport np-next" aria-label="Next"><i class="fas fa-step-forward"></i></button>
                                        <button type="button" class="np-transport np-repeat" id="np-repeat" aria-label="Repeat"><i class="fas fa-redo-alt"></i></button>
                                    </div>
                                    <div class="np-progress-row">
                                        <span class="np-time" id="np-time-current">0:00</span>
                                        <div class="np-progress-bar" id="np-progress-bar" role="slider" aria-label="Seek">
                                            <div class="np-progress-fill" id="np-progress-fill"></div>
                                        </div>
                                        <span class="np-time" id="np-time-total">0:00</span>
                                    </div>
                                </div>
                                
                                <div class="np-footer-right"></div>
                            </div>
                        </div>
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
                        <div class="queue-header-actions">
                            <button type="button" id="queue-clear" aria-label="Clear upcoming">Clear</button>
                            <button type="button" id="queue-close" aria-label="Close queue"><i class="fas fa-times"></i></button>
                        </div>
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
                const header = document.querySelector('.top-header');
                if (header) header.prepend(toggle);
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
            const routes = window.PalmPlayRoutes;
            const isExplorePage = routes?.isExplorePage?.() ?? window.location.pathname.includes('explore');
            const isHomePage = routes?.isHomePage?.() ?? window.location.pathname.includes('home');

            document.querySelectorAll('[data-bottom-nav]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const key = btn.dataset.bottomNav;
                    this.activateBottomNav(key);

                    if (key === 'home') {
                        if (!isHomePage) {
                            window.location.href = routes?.page('home') || 'home.html';
                            return;
                        }
                        window.PalmPlayNav?.go('home');
                        return;
                    }
                    if (key === 'explore') {
                        if (!isExplorePage) {
                            window.location.href = routes?.page('explore') || 'explore.html';
                            return;
                        }
                        window.PalmPlayNav?.go('explore');
                        return;
                    }
                    if (key === 'discover') {
                        if (!isExplorePage && !isHomePage) {
                            window.location.href = routes?.page('discover') || 'explore.html#discover';
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

        _npLyricsKey: '',

        bindNowPlaying() {
            const panel = document.getElementById('now-playing');
            const open = () => {
                const ctx = window.getCurrentPalmPlayTrack?.();
                if (!ctx?.track) {
                    if (typeof showToast === 'function') showToast('Play a song first', 'fa-play');
                    return;
                }
                this.syncNowPlaying();
                panel?.classList.add('open');
                panel?.setAttribute('aria-hidden', 'false');
                document.body.classList.add('now-playing-open');
                this.nowPlayingOpen = true;
            };
            const close = () => {
                panel?.classList.remove('open');
                panel?.setAttribute('aria-hidden', 'true');
                document.body.classList.remove('now-playing-open');
                this.nowPlayingOpen = false;
            };

            window.openNowPlaying = open;
            window.closeNowPlaying = close;

            document.getElementById('player-track-info')?.addEventListener('click', (e) => {
                if (!e.target.closest('.player-like-btn, .control-btn, #share-track-btn')) open();
            });
            document.querySelector('.album-art')?.addEventListener('click', open);

            document.getElementById('np-close')?.addEventListener('click', close);
            document.getElementById('np-queue')?.addEventListener('click', () => {
                close();
                this.toggleQueue(true);
            });

            document.querySelector('.np-prev')?.addEventListener('click', () => document.querySelector('.fa-step-backward')?.click());
            document.querySelector('.np-next')?.addEventListener('click', () => document.querySelector('.fa-step-forward')?.click());
            document.querySelector('.np-play')?.addEventListener('click', () => document.querySelector('.play-pause-btn')?.click());

            document.getElementById('np-shuffle')?.addEventListener('click', () => document.querySelector('.fa-random')?.click());
            document.getElementById('np-repeat')?.addEventListener('click', () => document.querySelector('.fa-redo-alt')?.click());

            document.getElementById('np-like')?.addEventListener('click', () => document.querySelector('.player-like-btn')?.click());
            document.getElementById('np-add-playlist')?.addEventListener('click', () => {
                const ctx = window.getCurrentPalmPlayTrack?.();
                if (ctx?.track && window.showAddToPlaylistPicker) window.showAddToPlaylistPicker(ctx.track);
            });
            document.getElementById('np-share')?.addEventListener('click', () => window.shareCurrentTrack?.());

            document.querySelectorAll('.np-tab').forEach((tab) => {
                tab.addEventListener('click', () => {
                    document.querySelectorAll('.np-tab').forEach((t) => t.classList.remove('active'));
                    tab.classList.add('active');
                    const isLyrics = tab.dataset.npTab === 'lyrics';
                    const lyricsPanel = document.getElementById('np-lyrics-panel');
                    if (lyricsPanel) lyricsPanel.hidden = !isLyrics;
                    if (isLyrics) this.loadNowPlayingLyrics();
                });
            });

            const npBar = document.getElementById('np-progress-bar');
            npBar?.addEventListener('click', (e) => {
                const audioEl = document.getElementById('palmplay-audio');
                if (!audioEl?.duration) return;
                const rect = npBar.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                audioEl.currentTime = pct * audioEl.duration;
            });

            panel?.addEventListener('click', (e) => {
                if (e.target === panel) close();
            });

            window.addEventListener('palmplay:trackchange', () => {
                this.syncNowPlaying();
                if (this.nowPlayingOpen) this.loadNowPlayingLyrics(true);
            });
            window.addEventListener('palmplay:timeupdate', (e) => this.syncNowPlayingProgress(e.detail));
        },

        syncNowPlayingProgress(detail) {
            if (!detail?.duration) return;
            const fill = document.getElementById('np-progress-fill');
            const cur = document.getElementById('np-time-current');
            const tot = document.getElementById('np-time-total');
            if (fill) fill.style.width = `${detail.progress || 0}%`;
            if (cur) cur.textContent = this.formatTime(detail.current || 0);
            if (tot) tot.textContent = this.formatTime(detail.duration || 0);
        },

        formatTime(sec) {
            if (!sec || !isFinite(sec)) return '0:00';
            const m = Math.floor(sec / 60);
            const s = Math.floor(sec % 60);
            return `${m}:${s.toString().padStart(2, '0')}`;
        },

        async loadNowPlayingLyrics(force) {
            const ctx = window.getCurrentPalmPlayTrack?.();
            const box = document.getElementById('np-lyrics');
            if (!box || !ctx?.track) return;

            const key = `${ctx.track.name}|${ctx.track.artist}`;
            if (!force && key === this._npLyricsKey && box.dataset.loaded === '1') return;
            this._npLyricsKey = key;
            box.dataset.loaded = '0';
            box.innerHTML = '<p class="np-lyrics-loading"><i class="fas fa-spinner fa-spin"></i> Loading lyrics…</p>';

            const text = await window.fetchTrackLyrics?.(ctx.track.name, ctx.track.artist, ctx.track.duration);
            if (key !== this._npLyricsKey) return;

            if (text) {
                box.textContent = text;
                box.dataset.loaded = '1';
            } else {
                box.innerHTML = '<p class="np-lyrics-empty">No lyrics found for this track.</p>';
            }
        },

        syncNowPlaying() {
            const ctx = window.getCurrentPalmPlayTrack?.();
            const name = document.querySelector('.track-name')?.textContent;
            const artist = document.querySelector('.artist-name')?.textContent;
            const art = document.querySelector('.album-art')?.style.backgroundImage;

            if (name && name !== 'Select a song') {
                const t = document.getElementById('np-title');
                const a = document.getElementById('np-artist');
                const ar = document.getElementById('np-art');
                const alb = document.getElementById('np-album');
                const bgLayer = document.getElementById('np-bg-layer');
                
                if (t) t.textContent = name;
                if (a) a.textContent = artist;
                if (ar && art) ar.style.backgroundImage = art;
                if (bgLayer && art) bgLayer.style.backgroundImage = art;

                // Update hero banner art thumbnail + blur background
                const heroArtEl = document.getElementById('home-hero-art');
                const heroBlurEl = document.getElementById('home-hero-blur');
                if (heroArtEl && art) {
                    heroArtEl.style.backgroundImage = art;
                    heroArtEl.style.display = 'block';
                }
                if (heroBlurEl && art) {
                    heroBlurEl.style.backgroundImage = art;
                    heroBlurEl.style.filter = 'blur(40px) saturate(180%)';
                    heroBlurEl.style.opacity = '0.7';
                    heroBlurEl.style.transform = 'scale(1.15)';
                }
                
                if (alb && ctx?.track?.album) {
                    const albumLabel = ctx.track.album;
                    // Hide if it's "Stream", "Single", or perfectly matches the track name (redundant)
                    if (albumLabel && albumLabel !== 'Stream' && albumLabel !== 'Single' && albumLabel.toLowerCase() !== name.toLowerCase()) {
                        alb.textContent = albumLabel;
                        alb.style.display = 'block';
                    } else {
                        alb.style.display = 'none';
                    }
                } else if (alb) {
                    alb.style.display = 'none';
                }
            }

            const icon = document.querySelector('.np-play i');
            const main = document.querySelector('.play-pause-btn i');
            if (icon && main) icon.className = main.className;

            const heart = document.querySelector('.player-like-btn i');
            const npHeart = document.querySelector('#np-like i');
            if (heart && npHeart) {
                npHeart.className = heart.className;
                npHeart.style.color = heart.style.color || '';
            }

            document.getElementById('np-shuffle')?.classList.toggle('active', !!ctx?.isShuffle);
            document.getElementById('np-repeat')?.classList.toggle('active', (ctx?.repeatMode || 0) > 0);
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
            document.getElementById('queue-clear')?.addEventListener('click', () => {
                if (window.PalmPlayQueue?.clearUpcoming) {
                    window.PalmPlayQueue.clearUpcoming();
                    this.renderQueue();
                }
            });
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
                <div class="queue-item ${item.isCurrent ? 'playing' : ''}" data-q-pos="${item.qPos ?? i}" data-q-pl="${item.plIndex}" data-q-ti="${item.tIndex}" draggable="${item.isCurrent ? 'false' : 'true'}">
                    <div class="queue-item-art" style="background-image:url(${item.art})"></div>
                    <div class="queue-item-info">
                        <div class="queue-item-name">${item.name}</div>
                        <div class="queue-item-artist">${item.artist}</div>
                    </div>
                    ${item.isCurrent ? '<span class="queue-now-label">Now</span>' : '<button type="button" class="queue-remove-btn" aria-label="Remove from queue"><i class="fas fa-times"></i></button>'}
                </div>
            `).join('');
            list.querySelectorAll('.queue-item').forEach((el) => {
                el.onclick = () => {
                    const pl = parseInt(el.dataset.qPl, 10);
                    const ti = parseInt(el.dataset.qTi, 10);
                    if (window.PalmPlayQueue.playAt) window.PalmPlayQueue.playAt(pl, ti);
                };
                const remove = el.querySelector('.queue-remove-btn');
                if (remove) {
                    remove.onclick = (e) => {
                        e.stopPropagation();
                        const pos = parseInt(el.dataset.qPos, 10);
                        if (window.PalmPlayQueue?.removeAt?.(pos)) this.renderQueue();
                    };
                }
                if (el.getAttribute('draggable') === 'true') {
                    el.addEventListener('dragstart', (e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', el.dataset.qPos || '');
                        el.classList.add('dragging');
                    });
                    el.addEventListener('dragend', () => el.classList.remove('dragging'));
                    el.addEventListener('dragover', (e) => {
                        e.preventDefault();
                        el.classList.add('drag-over');
                    });
                    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
                    el.addEventListener('drop', (e) => {
                        e.preventDefault();
                        el.classList.remove('drag-over');
                        const fromPos = parseInt(e.dataTransfer.getData('text/plain'), 10);
                        const toPos = parseInt(el.dataset.qPos, 10);
                        if (Number.isNaN(fromPos) || Number.isNaN(toPos)) return;
                        if (window.PalmPlayQueue?.reorder?.(fromPos, toPos)) this.renderQueue();
                    });
                }
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
            const routes = window.PalmPlayRoutes;
            if (routes?.isExplorePage?.()) {
                const active = document.querySelector('.nav-item.active');
                const label = active?.textContent.trim().toLowerCase();
                if (label === 'search') {
                    this.activateBottomNav('discover');
                } else if (label === 'explore') {
                    this.activateBottomNav('explore');
                }
            } else if (routes?.isHomePage?.()) {
                this.activateBottomNav('home');
            }
        }
    };

    window.PalmPlayUX = PalmPlayUX;

    document.addEventListener('DOMContentLoaded', () => {
        PalmPlayUX.init();
    });
})();
