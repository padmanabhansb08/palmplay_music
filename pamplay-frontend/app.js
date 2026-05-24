
// API config (public: env-config.js; catalog URL: gitignored catalog-config.js only)
const _env = (typeof window !== 'undefined' && window.PALMPLAY_ENV) ? window.PALMPLAY_ENV : {};
const _catalog = (typeof window !== 'undefined' && window.PALMPLAY_CATALOG) ? window.PALMPLAY_CATALOG : {};
const AUDIUS_HOST = (_env.AUDIUS_API_HOST || 'https://discoveryprovider.audius.co').replace(/\/$/, '');
const AUDIUS_DISCOVERY_URL = _env.AUDIUS_DISCOVERY_URL || 'https://api.audius.co';
const AUDIUS_APP_NAME = _env.AUDIUS_APP_NAME || 'PalmPlay';
const MUSIC_CATALOG_API_BASE = (_catalog.apiBase || '').trim().replace(/\/$/, '');
const DEFAULT_ART_URL = _env.DEFAULT_ART_URL || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=300&h=300&fit=crop';
const SPOTIFY_CLIENT_ID = (_env.SPOTIFY_CLIENT_ID || 'c6177a0758d04a8582e59cd86bd18fbf').trim();
// Temporary kill switch: keep primary catalog during traffic spikes.
const DISABLE_AUDIUS_TRAFFIC_FALLBACK = String(_env.DISABLE_AUDIUS_TRAFFIC_FALLBACK ?? '1') === '1';

const TRAFFIC_LIMITS = {
    requestsPerMinute: Math.max(5, parseInt(_env.CATALOG_REQUESTS_PER_MINUTE, 10) || 30),
    maxConcurrent: Math.max(1, parseInt(_env.CATALOG_MAX_CONCURRENT, 10) || 4),
    fallbackMinutes: Math.max(1, parseInt(_env.CATALOG_FALLBACK_MINUTES, 10) || 15),
};

/** Switches catalog API → Audius when request rate or concurrency is high (friends-scale protection). */
const catalogTraffic = {
    inFlight: 0,
    _storageKey: 'palmplay_catalog_traffic',

    _load() {
        try {
            return JSON.parse(sessionStorage.getItem(this._storageKey) || '{}');
        } catch {
            return {};
        }
    },

    _save(s) {
        try {
            sessionStorage.setItem(this._storageKey, JSON.stringify(s));
        } catch (_) {}
    },

    _rollWindow(s, now) {
        if (!s.windowStart || now - s.windowStart > 60000) {
            return { count: 0, windowStart: now, fallbackUntil: s.fallbackUntil || 0 };
        }
        return s;
    },

    isAudiusFallbackActive() {
        const now = Date.now();
        const s = this._load();
        if (s.fallbackUntil && now < s.fallbackUntil) return true;
        if (this.inFlight >= TRAFFIC_LIMITS.maxConcurrent) return true;
        const rolled = this._rollWindow(s, now);
        return rolled.count >= TRAFFIC_LIMITS.requestsPerMinute;
    },

    _enterFallback(now) {
        const s = this._rollWindow(this._load(), now);
        s.fallbackUntil = now + TRAFFIC_LIMITS.fallbackMinutes * 60 * 1000;
        this._save(s);
        if (!sessionStorage.getItem('palmplay_fallback_toast')) {
            sessionStorage.setItem('palmplay_fallback_toast', '1');
            if (typeof showToast === 'function') {
                showToast('High demand — showing alternate picks for now', 'fa-bolt');
            }
        }
    },

    recordStart() {
        const now = Date.now();
        let s = this._rollWindow(this._load(), now);
        s.count = (s.count || 0) + 1;
        this.inFlight++;
        if (s.count >= TRAFFIC_LIMITS.requestsPerMinute || this.inFlight > TRAFFIC_LIMITS.maxConcurrent) {
            this._enterFallback(now);
        }
        this._save(s);
    },

    recordEnd() {
        this.inFlight = Math.max(0, this.inFlight - 1);
    },

    shouldUseAudius() {
        if (DISABLE_AUDIUS_TRAFFIC_FALLBACK) return false;
        return this.isAudiusFallbackActive();
    }
};

// Local Music Database & State
let playlists = []; // Array of { name: string, tracks: [] }
let likedSongs = []; // Array of liked track references
const state = {
    currentPlaylistIndex: -1,
    currentTrackIndex: -1,
    isPlaying: false,
    isShuffle: false,
    volume: 0.7,
    progress: 0,
    currentView: 'home', // 'home', 'search', 'playlist'
    activePlaylistId: null,
    isLiked: false,
    repeatMode: 0, // 0: None, 1: All, 2: One
    isMuted: false,
    playbackSpeed: 1.0,
    gestureMode: false,
    isBuffering: false,
    recentPlayback: [],
    queueIndices: [],
    queuePlaylistKey: null,
    queueExplicit: false
};

// Database Initialization
const db = new Dexie("PalmPlayDB");
db.version(2).stores({
    playlists: "++id, userId, name",
    tracks: "++id, userId, playlistId, name, artist"
});
db.version(3).stores({
    playlists: "++id, userId, name",
    tracks: "++id, userId, playlistId, name, artist",
    likedSongs: "++id, userId, trackName, artist"
}).upgrade(tx => {
    // Migration: nothing to migrate, new table
    console.log('Upgraded to DB version 3 with likedSongs store');
});
db.version(4).stores({
    playlists: "++id, userId, name",
    tracks: "++id, userId, playlistId, source, externalId, name, artist",
    likedSongs: "++id, userId, trackName, artist"
});

window.PalmPlayDB = db;

function getSavedUser() {
    if (window.PalmPlayAuth?.getUser) return window.PalmPlayAuth.getUser();
    try {
        return JSON.parse(localStorage.getItem('palmplay_user') || '{}');
    } catch (e) {
        return {};
    }
}

function getUserId(user) {
    const u = user || getSavedUser();
    return u.id || u.email || null;
}

function isUserLoggedIn() {
    const u = getSavedUser();
    return !!(u.isLoggedIn && getUserId(u));
}

/** @returns {typeof window.PalmPlayRoutes} */
function ppRoutes() {
    return window.PalmPlayRoutes;
}

// ─── Audio Engine with Crossfade Support ─────────────────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);

const audio = new Audio();
audio.id = 'palmplay-audio';
audio.crossOrigin = 'anonymous';
const currentSource = { node: null, gain: null, audio: audio };

const fadeAudio = new Audio();
fadeAudio.crossOrigin = 'anonymous';
const fadeSource = { node: null, gain: null, audio: fadeAudio };

const CROSSFADE_DURATION = 2.5; // seconds

function connectAudioNode(src) {
    if (src.node) { try { src.node.disconnect(); } catch(e){} }
    const mediaNode = audioCtx.createMediaElementSource(src.audio);
    const gainNode = audioCtx.createGain();
    mediaNode.connect(gainNode);
    gainNode.connect(masterGain);
    src.node = mediaNode;
    src.gain = gainNode;
}

// Initialise both sources
connectAudioNode(currentSource);
connectAudioNode(fadeSource);

function setMasterVolume(vol) {
    masterGain.gain.value = vol;
}
// ─────────────────────────────────────────────────────────────────────────────

const dynamicWishes = [
    "A Pleasant Morning", "A Happy Morning", "A Refreshing Day",
    "A Musical Afternoon", "A Serene Evening", "Lovely Evening",
    "Explore the Treat to Your Ears", "Dive into the Rhythm",
    "Your Musical Sanctuary", "Feel the Vibration",
    "Echoes of your Soul", "A Grand Welcome"
];

function getRandomWish() {
    return dynamicWishes[Math.floor(Math.random() * dynamicWishes.length)];
}

function getTimeGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Morning";
    if (hour < 18) return "Afternoon";
    return "Evening";
}

// Custom UI Helpers
function showToast(message, icon = 'fa-info-circle') {
    const container = document.getElementById('toast-container');

    // Limit to 3 toasts
    while (container.children.length >= 3) {
        container.children[0].remove();
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i class="fas ${icon}"></i> ${message}`;
    container.appendChild(toast);

    // Total wait time (visible time + fade time)
    const visibleTime = 2500;
    const fadeTime = 2000;

    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => {
            if (toast.parentElement) toast.remove();
        }, fadeTime);
    }, visibleTime);
}

function showModal(title, message, onConfirm, showInput = false, defaultValue = '') {
    const container = document.getElementById('modal-container');
    const titleEl = document.getElementById('modal-title');
    const messageEl = document.getElementById('modal-message');
    const inputEl = document.getElementById('modal-input');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');

    titleEl.textContent = title;
    messageEl.textContent = message;

    if (confirmBtn) confirmBtn.style.display = '';

    if (showInput) {
        inputEl.style.display = 'block';
        inputEl.value = defaultValue;
        setTimeout(() => inputEl.focus(), 100);
    } else {
        inputEl.style.display = 'none';
    }

    container.style.display = 'flex';

    confirmBtn.onclick = () => {
        const val = inputEl.value;
        onConfirm(val);
        container.style.display = 'none';
    };
    cancelBtn.onclick = () => {
        container.style.display = 'none';
    };
}

function parseDelimitedLine(line) {
    const parts = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if ((ch === ',' || ch === ';') && !inQuotes) {
            parts.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    parts.push(cur.trim());
    return parts.filter(Boolean);
}

function parseImportedTrackEntries(rawText) {
    const lines = String(rawText || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    const entries = [];
    const seen = new Set();

    const pushEntry = (name, artist = '') => {
        const cleanName = String(name || '').replace(/^\d+[\)\.\-\s]+/, '').trim();
        const cleanArtist = String(artist || '').trim();
        if (!cleanName || /^https?:\/\//i.test(cleanName)) return;
        const key = `${cleanName.toLowerCase()}::${cleanArtist.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({
            name: cleanName,
            artist: cleanArtist,
            query: `${cleanName} ${cleanArtist}`.trim()
        });
    };

    lines.forEach((line) => {
        const cols = parseDelimitedLine(line);
        if (cols.length >= 2) {
            const joined = cols.join(' ').toLowerCase();
            if (/(track|title|song).*(artist)|(artist).*(track|title|song)/.test(joined) && cols.length <= 4) return;
            if (/^#?$/.test(cols[0]) || /^\d+$/.test(cols[0])) cols.shift();
            if (cols.length >= 2) {
                pushEntry(cols[0], cols[1]);
                return;
            }
        }

        if (line.includes(' - ')) {
            const parts = line.split(' - ').map(s => s.trim()).filter(Boolean);
            if (parts.length >= 2) {
                pushEntry(parts[0], parts[1]);
                return;
            }
        }
        pushEntry(line, '');
    });

    return entries;
}

function randomToken(size = 64) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += chars[bytes[i] % chars.length];
    }
    return out;
}

function base64UrlFromBytes(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function pkceChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64UrlFromBytes(new Uint8Array(digest));
}

// Adaptive Ambient Light logic
function initAtmosphere() {
    const orbs = [
        document.getElementById('orb-1'),
        document.getElementById('orb-2'),
        document.getElementById('orb-3')
    ];

    window.addEventListener('mousemove', (e) => {
        const x = (e.clientX / window.innerWidth) - 0.5;
        const y = (e.clientY / window.innerHeight) - 0.5;

        orbs.forEach((orb, i) => {
            const factor = (i + 1) * 20;
            orb.style.transform = `translate(${x * factor}px, ${y * factor}px)`;
        });
    });
}

function toggleGestureMode() {
    state.gestureMode = !state.gestureMode;
    const btn = document.getElementById('gesture-toggle');
    const icon = btn.querySelector('i');
    const text = btn.querySelector('span');

    if (state.gestureMode) {
        btn.classList.add('active');
        icon.className = 'fas fa-hand-pointer';
        text.textContent = 'Gestures: ON';
        showToast('Gesture Mode Activated', 'fa-hand-sparkles');
    } else {
        btn.classList.remove('active');
        icon.className = 'fas fa-hand-paper';
        text.textContent = 'Gestures: OFF';
        showToast('Gesture Mode Deactivated', 'fa-ghost');
    }

    // Developer Note: Hook gesture library initialization/destruction here
    console.log(`Gesture Mode: ${state.gestureMode ? 'Enabled' : 'Disabled'}`);
}



document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const mainView = document.querySelector('.main-view');
    const header = document.querySelector('.top-header');
    const playBtn = document.querySelector('.play-pause-btn');
    const playIcon = playBtn.querySelector('i');
    const prevBtn = document.querySelector('.fa-step-backward');
    const nextBtn = document.querySelector('.fa-step-forward');
    const progressBar = document.querySelector('.progress-bar');
    const progressFill = document.querySelector('.progress-fill');
    const volumeBar = document.querySelector('.volume-bar');
    const volumeFill = document.querySelector('.volume-fill');
    const trackNameEl = document.querySelector('.track-name');
    const artistNameEl = document.querySelector('.artist-name');
    const albumArtEl = document.querySelector('.album-art');
    const timeCurrent = document.getElementById('time-current') || document.querySelector('.progress-time:first-child');
    const timeTotal = document.getElementById('time-total') || document.querySelector('.progress-time:last-child');
    const cardGrid = document.querySelector('.card-grid');
    const localTracksList = document.querySelector('#local-tracks-list');
    const greetingEl = document.querySelector('.greeting');
    const sectionTitleEl = document.querySelector('.section-title');
    const viewHeader = document.querySelector('#view-header');
    const searchContainer = document.querySelector('.search-container');
    const exploreHero = document.querySelector('.hero-section');
    const categoryChips = document.querySelector('.category-chips');

    // Add Music Elements
    const addMusicBtn = document.querySelector('#add-music-btn');
    const addOptions = document.querySelector('#add-options');
    const addFilesBtn = document.querySelector('#add-files-btn');
    const addFolderBtn = document.querySelector('#add-folder-btn');
    const fileInput = document.querySelector('#file-input');
    const folderInput = document.querySelector('#folder-input');

    function setHeaderSearchVisible(visible) {
        if (!searchContainer) return;
        if (visible) {
            searchContainer.style.removeProperty('display');
            searchContainer.style.display = 'flex';
            searchContainer.classList.add('header-search--always');
        } else {
            searchContainer.style.setProperty('display', 'none', 'important');
            searchContainer.classList.remove('header-search--always');
        }
    }

    // Global Dropdown Helpers
    window.handleProfileAction = (action) => {
        const dropdown = document.getElementById('profile-dropdown');
        if (dropdown) dropdown.classList.remove('active');

        switch (action) {
            case 'logout':
                showModal('Log Out', 'Are you sure you want to log out of PalmPlay?', async () => {
                    const savedUser = getSavedUser();
                    if (window.PalmPlayAuth?.signOut) {
                        await window.PalmPlayAuth.signOut();
                    } else {
                        localStorage.removeItem('palmplay_user');
                    }
                    if (savedUser.provider === 'local' && savedUser.email) {
                        const accounts = JSON.parse(localStorage.getItem('palmplay_accounts') || '[]');
                        const filtered = accounts.filter(a => a.email !== savedUser.email);
                        localStorage.setItem('palmplay_accounts', JSON.stringify(filtered));
                    }
                    window.location.reload();
                });
                break;
            case 'profile':
                showToast('Profile settings coming soon!', 'fa-user');
                break;
            case 'switch':
                showSwitchUserModal();
                break;
            case 'support':
                showToast('Contacting support...', 'fa-headset');
                break;
        }
    };

    function showSwitchUserModal() {
        const accounts = JSON.parse(localStorage.getItem('palmplay_accounts') || '[]');
        const container = document.getElementById('modal-container');
        const titleEl = document.getElementById('modal-title');
        const messageEl = document.getElementById('modal-message');
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');

        titleEl.textContent = "Switch Account";
        confirmBtn.style.display = 'none'; // We'll use our own list
        cancelBtn.textContent = "Cancel";

        const closeModal = () => {
            container.style.display = 'none';
            confirmBtn.style.display = 'block'; // Reset for other modals
        };

        cancelBtn.onclick = closeModal;

        let listHtml = `<div style="display:flex; flex-direction:column; gap:12px; margin-top:20px; text-align:left;">`;
        accounts.forEach(acc => {
            listHtml += `
                <div class="dropdown-item" onclick="switchAccount('${acc.email}')" style="background:rgba(255,255,255,0.05); padding:16px; border:1px solid rgba(255,255,255,0.1);">
                    <img src="https://ui-avatars.com/api/?name=${acc.name}&background=FF0000&color=fff" style="width:32px; border-radius:50%; margin-right:12px;">
                    <div>
                        <div style="font-weight:700; color:white;">${acc.name}</div>
                        <div style="font-size:12px; opacity:0.6;">${acc.email}</div>
                    </div>
                </div>
            `;
        });
        listHtml += `
            <div class="dropdown-item" onclick="window.PalmPlayRoutes.go('login')" style="border: 1px dashed rgba(255,255,255,0.2); justify-content:center; padding:16px;">
                <i class="fas fa-user-plus"></i> Add New Account
            </div>
        </div>`;

        messageEl.innerHTML = listHtml;
        container.style.display = 'flex';
    }

    window.switchAccount = (email) => {
        const accounts = JSON.parse(localStorage.getItem('palmplay_accounts') || '[]');
        const user = accounts.find(a => a.email === email);
        if (user) {
            localStorage.setItem('palmplay_user', JSON.stringify(user));
            window.location.reload();
        }
    };

    window.renamePlaylist = async (index) => {
        const pl = playlists[index];

        showModal('Rename Folder', 'Choose a new name for your collection:', async (newName) => {
            if (newName && newName.trim() !== "" && newName !== pl.name) {
                try {
                    await db.playlists.update(pl.id, { name: newName.trim() });
                    pl.name = newName.trim();
                    showToast(`Renamed to "${newName}"`, 'fa-edit');
                    renderSidebar();
                    showPlaylist(index); // Refresh view
                    window.PalmPlaySync?.pushPlaylist?.(pl).catch((e) => console.warn('Cloud rename', e));
                } catch (err) {
                    console.error("Rename failed:", err);
                    showToast("Failed to rename", 'fa-exclamation-triangle');
                }
            }
        }, true, pl.name);
    };

    window.deletePlaylist = (index) => {
        const pl = playlists[index];
        showModal('Delete Folder', `Are you sure you want to delete "${pl.name}"? This will remove all songs inside it.`, async () => {
            try {
                const row = await db.playlists.get(pl.id);
                if (row?.cloudId) {
                    await window.PalmPlaySync?.deleteCloudPlaylist?.({ cloudId: row.cloudId });
                }
                await db.tracks.where('playlistId').equals(pl.id).delete();
                await db.playlists.delete(pl.id);

                playlists.splice(index, 1);
                showToast(`Deleted "${pl.name}"`, 'fa-trash');
                renderSidebar();
                renderHome(); // Back to main view
            } catch (err) {
                console.error("Delete failed:", err);
                showToast("Failed to delete", 'fa-exclamation-triangle');
            }
        });
    };

    // Close dropdowns on outside click
    document.addEventListener('click', () => {
        const dropdown = document.getElementById('profile-dropdown');
        if (dropdown) dropdown.classList.remove('active');
    });

    // Initialization
    function skeletonCardGrid(count = 6) {
        return `<div class="skeleton-grid">${Array(count).fill(0).map(() => `
            <div class="skeleton-card">
                <div class="skeleton-shimmer skeleton-card-art"></div>
                <div class="skeleton-shimmer skeleton-card-line"></div>
                <div class="skeleton-shimmer skeleton-card-line short"></div>
            </div>`).join('')}</div>`;
    }

    window.skeletonCardGrid = skeletonCardGrid;

    const navHistory = [];

    window.PalmPlayNav = {
        push(view) {
            if (navHistory[navHistory.length - 1] !== view) navHistory.push(view);
        },
        back() {
            if (navHistory.length > 1) {
                navHistory.pop();
                const prev = navHistory[navHistory.length - 1];
                this.go(prev, true);
                return;
            }
            if (state.currentView === 'artist' || state.currentView === 'album') {
                this.go('search', true);
                return;
            }
            if (state.currentView === 'language') {
                this.go('search', true);
                return;
            }
            this.go(ppRoutes().isExplorePage() ? 'search' : 'home', true);
        },
        go(view, fromHistory = false) {
            if (!fromHistory) this.push(view);
            const onExplore = ppRoutes().isExplorePage();

            if (view === 'search') {
                state.currentView = 'search';
                setHeaderSearchVisible(true);
                if (viewHeader) viewHeader.style.display = 'none';
                if (exploreHero) exploreHero.style.display = 'none';
                if (categoryChips) categoryChips.style.display = 'none';
                greetingEl && (greetingEl.style.display = 'none');
                renderSearch();
                window.PalmPlayUX?.activateBottomNav?.('discover');
                return;
            }
            if (view === 'explore' && onExplore) {
                state.currentView = 'explore';
                setHeaderSearchVisible(true);
                if (viewHeader) viewHeader.style.display = 'block';
                if (exploreHero) exploreHero.style.display = 'flex';
                if (categoryChips) categoryChips.style.display = 'flex';
                greetingEl && (greetingEl.style.display = 'block');
                const chip = document.querySelector('.chip.active');
                renderExplore(chip?.getAttribute('data-genre') || 'Trending');
                window.PalmPlayUX?.activateBottomNav?.('explore');
                return;
            }
            state.currentView = 'home';
            if (!onExplore) setHeaderSearchVisible(false);
            if (viewHeader) viewHeader.style.display = 'block';
            renderHome();
            window.PalmPlayUX?.activateBottomNav?.('home');
        }
    };

    window.PalmPlayQueue = {
        getUpNext() {
            if (state.currentPlaylistIndex < 0) return [];
            const pl = playlists[state.currentPlaylistIndex];
            if (!pl?.tracks?.length) return [];
            const current = state.currentTrackIndex;
            ensureQueueForCurrentTrack(state.currentPlaylistIndex, current, { keepExisting: true });
            const indices = (state.queueIndices?.length ? state.queueIndices : buildDefaultQueueIndices(state.currentPlaylistIndex, current))
                .filter((ti) => ti >= current && ti < pl.tracks.length);
            return indices.map((ti, pos) => {
                const t = pl.tracks[ti];
                return ({
                plIndex: state.currentPlaylistIndex,
                qPos: pos,
                tIndex: ti,
                name: t.name,
                artist: t.artist,
                art: t.art || DEFAULT_ART_URL,
                isCurrent: pos === 0
                });
            });
        },
        playAt(plIndex, tIndex) {
            if (plIndex !== state.currentPlaylistIndex) {
                playTrack(plIndex, tIndex);
                return;
            }
            const pos = state.queueIndices.indexOf(tIndex);
            if (pos > 0) {
                setQueueIndices(plIndex, tIndex, state.queueIndices.slice(pos), true);
                playTrack(plIndex, tIndex, { fromQueue: true });
                return;
            }
            playTrack(plIndex, tIndex, { fromQueue: true });
        },
        removeAt(queuePos) {
            if (state.currentPlaylistIndex < 0) return false;
            if (queuePos <= 0) return false; // don't remove currently playing item
            const next = state.queueIndices.filter((_, i) => i !== queuePos);
            setQueueIndices(state.currentPlaylistIndex, state.currentTrackIndex, next, true);
            return true;
        },
        clearUpcoming() {
            if (state.currentPlaylistIndex < 0) return;
            setQueueIndices(state.currentPlaylistIndex, state.currentTrackIndex, [state.currentTrackIndex], true);
        },
        reorder(fromPos, toPos) {
            if (state.currentPlaylistIndex < 0) return false;
            const len = state.queueIndices.length;
            if (fromPos <= 0 || toPos <= 0 || fromPos >= len || toPos >= len) return false;
            const copy = state.queueIndices.slice();
            const [moved] = copy.splice(fromPos, 1);
            copy.splice(toPos, 0, moved);
            setQueueIndices(state.currentPlaylistIndex, state.currentTrackIndex, copy, true);
            return true;
        }
    };

    function routeInitialView() {
        if (ppRoutes().isExplorePage()) {
            const discover = !window.location.hash || window.location.hash === '#discover';
            if (discover) window.PalmPlayNav.go('search', true);
            else window.PalmPlayNav.go('explore', true);
        } else {
            renderHome();
        }
    }

    function setupMediaSession() {
        if (!('mediaSession' in navigator)) return;

        const safeHandler = (action, fn) => {
            try {
                navigator.mediaSession.setActionHandler(action, fn);
            } catch (err) {
                console.warn('MediaSession action not supported:', action, err);
            }
        };

        safeHandler('play', () => {
            if (audio.src && !state.isPlaying) togglePlay();
        });
        safeHandler('pause', () => {
            if (state.isPlaying) togglePlay();
        });
        safeHandler('previoustrack', () => playPrev());
        safeHandler('nexttrack', () => playNext());
        safeHandler('seekbackward', (details) => {
            if (!audio.src || !audio.duration) return;
            const offset = details?.seekOffset ?? 10;
            audio.currentTime = Math.max(0, audio.currentTime - offset);
        });
        safeHandler('seekforward', (details) => {
            if (!audio.src || !audio.duration) return;
            const offset = details?.seekOffset ?? 10;
            audio.currentTime = Math.min(audio.duration, audio.currentTime + offset);
        });
    }

    function updateMediaSession(track) {
        if (!('mediaSession' in navigator)) return;

        if (!track || state.currentPlaylistIndex < 0) {
            try {
                navigator.mediaSession.metadata = null;
                navigator.mediaSession.playbackState = 'none';
            } catch (e) { /* ignore */ }
            return;
        }

        const art = track.art || DEFAULT_ART_URL;
        const artwork = [];
        if (art && !art.startsWith('data:')) {
            artwork.push({ src: art, sizes: '96x96', type: 'image/png' });
            artwork.push({ src: art, sizes: '256x256', type: 'image/png' });
            artwork.push({ src: art, sizes: '512x512', type: 'image/png' });
        }

        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.name || 'PalmPlay',
                artist: track.artist || 'Unknown artist',
                album: (track.album && track.album !== 'Stream') ? track.album : 'PalmPlay',
                artwork: artwork.length ? artwork : undefined
            });
            navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
        } catch (e) {
            console.warn('MediaSession metadata failed', e);
        }
    }

    async function init() {
        setupConnectivityBanner();
        setupMediaSession();
        setupEventListeners();
        setupKeyboardShortcuts();
        if (window.PalmPlayAuth) await window.PalmPlayAuth.init();
        const user = getSavedUser();
        const uid = getUserId(user);
        if (uid && window.PalmPlaySync?.enabled?.()) {
            try {
                await window.PalmPlaySync.pullAndMerge(uid, user.email);
            } catch (e) {
                console.warn('Cloud sync pull failed', e);
            }
        }
        await loadFromDatabase();
        updatePlayerUI();
        routeInitialView();
        let spotifyHandled = false;
        try {
            spotifyHandled = await handleSpotifyOAuthCallback();
            if (spotifyHandled && sessionStorage.getItem(SPOTIFY_AUTO_IMPORT_KEY) === '1') {
                sessionStorage.removeItem(SPOTIFY_AUTO_IMPORT_KEY);
                let token = null;
                try {
                    token = await getValidSpotifyAccessToken();
                } catch (e) {
                    console.warn('Spotify token unavailable after callback', e);
                }
                if (token) {
                    await importSpotifyLibraryToPalmPlay();
                } else {
                    showToast('Spotify connection incomplete. Please reconnect.', 'fa-exclamation-triangle');
                }
            }
        } catch (e) {
            console.warn('Spotify callback handling failed', e);
        }
        const params = new URLSearchParams(window.location.search);
        if (params.get('q') && ppRoutes().isExplorePage()) {
            const q = decodeURIComponent(params.get('q'));
            window.PalmPlayNav?.go('search', true);
            const input = document.querySelector('.premium-search-input');
            if (input) {
                input.value = q;
                setTimeout(() => filterCards(q), 300);
            }
            history.replaceState(null, '', window.location.pathname + (window.location.hash || ''));
        } else {
            await handlePlaybackDeepLink();
        }
    }

    async function loadFromDatabase() {
        console.log('Loading from database fresh...');
        playlists = []; // Clear existing state to prevent duplicates
        likedSongs = []; // Clear liked songs
        const savedUser = getSavedUser();
        const uid = getUserId(savedUser);
        if (!uid) {
            console.log('No user logged in, skipping database load.');
            routeInitialView();
            return;
        }

        try {
            const savedPlaylists = await db.playlists.where('userId').equals(uid).toArray();
            for (const pl of savedPlaylists) {
                const plTracks = await db.tracks.where('playlistId').equals(pl.id).toArray();

                const tracksWithUrls = [];
                for (const t of plTracks) {
                    let url = null;
                    let art = DEFAULT_ART_URL;

                    if (t.audioBlob) {
                        url = URL.createObjectURL(t.audioBlob);
                        art = t.artBlob ? URL.createObjectURL(t.artBlob) : DEFAULT_ART_URL;
                    } else if (t.streamUrl) {
                        url = t.streamUrl;
                        art = t.artUrl || DEFAULT_ART_URL;
                    } else {
                        continue;
                    }

                    let duration = t.duration || 0;
                    if (!duration && t.audioBlob) {
                        duration = await getAudioDuration(t.audioBlob);
                    }

                    tracksWithUrls.push({
                        ...t,
                        id: t.externalId || t.id,
                        url,
                        duration,
                        art,
                        isCatalog: t.source === 'catalog',
                        isAudius: t.source === 'audius',
                        isCatalogFallback: t.source === 'audius'
                    });
                }

                playlists.push({
                    id: pl.id,
                    name: pl.name,
                    tracks: tracksWithUrls,
                    cloudId: pl.cloudId || null
                });
            }

            // Load liked songs from DB
            try {
                const savedLiked = await db.likedSongs.where('userId').equals(uid).toArray();
                likedSongs = savedLiked.map(ls => ({
                    ...ls,
                    art: ls.artBlob ? URL.createObjectURL(ls.artBlob) : (ls.artUrl || ls.art || DEFAULT_ART_URL)
                }));
                
                // Inject Audius liked tracks into temporary playlist so they can be played
                const audiusLiked = likedSongs.filter(ls => ls.isAudius);
                if (audiusLiked.length > 0) {
                    let audiusPlIndex = playlists.findIndex(pl => pl.id === 'audius_search');
                    if (audiusPlIndex === -1) {
                        playlists.push({
                            id: 'audius_search',
                            name: 'Search Results',
                            tracks: [],
                            isTemporary: true
                        });
                        audiusPlIndex = playlists.length - 1;
                    }
                    audiusLiked.forEach(ls => {
                        if (!playlists[audiusPlIndex].tracks.find(t => t.name === ls.trackName && t.artist === ls.artist)) {
                            playlists[audiusPlIndex].tracks.push({
                                name: ls.trackName,
                                artist: ls.artist,
                                album: ls.album,
                                duration: ls.duration,
                                url: ls.url,
                                art: ls.art,
                                isAudius: true
                            });
                        }
                    });
                }
            } catch (likedErr) {
                console.log('Liked songs table not ready yet:', likedErr);
                likedSongs = [];
            }

            renderSidebar();
        } catch (error) {
            console.error('Failed to load songs:', error);
        }
    }

    // ─── Dynamic Theme from Album Art ──────────────────────────────────────────
    function applyDynamicTheme(artUrl) {
        if (!artUrl || artUrl.includes('unsplash')) return;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 16; canvas.height = 16; // tiny for speed
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, 16, 16);
                const d = ctx.getImageData(0, 0, 16, 16).data;
                let r = 0, g = 0, b = 0, count = 0;
                for (let i = 0; i < d.length; i += 4) {
                    // Skip near-black and near-white pixels
                    const brightness = (d[i] + d[i+1] + d[i+2]) / 3;
                    if (brightness > 20 && brightness < 235) {
                        r += d[i]; g += d[i+1]; b += d[i+2]; count++;
                    }
                }
                if (count === 0) return;
                r = Math.round(r / count);
                g = Math.round(g / count);
                b = Math.round(b / count);

                // Boost saturation: push dominant channel
                const max = Math.max(r, g, b);
                const boost = 1.4;
                r = Math.min(255, max === r ? Math.round(r * boost) : Math.round(r * 0.7));
                g = Math.min(255, max === g ? Math.round(g * boost) : Math.round(g * 0.7));
                b = Math.min(255, max === b ? Math.round(b * boost) : Math.round(b * 0.7));

                // Apply to CSS variables with smooth transition
                const root = document.documentElement;
                root.style.setProperty('--primary', `rgb(${r},${g},${b})`);
                root.style.setProperty('--primary-hover', `rgba(${r},${g},${b},0.8)`);

                // Also update the ambient background orb
                const orb1 = document.getElementById('orb-1');
                if (orb1) orb1.style.background = `radial-gradient(circle, rgba(${r},${g},${b},0.15) 0%, transparent 70%)`;
            } catch(e) { /* CORS or canvas issue, skip */ }
        };
        img.src = artUrl;
    }
    // ─────────────────────────────────────────────────────────────────────────────

    // ─── Keyboard Shortcuts ───────────────────────────────────────────────────────
    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Don't fire when typing in input fields
            if (e.target.matches('input, textarea')) return;

            switch (e.key) {
                case ' ': // Space = Play/Pause
                    e.preventDefault();
                    if (audio.src) {
                        togglePlay();
                        showToast(state.isPlaying ? 'Paused' : 'Playing', state.isPlaying ? 'fa-pause' : 'fa-play');
                    }
                    break;
                case 'ArrowRight': // → = Next track
                    e.preventDefault();
                    playNext();
                    showToast('Next Track', 'fa-step-forward');
                    break;
                case 'ArrowLeft': // ← = Previous track
                    e.preventDefault();
                    playPrev();
                    showToast('Previous Track', 'fa-step-backward');
                    break;
                case 'ArrowUp': // ↑ = Volume up
                    e.preventDefault();
                    state.volume = Math.min(1, state.volume + 0.1);
                    audio.volume = state.volume;
                    document.querySelector('.volume-fill').style.width = `${state.volume * 100}%`;
                    showToast(`Volume: ${Math.round(state.volume * 100)}%`, 'fa-volume-up');
                    break;
                case 'ArrowDown': // ↓ = Volume down
                    e.preventDefault();
                    state.volume = Math.max(0, state.volume - 0.1);
                    audio.volume = state.volume;
                    document.querySelector('.volume-fill').style.width = `${state.volume * 100}%`;
                    showToast(`Volume: ${Math.round(state.volume * 100)}%`, 'fa-volume-down');
                    break;
                case 'm': case 'M': // M = Mute toggle
                    e.preventDefault();
                    state.isMuted = !state.isMuted;
                    audio.muted = state.isMuted;
                    const muteIcon = document.getElementById('mute-btn');
                    if (muteIcon) muteIcon.className = state.isMuted ? 'fas fa-volume-mute' : 'fas fa-volume-up';
                    showToast(state.isMuted ? 'Muted' : 'Unmuted', state.isMuted ? 'fa-volume-mute' : 'fa-volume-up');
                    break;
                case 'l': case 'L': // L = Like current track
                    e.preventDefault();
                    if (state.currentPlaylistIndex !== -1) {
                        const t = playlists[state.currentPlaylistIndex].tracks[state.currentTrackIndex];
                        if (t) { toggleLike(t, state.currentPlaylistIndex, state.currentTrackIndex); }
                    }
                    break;
                case 's': case 'S': // S = Shuffle
                    e.preventDefault();
                    toggleShuffle();
                    showToast(state.isShuffle ? 'Shuffle On' : 'Shuffle Off', 'fa-random');
                    break;
                case 'q': case 'Q':
                    e.preventDefault();
                    if (typeof window.toggleQueue === 'function') window.toggleQueue();
                    break;
            }
        });

        // Scroll wheel on player bar = volume
        document.querySelector('.player-bar')?.addEventListener('wheel', (e) => {
            e.preventDefault();
            state.volume = Math.max(0, Math.min(1, state.volume - e.deltaY * 0.001));
            audio.volume = state.volume;
            document.querySelector('.volume-fill').style.width = `${state.volume * 100}%`;
        }, { passive: false });
    }
    // ─────────────────────────────────────────────────────────────────────────────

    function setupEventListeners() {
        // Toggle Add Music Menu
        addMusicBtn.onclick = (e) => {
            e.stopPropagation();
            addOptions.style.display = addOptions.style.display === 'none' ? 'block' : 'none';
        };

        window.onclick = () => {
            addOptions.style.display = 'none';
        };

        // File/Folder Picking
        addFilesBtn.onclick = () => fileInput.click();
        addFolderBtn.onclick = () => folderInput.click();

        const newPlaylistBtn = document.querySelector('#new-playlist-btn');
        const importAppsBtn = document.querySelector('#import-apps-btn');
        if (newPlaylistBtn) {
            newPlaylistBtn.onclick = (e) => {
                e.stopPropagation();
                addOptions.style.display = 'none';
                showModal('New playlist', 'Name your playlist:', async (name) => {
                    await createUserPlaylist(name);
                }, true, '');
            };
        }
        if (importAppsBtn) {
            importAppsBtn.onclick = (e) => {
                e.stopPropagation();
                addOptions.style.display = 'none';
                showImportFromAppsModal();
            };
        }

        fileInput.onchange = (e) => handleFiles(e.target.files, false);
        folderInput.onchange = (e) => handleFiles(e.target.files, true);

        cardGrid.addEventListener('click', (e) => {
            const albumBtn = e.target.closest('[data-album-id]');
            if (albumBtn) {
                e.preventDefault();
                e.stopPropagation();
                openAlbumPage(
                    albumBtn.getAttribute('data-album-id'),
                    albumBtn.getAttribute('data-album-name'),
                    albumBtn.getAttribute('data-album-art')
                );
                return;
            }
            const artistBtn = e.target.closest('[data-artist-id], [data-artist-name].meta-link, .meta-link--name');
            if (artistBtn) {
                e.preventDefault();
                e.stopPropagation();
                openArtistPage(
                    artistBtn.getAttribute('data-artist-id') || null,
                    artistBtn.getAttribute('data-artist-name')
                );
            }
        });

        // Navigation Links
        const navLinks = document.querySelectorAll('.nav-item');
        navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                const href = link.getAttribute('href') || '';
                const onExplorePage = ppRoutes().isExplorePage();
                const routeKey = link.getAttribute('data-pp-route') || '';
                const isDiscover = routeKey === 'discover' || href.includes('#discover') || link.textContent.trim().toLowerCase() === 'discover';
                const isExploreOnly = routeKey === 'explore' || link.hasAttribute('data-nav-explore') || (link.textContent.trim().toLowerCase() === 'explore' && !href.includes('#discover'));

                if ((routeKey === 'home' || href.includes('home')) && !ppRoutes().isHomePage()) return;
                if ((routeKey === 'explore' || href.includes('explore')) && !href.includes('#') && !onExplorePage && isExploreOnly) return;

                e.preventDefault();
                navLinks.forEach(l => l.classList.remove('active'));
                link.classList.add('active');
                window.PalmPlayUX?.activateBottomNav?.(isDiscover ? 'discover' : isExploreOnly ? 'explore' : 'home');

                if (isDiscover) {
                    window.PalmPlayNav.go('search');
                } else if (isExploreOnly && onExplorePage) {
                    window.PalmPlayNav.go('explore');
                } else if (routeKey === 'home' || href.includes('home')) {
                    window.PalmPlayNav.go('home');
                } else {
                    window.PalmPlayNav.go('search');
                }
            });
        });

        // Search Filtering
        const searchInput = searchContainer.querySelector('input');
        searchInput.addEventListener('input', (e) => {
            filterCards(e.target.value);
        });
        searchInput.addEventListener('focus', () => {
            if (ppRoutes().isHomePage() && state.currentView !== 'search') {
                window.location.href = ppRoutes().page('discover');
            }
        });

        // Back Navigation
        const backBtn = document.querySelector('.header-back') || document.querySelector('.top-header .fa-chevron-left')?.closest('button');
        if (backBtn) backBtn.onclick = () => window.PalmPlayNav.back();

        // Category Chips for Explore Page
        const chips = document.querySelectorAll('.chip');
        chips.forEach(chip => {
            chip.addEventListener('click', (e) => {
                chips.forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                const genre = chip.getAttribute('data-genre') || 'Trending';
                if (window.renderExplore) {
                    window.renderExplore(genre);
                }
            });
        });

        // Shuffle Control
        const playerShuffle = document.querySelector('.player-bar .fa-random');
        if (playerShuffle) playerShuffle.addEventListener('click', toggleShuffle);

        // Play/Pause
        playBtn.addEventListener('click', togglePlay);

        // Skip/Prev
        nextBtn.addEventListener('click', playNext);
        prevBtn.addEventListener('click', playPrev);

        // Bars
        progressBar.addEventListener('click', seek);
        let isScrubbing = false;
        const scrubToClientX = (clientX) => {
            if (!audio.src || !audio.duration) return;
            const rect = progressBar.getBoundingClientRect();
            const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            audio.currentTime = pos * audio.duration;
        };
        const startScrub = (clientX) => {
            if (!audio.src || !audio.duration) return;
            isScrubbing = true;
            scrubToClientX(clientX);
        };
        const moveScrub = (clientX) => {
            if (!isScrubbing) return;
            scrubToClientX(clientX);
        };
        const endScrub = () => {
            isScrubbing = false;
        };

        // Pointer events (modern browsers)
        progressBar.addEventListener('pointerdown', (e) => {
            startScrub(e.clientX);
            progressBar.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        });
        progressBar.addEventListener('pointermove', (e) => moveScrub(e.clientX));
        progressBar.addEventListener('pointerup', () => endScrub());
        progressBar.addEventListener('pointercancel', () => endScrub());
        progressBar.addEventListener('lostpointercapture', () => endScrub());

        // Mouse fallback (ensures drag works even if pointer events are flaky)
        progressBar.addEventListener('mousedown', (e) => {
            startScrub(e.clientX);
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => moveScrub(e.clientX));
        window.addEventListener('mouseup', () => endScrub());

        // Touch fallback for mobile drag
        progressBar.addEventListener('touchstart', (e) => {
            const t = e.touches?.[0];
            if (!t) return;
            startScrub(t.clientX);
            e.preventDefault();
        }, { passive: false });
        window.addEventListener('touchmove', (e) => {
            if (!isScrubbing) return;
            const t = e.touches?.[0];
            if (!t) return;
            moveScrub(t.clientX);
            e.preventDefault();
        }, { passive: false });
        window.addEventListener('touchend', () => endScrub());
        window.addEventListener('touchcancel', () => endScrub());

        // Optional desktop wheel scrubbing: scroll over timeline to seek.
        progressBar.addEventListener('wheel', (e) => {
            if (!audio.src || !audio.duration) return;
            e.preventDefault();
            const delta = e.deltaY > 0 ? 5 : -5;
            audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
        }, { passive: false });
        volumeBar.addEventListener('click', setVolume);

        // Heart / Like Control
        const heartBtn = document.querySelector('.player-like-btn') || document.querySelector('.track-info .control-btn');
        if (heartBtn) {
            heartBtn.addEventListener('click', async () => {
                if (state.currentPlaylistIndex === -1) return;
                const track = playlists[state.currentPlaylistIndex].tracks[state.currentTrackIndex];
                await toggleLike(track, state.currentPlaylistIndex, state.currentTrackIndex);
                const icon = heartBtn.querySelector('i');
                const liked = isTrackLiked(track);
                icon.className = liked ? 'fas fa-heart' : 'far fa-heart';
                icon.style.color = liked ? 'var(--primary)' : '';
            });
        }

        // Repeat Control
        const repeatBtn = document.querySelector('.fa-redo-alt');
        if (repeatBtn) {
            repeatBtn.addEventListener('click', () => {
                state.repeatMode = (state.repeatMode + 1) % 3;
                const colors = ['', 'var(--primary)', 'var(--primary)'];
                repeatBtn.style.color = colors[state.repeatMode];

                // Change icon appearance if needed, but redo-alt is fine
                // Logic is handled in audio.onended
                const labels = ['Repeat Off', 'Repeat All', 'Repeat One'];
                showToast(labels[state.repeatMode], 'fa-redo-alt');
            });
        }

        // Speed Control
        const speedBtn = document.getElementById('speed-btn');
        if (speedBtn) {
            const speeds = [1.0, 1.2, 1.5, 2.0, 0.5];
            let speedIdx = 0;
            speedBtn.addEventListener('click', () => {
                speedIdx = (speedIdx + 1) % speeds.length;
                state.playbackSpeed = speeds[speedIdx];
                audio.playbackRate = state.playbackSpeed;
                speedBtn.textContent = state.playbackSpeed + 'x';
                showToast(`Speed: ${state.playbackSpeed}x`, 'fa-tachometer-alt');
            });
        }

        // Mute Control
        const muteBtn = document.getElementById('mute-btn');
        if (muteBtn) {
            muteBtn.addEventListener('click', () => {
                state.isMuted = !state.isMuted;
                audio.muted = state.isMuted;
                muteBtn.className = state.isMuted ? 'fas fa-volume-mute' : 'fas fa-volume-up';
                muteBtn.style.color = state.isMuted ? 'var(--primary)' : '';
                showToast(state.isMuted ? 'Muted' : 'Unmuted', state.isMuted ? 'fa-volume-mute' : 'fa-volume-up');
            });
        }

        // Volume Slider (revised)
        const volumeSlider = document.getElementById('volume-slider');
        if (volumeSlider) {
            volumeSlider.addEventListener('click', (e) => {
                const rect = volumeSlider.getBoundingClientRect();
                const pos = (e.clientX - rect.left) / rect.width;
                state.volume = Math.max(0, Math.min(1, pos));
                audio.volume = state.volume;
                volumeFill.style.width = `${state.volume * 100}%`;

                if (state.isMuted && state.volume > 0) {
                    state.isMuted = false;
                    audio.muted = false;
                    if (muteBtn) muteBtn.className = 'fas fa-volume-up';
                }
            });
        }

        // Fullscreen Mode
        const expandBtn = document.querySelector('.fa-expand-alt');
        if (expandBtn) {
            expandBtn.addEventListener('click', () => {
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(err => {
                        showToast('Fullscreen not supported');
                    });
                } else {
                    document.exitFullscreen();
                }
            });
        }

        document.getElementById('share-track-btn')?.addEventListener('click', () => shareCurrentTrack());

        // Audio Events
        audio.ontimeupdate = () => {
            if (audio.duration) {
                state.progress = (audio.currentTime / audio.duration) * 100;
                progressFill.style.width = `${state.progress}%`;
                timeCurrent.textContent = formatTime(audio.currentTime);
                window.dispatchEvent(new CustomEvent('palmplay:timeupdate', {
                    detail: {
                        current: audio.currentTime,
                        duration: audio.duration,
                        progress: state.progress
                    }
                }));
            }
        };

        audio.onplay = () => {
            state.isPlaying = true;
            state.isBuffering = false;
            updatePlayerUI();
        };

        audio.onpause = () => {
            state.isPlaying = false;
            updatePlayerUI();
        };

        audio.onended = () => {
            if (state.repeatMode === 2) { // Repeat One
                audio.currentTime = 0;
                audio.play();
            } else if (state.repeatMode === 1) { // Repeat All
                playNext(true);
            } else { // Repeat Off
                const pl = playlists[state.currentPlaylistIndex];
                const isLast = !pl || state.currentTrackIndex >= (pl.tracks.length - 1);
                if (isLast) {
                    state.isPlaying = false;
                    updatePlayerUI();
                } else {
                    playNext(false);
                }
            }
        };
    }

    async function handleFiles(files, isFolder) {
        console.log('Files selected:', files.length);
        const audioFiles = Array.from(files).filter(f => {
            const isAudioType = f.type.startsWith('audio/');
            const isAudioExt = /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(f.name);
            return isAudioType || isAudioExt;
        });

        if (audioFiles.length === 0) {
            alert('No valid audio files found.');
            return;
        }

        let folderName = "My Collection";
        if (isFolder && audioFiles[0].webkitRelativePath) {
            folderName = audioFiles[0].webkitRelativePath.split('/')[0];
        }

        const newTracks = [];
        const savedUser = getSavedUser();

        const uid = getUserId(savedUser);
        if (!uid) {
            showToast('Please log in or sign up to save your music collection!', 'fa-user-lock');
            ppRoutes().go('login');
            return;
        }

        showToast(`Adding folder "${folderName}"...`, 'fa-folder-plus');

        // Save to DB first to get a playlist ID
        const plId = await db.playlists.add({
            name: folderName,
            userId: uid
        });

        // Use a loading overlay if possible, or just log
        console.log('Extracting metadata and saving to DB...');

        for (const file of audioFiles) {
            const metadata = await getMetadata(file);

            // Convert metadata art to Blob if it's base64 (from jsmediatags)
            let artBlob = null;
            if (metadata.art && metadata.art.startsWith('data:')) {
                const res = await fetch(metadata.art);
                artBlob = await res.blob();
            }

            const trackData = {
                userId: uid,
                playlistId: plId,
                name: metadata.title || parseFileName(file.name).title || "Title Not Found",
                artist: metadata.artist || "Artist Not Found",
                album: metadata.album || folderName,
                year: metadata.year || null,
                genre: metadata.genre || null,
                duration: await getAudioDuration(file),
                dateAdded: new Date().toISOString(),
                audioBlob: file, // Files are Blobs
                artBlob: artBlob
            };

            const trackId = await db.tracks.add(trackData);

            const track = {
                id: trackId,
                ...trackData,
                url: URL.createObjectURL(file),
                art: metadata.art || DEFAULT_ART_URL
            };
            newTracks.push(track);
        }

        const newPlaylist = {
            id: plId,
            name: folderName,
            tracks: newTracks
        };

        playlists.push(newPlaylist);
        renderSidebar();
        renderHome();

        showToast(`Playlist "${folderName}" added successfully!`, 'fa-check-circle');
    }

    function getMetadata(file) {
        return new Promise((resolve) => {
            new jsmediatags.Reader(file)
                .read({
                    onSuccess: (tag) => {
                        const tags = tag.tags;
                        let artUrl = null;

                        if (tags.picture) {
                            const { data, format } = tags.picture;
                            let base64String = "";
                            for (let i = 0; i < data.length; i++) {
                                base64String += String.fromCharCode(data[i]);
                            }
                            artUrl = `data:${format};base64,${window.btoa(base64String)}`;
                        }

                        resolve({
                            title: tags.title,
                            artist: tags.artist,
                            album: tags.album || null,
                            year: tags.year || null,
                            genre: tags.genre || null,
                            art: artUrl
                        });
                    },
                    onError: (error) => {
                        console.log('Error reading tags:', error);
                        resolve({ title: null, artist: null, album: null, year: null, genre: null, art: null });
                    }
                });
        });
    }

    // Get actual audio duration from a file
    function getAudioDuration(file) {
        return new Promise((resolve) => {
            const tempAudio = new Audio();
            const url = URL.createObjectURL(file);
            tempAudio.src = url;
            tempAudio.addEventListener('loadedmetadata', () => {
                const dur = tempAudio.duration;
                URL.revokeObjectURL(url);
                resolve(isFinite(dur) ? dur : 0);
            });
            tempAudio.addEventListener('error', () => {
                URL.revokeObjectURL(url);
                resolve(0);
            });
        });
    }

    function parseFileName(name) {
        const cleanName = name.replace(/\.[^/.]+$/, "");
        if (cleanName.includes('-')) {
            const parts = cleanName.split('-');
            return { artist: parts[0].trim(), title: parts[1].trim() };
        }
        return { artist: "Unknown Artist", title: cleanName };
    }

    function renderSidebar() {
        localTracksList.innerHTML = '';

        // Always show Liked Songs first
        const likedItem = document.createElement('a');
        likedItem.href = '#';
        likedItem.className = 'playlist-item liked-songs-item';
        likedItem.innerHTML = `<i class="fas fa-heart" style="margin-right:8px; color:var(--primary);"></i> Liked Songs <span class="liked-count">${likedSongs.length}</span>`;
        likedItem.onclick = (e) => {
            e.preventDefault();
            showLikedSongs();
        };
        localTracksList.appendChild(likedItem);

        // Then render user playlists
        playlists.forEach((pl, index) => {
            if (!isUserPlaylist(pl)) return;
            const item = document.createElement('a');
            item.href = '#';
            item.className = 'playlist-item';
            item.innerHTML = `<i class="fas fa-music" style="margin-right:8px; opacity:0.7"></i> ${escapeHtml(pl.name)} <span class="liked-count">${pl.tracks.length}</span>`;
            item.onclick = (e) => {
                e.preventDefault();
                showPlaylist(index);
            };
            localTracksList.appendChild(item);
        });
    }

    const HOME_FEED_CACHE_KEY = 'palmplay_home_feed_v4';
    const HOME_FEED_TTL_MS = 5 * 60 * 1000;
    const PLAY_HISTORY_KEY = 'palmplay_play_history';
    const PLAY_HISTORY_MAX = 50;
    const RECENT_SEARCHES_KEY = 'palmplay_recent_searches';
    const RECENT_SEARCHES_MAX = 15;
    const PERSONAL_FEEDBACK_KEY = 'palmplay_personal_feedback_v1';
    const QUEUE_STATE_KEY = 'palmplay_queue_state_v1';
    const SPOTIFY_TOKEN_KEY = 'palmplay_spotify_tokens_v1';
    const SPOTIFY_PKCE_STATE_KEY = 'palmplay_spotify_pkce_state';
    const SPOTIFY_PKCE_VERIFIER_KEY = 'palmplay_spotify_pkce_verifier';
    const SPOTIFY_PKCE_CACHE_KEY = 'palmplay_spotify_pkce_cache_v1';
    const SPOTIFY_AUTO_IMPORT_KEY = 'palmplay_spotify_auto_import';
    const SPOTIFY_FORBIDDEN_RETRY_KEY = 'palmplay_spotify_forbidden_retry';
    const SPOTIFY_SCOPES = [
        'user-library-read',
        'playlist-read-private',
        'playlist-read-collaborative'
    ].join(' ');
    const SPOTIFY_MAX_LIKED_IMPORT = 500;
    const SPOTIFY_MAX_PLAYLISTS_IMPORT = 30;
    const SPOTIFY_MAX_PLAYLIST_TRACKS_IMPORT = 200;
    const SPOTIFY_RESOLVE_BATCH_SIZE = 12;
    const SPOTIFY_PREFETCH_CONCURRENCY = 4;
    const LIKED_SONGS_PLAYLIST_ID = '__liked_songs__';
    let playbackRecoveryLock = false;
    let playRequestToken = 0;
    let autoSkipAttempts = 0;
    let spotifyAllTimePoolCache = null;

    function getQueuePlaylistKey(plIndex) {
        const pl = playlists[plIndex];
        if (!pl) return null;
        return String(pl.id ?? `idx_${plIndex}`);
    }

    function buildDefaultQueueIndices(plIndex, currentIndex) {
        const pl = playlists[plIndex];
        if (!pl?.tracks?.length || currentIndex < 0) return [];
        const indices = [];
        for (let i = currentIndex; i < pl.tracks.length; i++) indices.push(i);
        return indices;
    }

    function saveQueueState() {
        try {
            if (!state.queuePlaylistKey || !state.queueIndices.length) {
                localStorage.removeItem(QUEUE_STATE_KEY);
                return;
            }
            localStorage.setItem(QUEUE_STATE_KEY, JSON.stringify({
                key: state.queuePlaylistKey,
                indices: state.queueIndices,
                explicit: !!state.queueExplicit
            }));
        } catch (e) {
            console.warn('Queue state save failed', e);
        }
    }

    function loadQueueState() {
        try {
            const raw = localStorage.getItem(QUEUE_STATE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.indices) || !parsed.key) return null;
            return parsed;
        } catch {
            return null;
        }
    }

    function setQueueIndices(plIndex, currentIndex, customIndices, explicit = false) {
        const key = getQueuePlaylistKey(plIndex);
        const pl = playlists[plIndex];
        if (!key || !pl?.tracks?.length) {
            state.queuePlaylistKey = null;
            state.queueIndices = [];
            state.queueExplicit = false;
            saveQueueState();
            return;
        }
        const valid = [];
        const seen = new Set();
        const hasCustomOrder = Array.isArray(customIndices);
        const source = hasCustomOrder ? customIndices : buildDefaultQueueIndices(plIndex, currentIndex);
        source.forEach((idx) => {
            const n = Number(idx);
            if (!Number.isInteger(n)) return;
            if (n < 0 || n >= pl.tracks.length) return;
            if (!hasCustomOrder && n < currentIndex) return;
            if (seen.has(n)) return;
            seen.add(n);
            valid.push(n);
        });
        if (!valid.length || valid[0] !== currentIndex) {
            valid.unshift(currentIndex);
        }
        state.queuePlaylistKey = key;
        state.queueIndices = valid;
        state.queueExplicit = !!explicit;
        saveQueueState();
    }

    function ensureQueueForCurrentTrack(plIndex, currentIndex, opts = {}) {
        const key = getQueuePlaylistKey(plIndex);
        const forceReset = !!opts.forceReset;
        const keepExisting = !!opts.keepExisting;
        if (!key) return;
        const shouldRestore = !state.queueIndices.length && !forceReset;
        if (shouldRestore) {
            const persisted = loadQueueState();
            if (persisted?.key === key) {
                setQueueIndices(plIndex, currentIndex, persisted.indices, !!persisted.explicit);
                return;
            }
        }
        if (forceReset || state.queuePlaylistKey !== key || !keepExisting) {
            setQueueIndices(plIndex, currentIndex, null, false);
            return;
        }
        if (!state.queueIndices.includes(currentIndex)) {
            setQueueIndices(plIndex, currentIndex, null, false);
        } else {
            const pos = state.queueIndices.indexOf(currentIndex);
            setQueueIndices(plIndex, currentIndex, state.queueIndices.slice(pos), state.queueExplicit);
        }
    }

    function buildShuffledQueueIndices(plIndex, currentIndex) {
        const pl = playlists[plIndex];
        if (!pl?.tracks?.length || currentIndex < 0) return [];
        const rest = [];
        for (let i = 0; i < pl.tracks.length; i++) {
            if (i !== currentIndex) rest.push(i);
        }
        for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        return [currentIndex, ...rest];
    }

    function updateShuffleControlIcons() {
        const color = state.isShuffle ? 'var(--primary)' : 'var(--text-subdued)';
        document.querySelectorAll('#pl-shuffle, #liked-shuffle, .player-bar .fa-random').forEach((el) => {
            el.style.color = color;
        });
    }

    function startCollectionPlayback(plIndex, opts = {}) {
        const pl = playlists[plIndex];
        if (!pl?.tracks?.length) {
            showToast('No songs to play yet', 'fa-music');
            return;
        }

        const shuffle = !!opts.shuffle;
        let startIndex = 0;
        if (shuffle && pl.tracks.length > 1) {
            startIndex = Math.floor(Math.random() * pl.tracks.length);
        }

        state.isShuffle = shuffle;
        if (shuffle) {
            setQueueIndices(plIndex, startIndex, buildShuffledQueueIndices(plIndex, startIndex), true);
            showToast('Shuffle play', 'fa-random');
        } else {
            setQueueIndices(plIndex, startIndex, null, false);
        }
        updateShuffleControlIcons();
        playTrack(plIndex, startIndex, { fromQueue: shuffle });
    }

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str == null ? '' : String(str);
        return d.innerHTML;
    }

    function showErrorState(container, { icon = 'fa-exclamation-triangle', title, message, onRetry }) {
        if (!container) return;
        const el = document.createElement('div');
        el.className = 'state-message';
        el.style.gridColumn = '1 / -1';
        el.innerHTML = `
            <i class="fas ${icon}"></i>
            <p><strong>${escapeHtml(title)}</strong><br>${escapeHtml(message)}</p>
        `;
        if (onRetry) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'upgrade-btn retry-btn';
            btn.textContent = 'Retry';
            btn.onclick = onRetry;
            el.appendChild(btn);
        }
        container.innerHTML = '';
        container.appendChild(el);
    }

    function getRecentSearches() {
        try {
            const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list.filter(q => typeof q === 'string' && q.trim()) : [];
        } catch {
            return [];
        }
    }

    function addRecentSearch(query) {
        const q = (query || '').trim();
        if (q.length < 2) return;
        let list = getRecentSearches().filter(item => item.toLowerCase() !== q.toLowerCase());
        list.unshift(q);
        list = list.slice(0, RECENT_SEARCHES_MAX);
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list));
    }

    function renderRecentSearchesHtml() {
        const recent = getRecentSearches();
        if (!recent.length) return '';
        const chips = recent.map(q =>
            `<button type="button" class="recent-search-chip" data-recent-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`
        ).join('');
        return `
            <div class="recent-searches-block">
                <span class="recent-searches-label">Recent</span>
                <div class="recent-searches-row">${chips}</div>
            </div>
        `;
    }

    function bindRecentSearchChips(root) {
        root?.querySelectorAll('.recent-search-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                const q = btn.getAttribute('data-recent-q') || '';
                const input = document.querySelector('.premium-search-input');
                if (input) {
                    input.value = q;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
        });
    }

    function setupConnectivityBanner() {
        if (document.getElementById('palmplay-offline-banner')) return;
        const bar = document.createElement('div');
        bar.id = 'palmplay-offline-banner';
        bar.className = 'offline-banner';
        bar.setAttribute('role', 'status');
        bar.innerHTML = '<i class="fas fa-wifi"></i><span>You\'re offline — streaming may not work. Local files still play.</span>';
        document.body.prepend(bar);
        const update = () => bar.classList.toggle('visible', !navigator.onLine);
        window.addEventListener('online', update);
        window.addEventListener('offline', update);
        update();
    }

    function parseCatalogSong(t) {
        if (!t) return null;
        const img = pickMediaUrl(t.image) || DEFAULT_ART_URL;
        const streamUrl = pickMediaUrl(t.downloadUrl);
        if (!streamUrl) return null;

        let artist = '';
        if (Array.isArray(t.artists?.primary) && t.artists.primary.length > 0) {
            artist = t.artists.primary.map(a => a?.name).filter(Boolean).join(', ');
        } else if (Array.isArray(t.artists?.all) && t.artists.all.length > 0) {
            artist = t.artists.all.map(a => a?.name).filter(Boolean).join(', ');
        } else if (typeof t.primaryArtists === 'string') {
            artist = t.primaryArtists;
        }

        const primary = Array.isArray(t.artists?.primary) ? t.artists.primary[0] : null;

        return {
            id: t.id,
            name: decodeHtmlEntities(t.name) || 'Unknown',
            artist: decodeHtmlEntities(artist) || 'Various Artists',
            album: decodeHtmlEntities(t.album?.name) || 'Single',
            albumId: t.album?.id || null,
            primaryArtistId: primary?.id || null,
            duration: parseInt(t.duration, 10) || 200,
            url: streamUrl,
            art: img,
            isCatalog: true
        };
    }

    function unwrapCatalogData(data) {
        const d = data?.data;
        if (Array.isArray(d)) return d[0] || null;
        return d || null;
    }

    async function fetchCatalogJson(path) {
        if (!MUSIC_CATALOG_API_BASE) return null;
        catalogTraffic.recordStart();
        try {
            const res = await fetch(`${MUSIC_CATALOG_API_BASE}${path}`, { signal: AbortSignal.timeout(10000) });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            console.warn('Catalog request failed:', path, e);
            return null;
        } finally {
            catalogTraffic.recordEnd();
        }
    }

    function parseAlbumStub(a) {
        if (!a?.id) return null;
        return {
            id: a.id,
            name: decodeHtmlEntities(a.name || a.title) || 'Album',
            art: pickMediaUrl(a.image) || DEFAULT_ART_URL,
            songCount: a.songCount || a.songs?.length || null
        };
    }

    async function fetchCatalogArtist(artistId, artistName) {
        const name = (artistName || 'Artist').trim();
        if (!MUSIC_CATALOG_API_BASE || !artistId) {
            const songs = await fetchCatalogTracks(name, 30);
            return { id: artistId, name, art: songs[0]?.art || DEFAULT_ART_URL, songs, albums: [] };
        }

        let root = unwrapCatalogData(await fetchCatalogJson(`/artists/${encodeURIComponent(artistId)}`));
        if (!root?.topSongs && !root?.songs) {
            const songsPayload = unwrapCatalogData(await fetchCatalogJson(`/artists/${encodeURIComponent(artistId)}/songs`));
            if (songsPayload) {
                root = { ...root, songs: songsPayload.songs || songsPayload.topSongs || songsPayload };
            }
        }

        let songs = (root?.topSongs || root?.songs || [])
            .map(parseCatalogSong)
            .filter(Boolean);
        const albums = (root?.topAlbums || root?.albums || [])
            .map(parseAlbumStub)
            .filter(Boolean);

        if (!songs.length) {
            songs = await fetchCatalogTracks(name, 30);
        }

        return {
            id: artistId,
            name: decodeHtmlEntities(root?.name) || name,
            art: pickMediaUrl(root?.image) || songs[0]?.art || DEFAULT_ART_URL,
            songs,
            albums
        };
    }

    async function fetchCatalogAlbum(albumId, albumName) {
        const name = (albumName || 'Album').trim();
        if (!MUSIC_CATALOG_API_BASE || !albumId) {
            const songs = await fetchCatalogTracks(name, 25);
            return {
                id: albumId,
                name,
                art: songs[0]?.art || DEFAULT_ART_URL,
                artist: songs[0]?.artist || '',
                songs
            };
        }

        const root = unwrapCatalogData(await fetchCatalogJson(`/albums/${encodeURIComponent(albumId)}`));
        let songs = (root?.songs || []).map(parseCatalogSong).filter(Boolean);
        if (!songs.length) {
            songs = await fetchCatalogTracks(name, 25);
        }

        let artistLabel = '';
        if (typeof root?.primaryArtists === 'string') artistLabel = root.primaryArtists;
        else if (Array.isArray(root?.artists?.primary)) {
            artistLabel = root.artists.primary.map(a => a?.name).filter(Boolean).join(', ');
        }

        return {
            id: albumId,
            name: decodeHtmlEntities(root?.name) || name,
            art: pickMediaUrl(root?.image) || songs[0]?.art || DEFAULT_ART_URL,
            artist: decodeHtmlEntities(artistLabel) || songs[0]?.artist || '',
            year: root?.year || null,
            songs
        };
    }

    function showDetailChrome(breadcrumbLabel, title) {
        if (searchContainer) searchContainer.style.display = 'flex';
        if (viewHeader) viewHeader.style.display = 'block';
        if (greetingEl) {
            greetingEl.style.display = 'block';
            greetingEl.className = 'greeting detail-breadcrumb';
            greetingEl.innerHTML = breadcrumbLabel;
        }
        if (exploreHero) exploreHero.style.display = 'none';
        if (categoryChips) categoryChips.style.display = 'none';
        if (sectionTitleEl) sectionTitleEl.textContent = title;
        header.style.backgroundColor = 'transparent';
    }

    function buildTrackMetaLine(track) {
        const artistName = track.artist || 'Unknown';
        const aid = track.primaryArtistId || track.artistId || null;
        const albumName = track.album && track.album !== 'Single' && track.album !== 'Stream' && track.album !== 'Explore'
            ? track.album
            : '';
        const albId = track.albumId || null;

        let artistPart;
        if (aid) {
            artistPart = `<button type="button" class="meta-link" data-artist-id="${escapeHtml(String(aid))}" data-artist-name="${escapeHtml(artistName)}">${escapeHtml(artistName)}</button>`;
        } else {
            artistPart = `<button type="button" class="meta-link meta-link--name" data-artist-name="${escapeHtml(artistName)}">${escapeHtml(artistName)}</button>`;
        }

        if (!albumName) return artistPart;
        if (albId) {
            return `${artistPart}<span class="meta-sep"> · </span><button type="button" class="meta-link" data-album-id="${escapeHtml(String(albId))}" data-album-name="${escapeHtml(albumName)}" data-album-art="${escapeHtml(track.art || '')}">${escapeHtml(albumName)}</button>`;
        }
        return `${artistPart}<span class="meta-sep"> · </span><span class="meta-album">${escapeHtml(albumName)}</span>`;
    }

    async function renderArtistPage(artistId, artistName) {
        state.currentView = 'artist';
        showDetailChrome(
            `<button type="button" class="crumb-link" data-crumb="discover">Discover</button><span class="crumb-sep"> › </span><span>Artist</span>`,
            artistName || 'Artist'
        );

        cardGrid.className = 'card-grid detail-page';
        cardGrid.style.display = 'block';
        cardGrid.innerHTML = `<div class="detail-loading">${skeletonCardGrid(8)}</div>`;

        const data = await fetchCatalogArtist(artistId, artistName);
        if (state.currentView !== 'artist') return;

        cardGrid.innerHTML = '';

        const hero = document.createElement('section');
        hero.className = 'detail-hero';
        hero.innerHTML = `
            <div class="detail-hero-art" style="background-image:url('${escapeHtml(data.art)}')"></div>
            <div class="detail-hero-info">
                <span class="detail-hero-type">Artist</span>
                <h1 class="detail-hero-title">${escapeHtml(data.name)}</h1>
                <p class="detail-hero-meta">${data.songs.length} top songs${data.albums.length ? ` · ${data.albums.length} albums` : ''}</p>
            </div>
        `;
        cardGrid.appendChild(hero);

        if (data.albums.length) {
            const albSection = document.createElement('section');
            albSection.className = 'detail-section';
            albSection.innerHTML = `<h3 class="detail-section-title">Albums</h3>`;
            const albGrid = document.createElement('div');
            albGrid.className = 'detail-albums-row';
            data.albums.forEach((alb) => {
                const card = document.createElement('button');
                card.type = 'button';
                card.className = 'detail-album-card';
                card.innerHTML = `
                    <div class="detail-album-art" style="background-image:url('${escapeHtml(alb.art)}')"></div>
                    <span class="detail-album-name">${escapeHtml(alb.name)}</span>
                `;
                card.onclick = () => openAlbumPage(alb.id, alb.name, alb.art);
                albGrid.appendChild(card);
            });
            albSection.appendChild(albGrid);
            cardGrid.appendChild(albSection);
        }

        if (!data.songs.length) {
            showErrorState(cardGrid, {
                icon: 'fa-user-music',
                title: 'No songs found',
                message: 'Try searching for this artist on Discover.',
                onRetry: () => openArtistPage(artistId, artistName)
            });
            return;
        }

        const plIndex = upsertTempPlaylist(`artist_${artistId || encodeURIComponent(data.name)}`, data.name, data.songs);
        const grid = document.createElement('div');
        grid.className = 'home-section-grid card-grid';
        data.songs.forEach((track, tIdx) => grid.appendChild(createTrackCard(track, plIndex, tIdx)));

        const songsSection = document.createElement('section');
        songsSection.className = 'detail-section';
        songsSection.innerHTML = `<h3 class="detail-section-title">Popular tracks</h3>`;
        songsSection.appendChild(grid);
        cardGrid.appendChild(songsSection);

        bindDetailBreadcrumb(cardGrid);
        mainView.scrollTop = 0;
    }

    async function renderAlbumPage(albumId, albumName, artUrl) {
        state.currentView = 'album';
        showDetailChrome(
            `<button type="button" class="crumb-link" data-crumb="discover">Discover</button><span class="crumb-sep"> › </span><span>Album</span>`,
            albumName || 'Album'
        );

        cardGrid.className = 'card-grid detail-page';
        cardGrid.style.display = 'block';
        cardGrid.innerHTML = `<div class="detail-loading">${skeletonCardGrid(8)}</div>`;

        const data = await fetchCatalogAlbum(albumId, albumName);
        if (state.currentView !== 'album') return;

        cardGrid.innerHTML = '';

        const hero = document.createElement('section');
        hero.className = 'detail-hero';
        const art = artUrl || data.art || DEFAULT_ART_URL;
        hero.innerHTML = `
            <div class="detail-hero-art" style="background-image:url('${escapeHtml(art)}')"></div>
            <div class="detail-hero-info">
                <span class="detail-hero-type">Album</span>
                <h1 class="detail-hero-title">${escapeHtml(data.name)}</h1>
                <p class="detail-hero-meta">${escapeHtml(data.artist || '')}${data.year ? ` · ${data.year}` : ''} · ${data.songs.length} songs</p>
                ${data.artist ? `<button type="button" class="meta-link detail-hero-artist" data-artist-name="${escapeHtml(data.artist)}">View artist</button>` : ''}
            </div>
        `;
        cardGrid.appendChild(hero);

        if (!data.songs.length) {
            showErrorState(cardGrid, {
                icon: 'fa-compact-disc',
                title: 'No tracks found',
                message: 'This album could not be loaded.',
                onRetry: () => openAlbumPage(albumId, albumName, art)
            });
            return;
        }

        const plIndex = upsertTempPlaylist(`album_${albumId || encodeURIComponent(data.name)}`, data.name, data.songs);
        const grid = document.createElement('div');
        grid.className = 'home-section-grid card-grid';
        data.songs.forEach((track, tIdx) => grid.appendChild(createTrackCard(track, plIndex, tIdx)));

        const trackSection = document.createElement('section');
        trackSection.className = 'detail-section';
        trackSection.innerHTML = `<h3 class="detail-section-title">Tracks</h3>`;
        trackSection.appendChild(grid);
        cardGrid.appendChild(trackSection);

        bindDetailBreadcrumb(cardGrid);
        mainView.scrollTop = 0;
    }

    function bindDetailBreadcrumb(root) {
        root.querySelectorAll('[data-crumb="discover"]').forEach((btn) => {
            btn.onclick = () => window.PalmPlayNav.go('search');
        });
        root.querySelectorAll('.detail-hero-artist[data-artist-name]').forEach((btn) => {
            btn.onclick = () => openArtistPage(null, btn.getAttribute('data-artist-name'));
        });
    }

    function openArtistPage(artistId, artistName) {
        PalmPlayNav.push(state.currentView);
        renderArtistPage(artistId, artistName);
    }

    function openAlbumPage(albumId, albumName, artUrl) {
        PalmPlayNav.push(state.currentView);
        renderAlbumPage(albumId, albumName, artUrl);
    }

    window.openArtistPage = openArtistPage;
    window.openAlbumPage = openAlbumPage;

    async function fetchCatalogSongById(id) {
        if (!MUSIC_CATALOG_API_BASE || !id) return null;
        catalogTraffic.recordStart();
        try {
            const res = await fetch(`${MUSIC_CATALOG_API_BASE}/songs/${encodeURIComponent(id)}`, {
                signal: AbortSignal.timeout(8000)
            });
            const data = await res.json();
            const raw = data?.data;
            const item = Array.isArray(raw) ? raw[0] : raw;
            return parseCatalogSong(item);
        } catch (e) {
            console.warn('fetchCatalogSongById failed', e);
            return null;
        } finally {
            catalogTraffic.recordEnd();
        }
    }

    async function resolveTrackStream(track, forceRefresh = false) {
        if (!track) return null;
        if (!forceRefresh && track.url && !track._unplayable) return track.url;

        if (track.isCatalog && track.id) {
            const fresh = await fetchCatalogSongById(track.id);
            if (fresh?.url) return fresh.url;
        }

        if ((track.isAudius || track.isCatalogFallback) && track.id) {
            return `${AUDIUS_HOST}/v1/tracks/${track.id}/stream?app_name=${AUDIUS_APP_NAME}`;
        }

        const results = await fetchCatalogTracks(`${track.name} ${track.artist}`, 6);
        const match = results.find(r =>
            r.name?.toLowerCase() === track.name?.toLowerCase() &&
            r.artist?.toLowerCase() === track.artist?.toLowerCase()
        ) || results[0];
        return match?.url || null;
    }

    async function resolveTrackStreamSafe(track, forceRefresh = false, timeoutMs = 7000) {
        return Promise.race([
            resolveTrackStream(track, forceRefresh),
            new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
        ]);
    }

    function markTrackUnplayable(plIndex, tIndex) {
        const t = playlists[plIndex]?.tracks?.[tIndex];
        if (t) t._unplayable = true;
    }

    function onPlaybackFailed(track, plIndex, tIndex, autoNext = false) {
        markTrackUnplayable(plIndex, tIndex);
        showToast(`Can't play "${track.name}" — try another track`, 'fa-exclamation-triangle');
        state.isBuffering = false;
        state.isPlaying = false;
        updatePlayerUI();

        if (!autoNext) return;
        const pl = playlists[plIndex];
        if (!pl?.tracks?.length || pl.tracks.length < 2) return;
        autoSkipAttempts += 1;
        const maxAttempts = Math.min(pl.tracks.length, 6);
        if (autoSkipAttempts >= maxAttempts) {
            showToast('Auto-next stopped: multiple tracks failed', 'fa-exclamation-circle');
            autoSkipAttempts = 0;
            return;
        }
        const nextIdx = (tIndex + 1) % pl.tracks.length;
        if (nextIdx === tIndex) return;
        setTimeout(() => playTrack(plIndex, nextIdx, { autoNext: true }), 150);
    }

    function prefetchUpcomingTrack(plIndex, tIndex) {
        const pl = playlists[plIndex];
        if (!pl?.tracks?.length || pl.tracks.length < 2) return;
        ensureQueueForCurrentTrack(plIndex, tIndex, { keepExisting: true });
        const queuedNext = state.queueIndices.length > 1 ? state.queueIndices[1] : null;
        const nextIdx = Number.isInteger(queuedNext) ? queuedNext : (tIndex + 1) % pl.tracks.length;
        if (nextIdx === tIndex) return;
        const next = pl.tracks[nextIdx];
        if (!next || next.audioBlob || next.url || next._unplayable) return;

        resolveTrackStream(next, false)
            .then((url) => {
                if (url) {
                    pl.tracks[nextIdx].url = url;
                }
            })
            .catch((e) => {
                console.warn('Prefetch next track failed', e);
            });
    }

    function buildTrackShareUrl(track) {
        const appBase = `${location.origin}${ppRoutes().page('home')}`;
        if (track?.id && track.isCatalog) {
            return `${appBase}?play=${encodeURIComponent(track.id)}`;
        }
        const q = `${track?.name || ''} ${track?.artist || ''}`.trim();
        return `${appBase}?q=${encodeURIComponent(q)}`;
    }

    async function shareCurrentTrack() {
        if (state.currentPlaylistIndex < 0) {
            showToast('Play a song first to share', 'fa-share-alt');
            return;
        }
        const track = playlists[state.currentPlaylistIndex]?.tracks?.[state.currentTrackIndex];
        if (!track) return;

        const url = buildTrackShareUrl(track);
        const title = `${track.name} — ${track.artist}`;
        const text = `Listen on PalmPlay`;

        if (navigator.share) {
            try {
                await navigator.share({ title, text, url });
                return;
            } catch (e) {
                if (e?.name === 'AbortError') return;
            }
        }

        try {
            await navigator.clipboard.writeText(url);
            showToast('Link copied to clipboard', 'fa-link');
        } catch {
            showToast(url, 'fa-link');
        }
    }

    window.shareCurrentTrack = shareCurrentTrack;

    async function handlePlaybackDeepLink() {
        const params = new URLSearchParams(window.location.search);
        const playId = params.get('play');
        const q = params.get('q');
        if (!playId && !q) return;

        if (playId) {
            let track = await fetchCatalogSongById(playId);
            if (!track) {
                const audius = await fetchAudiusCatalogFallback(playId, 1);
                track = audius[0] || null;
            }
            if (track) {
                const idx = upsertTempPlaylist('deeplink', 'Shared track', [track]);
                await playTrack(idx, 0);
            } else {
                showToast('Could not open shared track', 'fa-link-slash');
            }
        } else if (q) {
            const decoded = decodeURIComponent(q);
            if (!ppRoutes().isExplorePage()) {
                window.location.href = `${ppRoutes().page('discover')}?q=${encodeURIComponent(decoded)}`;
                return;
            }
            window.PalmPlayNav?.go('search');
            const input = document.querySelector('.premium-search-input');
            if (input) {
                input.value = decoded;
                filterCards(decoded);
            }
        }

        const clean = window.location.pathname + (window.location.hash || '');
        history.replaceState(null, '', clean);
    }

    function waitForPlaybackReady(timeoutMs = 9000) {
        return new Promise((resolve) => {
            if (audio.readyState >= 2 && !audio.error) {
                resolve(true);
                return;
            }
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                audio.removeEventListener('playing', onPlaying);
                audio.removeEventListener('canplay', onCanPlay);
                audio.removeEventListener('error', onError);
                resolve(ok);
            };
            const onPlaying = () => finish(true);
            const onCanPlay = () => finish(true);
            const onError = () => finish(false);
            const timer = setTimeout(() => finish(!audio.error && audio.readyState >= 2), timeoutMs);
            audio.addEventListener('playing', onPlaying, { once: true });
            audio.addEventListener('canplay', onCanPlay, { once: true });
            audio.addEventListener('error', onError, { once: true });
        });
    }

    function playAudioWithTimeout(media, timeoutMs = 7000) {
        let timer = null;
        const started = Promise.resolve()
            .then(() => media.play())
            .then(() => true)
            .catch((e) => {
                console.warn('Audio play failed:', e);
                return false;
            });

        const timedOut = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
        });

        return Promise.race([started, timedOut]).finally(() => {
            if (timer) clearTimeout(timer);
        });
    }

    function getPlayHistory() {
        try {
            const raw = localStorage.getItem(PLAY_HISTORY_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    function recordPlayHistory(track) {
        if (!track?.url || !track?.name) return;
        const entry = {
            playedAt: Date.now(),
            id: track.id || null,
            name: track.name,
            artist: track.artist || 'Unknown',
            album: track.album || '',
            duration: track.duration || 0,
            url: track.url,
            art: track.art || DEFAULT_ART_URL,
            isAudius: !!track.isAudius,
            isCatalog: !!track.isCatalog,
            isCatalogFallback: !!track.isCatalogFallback
        };
        let hist = getPlayHistory().filter(h => !(h.name === entry.name && h.artist === entry.artist));
        hist.unshift(entry);
        hist = hist.slice(0, PLAY_HISTORY_MAX);
        localStorage.setItem(PLAY_HISTORY_KEY, JSON.stringify(hist));
    }

    function getTrackIdentity(track) {
        return `${normalizeTitleKey(track?.name)}::${primaryArtistKey(track?.artist)}`;
    }

    function loadPersonalFeedback() {
        try {
            const raw = localStorage.getItem(PERSONAL_FEEDBACK_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return {
                dislikeTracks: Array.isArray(parsed.dislikeTracks) ? parsed.dislikeTracks.slice(0, 200) : [],
                boostTracks: Array.isArray(parsed.boostTracks) ? parsed.boostTracks.slice(0, 200) : [],
                boostArtists: Array.isArray(parsed.boostArtists) ? parsed.boostArtists.slice(0, 120) : []
            };
        } catch {
            return { dislikeTracks: [], boostTracks: [], boostArtists: [] };
        }
    }

    function savePersonalFeedback(data) {
        try {
            localStorage.setItem(PERSONAL_FEEDBACK_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('Personal feedback save failed', e);
        }
    }

    function buildTasteProfile(historyList, likedList, feedback) {
        const artistScores = new Map();
        const trackScores = new Map();
        const languageScores = new Map();
        const now = Date.now();

        const boost = (map, key, value) => {
            if (!key) return;
            map.set(key, (map.get(key) || 0) + value);
        };

        (historyList || []).slice(0, 40).forEach((track, idx) => {
            const ageHours = Math.max(1, (now - (track.playedAt || now)) / (1000 * 60 * 60));
            const recencyWeight = Math.max(0.35, 1.8 / Math.log2(ageHours + 2));
            const rankWeight = Math.max(0.2, 1.4 - (idx * 0.03));
            const score = recencyWeight * rankWeight;
            boost(artistScores, primaryArtistKey(track.artist), score * 1.6);
            boost(trackScores, getTrackIdentity(track), score * 1.2);
            const lang = normalizeSearchText(track.language || '');
            if (lang) boost(languageScores, lang, score);
        });

        (likedList || []).slice(0, 120).forEach((liked, idx) => {
            const score = Math.max(0.6, 2.2 - (idx * 0.01));
            boost(artistScores, primaryArtistKey(liked.artist), score * 1.8);
            boost(trackScores, getTrackIdentity({ name: liked.trackName || liked.name, artist: liked.artist }), score * 2.4);
            const lang = normalizeSearchText(liked.language || '');
            if (lang) boost(languageScores, lang, score * 1.2);
        });

        (feedback?.boostArtists || []).forEach((artistKey) => boost(artistScores, artistKey, 5));
        (feedback?.boostTracks || []).forEach((trackKey) => boost(trackScores, trackKey, 7));

        return { artistScores, trackScores, languageScores };
    }

    function scoreForYouTrack(track, profile, feedback) {
        const tKey = getTrackIdentity(track);
        if (feedback.dislikeTracks.includes(tKey)) return -99999;
        const aKey = primaryArtistKey(track.artist);
        const langKey = normalizeSearchText(track.language || '');
        let score = 0;
        score += (profile.trackScores.get(tKey) || 0) * 3.2;
        score += (profile.artistScores.get(aKey) || 0) * 2.1;
        score += (profile.languageScores.get(langKey) || 0) * 1.2;
        score += Math.min(20, Math.log10((track.plays || 0) + 10) * 3.5);
        if (feedback.boostTracks.includes(tKey)) score += 32;
        if (feedback.boostArtists.includes(aKey)) score += 20;
        return score;
    }

    async function fetchForYouTracks(feed, history) {
        const feedback = loadPersonalFeedback();
        const profile = buildTasteProfile(history, likedSongs, feedback);

        const candidateLists = [];
        candidateLists.push(feed?.picks || []);
        candidateLists.push(feed?.trending || []);
        candidateLists.push((history || []).slice(0, 12));
        candidateLists.push((await getSpotifyAllTimePool()).slice(0, 45));

        const topArtists = Array.from(profile.artistScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([artist]) => artist)
            .filter(Boolean);
        if (topArtists.length) {
            const artistResults = await Promise.all(topArtists.map((a) => fetchCatalogTracks(a, 8).catch(() => [])));
            candidateLists.push(...artistResults);
        }

        const all = candidateLists.flat().filter(t => t && t.url && t.name);
        const deduped = [];
        const seen = new Set();
        all.forEach((t) => {
            const key = getTrackIdentity(t);
            if (seen.has(key)) return;
            seen.add(key);
            deduped.push(t);
        });

        const ranked = deduped
            .map((t) => ({ track: t, score: scoreForYouTrack(t, profile, feedback) }))
            .filter((x) => x.score > -1000)
            .sort((a, b) => b.score - a.score)
            .slice(0, 30)
            .map((x) => ({ ...x.track, _forYou: true }));

        return organizeTracksForSelection(ranked, 14);
    }

    function applyTrackFeedback(track, mode) {
        const data = loadPersonalFeedback();
        const tKey = getTrackIdentity(track);
        const aKey = primaryArtistKey(track.artist);
        const dislike = new Set(data.dislikeTracks);
        const boostTracks = new Set(data.boostTracks);
        const boostArtists = new Set(data.boostArtists);

        if (mode === 'hide') {
            dislike.add(tKey);
            boostTracks.delete(tKey);
            showToast('Less like this from now on', 'fa-ban');
        } else {
            boostTracks.add(tKey);
            boostArtists.add(aKey);
            dislike.delete(tKey);
            showToast('We will recommend more like this', 'fa-thumbs-up');
        }

        savePersonalFeedback({
            dislikeTracks: Array.from(dislike).slice(-200),
            boostTracks: Array.from(boostTracks).slice(-200),
            boostArtists: Array.from(boostArtists).slice(-120)
        });

        if (state.currentView === 'home') renderHome();
    }

    function upsertTempPlaylist(id, name, tracks) {
        let idx = playlists.findIndex(pl => pl.id === id);
        if (idx === -1) {
            playlists.push({ id, name, tracks, isTemporary: true });
            return playlists.length - 1;
        }
        playlists[idx].tracks = tracks;
        playlists[idx].name = name;
        return idx;
    }

    function findLikedSourceTrack(liked) {
        if (!liked) return null;
        const wantedName = liked.trackName || liked.name;
        const wantedArtist = liked.artist;
        const savedPlaylistId = liked.playlistId;
        const savedTrackIndex = Number(liked.trackIndex);

        if (savedPlaylistId != null && Number.isInteger(savedTrackIndex)) {
            const savedPl = playlists.find(pl => pl.id === savedPlaylistId && pl.id !== LIKED_SONGS_PLAYLIST_ID);
            const savedTrack = savedPl?.tracks?.[savedTrackIndex];
            if (savedTrack && savedTrack.name === wantedName && savedTrack.artist === wantedArtist) {
                return savedTrack;
            }
        }

        for (const pl of playlists) {
            if (!pl?.tracks?.length || pl.id === LIKED_SONGS_PLAYLIST_ID) continue;
            const match = pl.tracks.find(track => track.name === wantedName && track.artist === wantedArtist);
            if (match) return match;
        }
        return null;
    }

    function likedSongToPlayableTrack(liked) {
        const sourceTrack = findLikedSourceTrack(liked);
        const externalId = liked.externalId || sourceTrack?.externalId || null;
        const source = liked.source || sourceTrack?.source || null;
        const isCatalog = !!(liked.isCatalog || source === 'catalog' || sourceTrack?.isCatalog);
        const isAudius = !!(liked.isAudius || source === 'audius' || sourceTrack?.isAudius);
        const id = externalId || ((isCatalog || isAudius) ? (sourceTrack?.id || null) : (sourceTrack?.id || liked.id || null));

        return {
            ...(sourceTrack || {}),
            id,
            externalId,
            source,
            name: liked.trackName || sourceTrack?.name || 'Unknown',
            artist: liked.artist || sourceTrack?.artist || 'Unknown',
            album: liked.album || sourceTrack?.album || 'Liked Songs',
            duration: liked.duration || sourceTrack?.duration || 0,
            dateAdded: liked.dateAdded || sourceTrack?.dateAdded || null,
            url: sourceTrack?.url || liked.url || liked.streamUrl || null,
            art: liked.art || liked.artUrl || sourceTrack?.art || DEFAULT_ART_URL,
            artUrl: liked.artUrl || sourceTrack?.artUrl || sourceTrack?.art || null,
            isCatalog,
            isAudius,
            isCatalogFallback: !!(sourceTrack?.isCatalogFallback || isAudius)
        };
    }

    function ensureLikedSongsPlaylist() {
        const tracks = likedSongs.map(likedSongToPlayableTrack);
        return upsertTempPlaylist(LIKED_SONGS_PLAYLIST_ID, 'Liked Songs', tracks);
    }

    function normalizeSearchText(value) {
        return (value || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function tokenSet(value) {
        const stop = new Set(['the', 'a', 'an', 'and', 'with', 'feat', 'ft']);
        return new Set(
            normalizeSearchText(value)
                .split(' ')
                .filter(t => t && !stop.has(t))
        );
    }

    function scoreTokenOverlap(want, got) {
        if (!want.size || !got.size) return 0;
        let hit = 0;
        want.forEach((token) => {
            if (got.has(token)) hit += 1;
        });
        return hit / want.size;
    }

    function computeCuratedMatchScore(track, item) {
        if (!track) return 0;
        const targetTitle = normalizeSearchText(item.name);
        const sourceTitle = normalizeSearchText(track.name);
        const titleTokensScore = scoreTokenOverlap(tokenSet(item.name), tokenSet(track.name));
        let titleScore = titleTokensScore;
        if (sourceTitle === targetTitle) titleScore = 1;
        else if (sourceTitle.includes(targetTitle) || targetTitle.includes(sourceTitle)) {
            titleScore = Math.max(titleScore, 0.85);
        }

        const artistTarget = item.artist.split(',').map(a => a.trim()).filter(Boolean);
        const artistSource = String(track.artist || '').split(',').map(a => a.trim()).filter(Boolean);
        const artistScore = scoreTokenOverlap(
            tokenSet(artistTarget.join(' ')),
            tokenSet(artistSource.join(' '))
        );

        return (titleScore * 0.75) + (artistScore * 0.25);
    }

    function pickCuratedMatch(tracks, item) {
        if (!tracks?.length) return null;
        let bestTrack = null;
        let bestScore = -1;
        tracks.forEach((track) => {
            const score = computeCuratedMatchScore(track, item);
            if (score > bestScore) {
                bestScore = score;
                bestTrack = track;
            }
        });
        if (!bestTrack) return null;
        return { track: bestTrack, score: bestScore };
    }

    async function fetchCuratedTrendingTracks(limit = 20) {
        const list = (window.PALMPLAY_CURATED_TRENDING || []).slice(0, limit);
        if (!list.length) return fetchAudiusCatalogFallback('trending', limit);

        const resolved = [];
        const batchSize = 4;
        for (let i = 0; i < list.length; i += batchSize) {
            const batch = list.slice(i, i + batchSize);
            const chunk = await Promise.all(
                batch.map(async (item) => {
                    const q = `${item.name} ${item.artist}`;
                    try {
                        let tracks = await fetchCatalogTracks(q, 8);
                        if (!tracks.length) tracks = await fetchAudiusCatalogFallback(q, 8);
                        let picked = pickCuratedMatch(tracks, item);
                        if (!picked || picked.score < 0.62) {
                            const retryTracks = await fetchCatalogTracks(item.name, 8);
                            const retryPicked = pickCuratedMatch(retryTracks, item);
                            if (retryPicked && (!picked || retryPicked.score > picked.score)) {
                                picked = retryPicked;
                            }
                        }
                        const match = picked?.track;
                        if (!match?.url) return null;
                        const confidentArt = (picked?.score || 0) >= 0.7;
                        return {
                            ...match,
                            name: item.name,
                            artist: item.artist,
                            art: confidentArt ? (match.art || DEFAULT_ART_URL) : DEFAULT_ART_URL
                        };
                    } catch (e) {
                        console.warn('Curated track resolve failed:', q, e);
                        return null;
                    }
                })
            );
            resolved.push(...chunk.filter(Boolean));
        }
        return resolved.length ? resolved : fetchAudiusCatalogFallback('trending', limit);
    }

    async function getSpotifyAllTimePool() {
        if (spotifyAllTimePoolCache?.length) return spotifyAllTimePoolCache;
        const tracks = await fetchCuratedTrendingTracks(80);
        spotifyAllTimePoolCache = organizeTracksForSelection(tracks, 80);
        return spotifyAllTimePoolCache;
    }

    async function fetchHomeFeed() {
        try {
            const cached = sessionStorage.getItem(HOME_FEED_CACHE_KEY);
            if (cached) {
                const { ts, data } = JSON.parse(cached);
                if (Date.now() - ts < HOME_FEED_TTL_MS && data) return data;
            }
        } catch (e) {
            console.warn('Home feed cache read failed', e);
        }

        const [trending, picks] = await Promise.all([
            fetchCuratedTrendingTracks(20),
            fetchCatalogTracks('latest hits', 12)
        ]);

        const data = { trending: trending || [], picks: picks || [] };
        try {
            sessionStorage.setItem(HOME_FEED_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
        } catch (e) {
            console.warn('Home feed cache write failed', e);
        }
        return data;
    }

    function normalizeStreamTrack(track) {
        return {
            id: track.id ?? track.externalId ?? null,
            name: track.name || 'Unknown',
            artist: track.artist || 'Unknown',
            album: track.album || 'Single',
            duration: track.duration || 0,
            url: track.url || track.streamUrl || null,
            art: track.art || track.artUrl || DEFAULT_ART_URL,
            isCatalog: !!(track.isCatalog || track.source === 'catalog'),
            isAudius: !!(track.isAudius || track.source === 'audius'),
            isCatalogFallback: !!track.isCatalogFallback
        };
    }

    function getTrackSource(track) {
        if (track.audioBlob) return 'local';
        if (track.isCatalog || track.source === 'catalog') return 'catalog';
        if (track.isAudius || track.source === 'audius') return 'audius';
        return 'stream';
    }

    function isUserPlaylist(pl) {
        return pl && !pl.isTemporary && typeof pl.id === 'number';
    }

    function trackExistsInPlaylist(pl, track) {
        const norm = normalizeStreamTrack(track);
        return pl.tracks.some((t) => {
            if (norm.id && t.id && String(t.id) === String(norm.id)) {
                const src = getTrackSource(t);
                const ns = getTrackSource(norm);
                if (src === ns || (src !== 'local' && ns !== 'local')) return true;
            }
            return t.name === norm.name && t.artist === norm.artist;
        });
    }

    async function createUserPlaylist(name, options = {}) {
        const user = getSavedUser();
        const uid = getUserId(user);
        if (!uid) {
            showToast('Log in to create playlists', 'fa-user-lock');
            ppRoutes().go('login');
            return -1;
        }
        const trimmed = (name || '').trim();
        if (!trimmed) return -1;

        const plId = await db.playlists.add({
            name: trimmed,
            userId: uid,
            updatedAt: new Date().toISOString()
        });
        const pl = { id: plId, name: trimmed, tracks: [] };
        playlists.push(pl);
        if (!options.silent) {
            renderSidebar();
            showToast(`Playlist "${trimmed}" created`, 'fa-list');
            window.PalmPlaySync?.pushPlaylist?.(pl).catch((e) => console.warn('Cloud playlist push', e));
        }
        return playlists.length - 1;
    }

    async function addTrackToUserPlaylist(plIndex, rawTrack) {
        const user = getSavedUser();
        const uid = getUserId(user);
        if (!uid) {
            showToast('Log in to save to playlists', 'fa-user-lock');
            ppRoutes().go('login');
            return false;
        }

        const pl = playlists[plIndex];
        if (!isUserPlaylist(pl)) return false;

        const track = normalizeStreamTrack(rawTrack);
        if (!track.url) {
            showToast('This track cannot be saved (no stream URL)', 'fa-exclamation-triangle');
            return false;
        }

        if (trackExistsInPlaylist(pl, track)) {
            showToast(`Already in "${pl.name}"`, 'fa-info-circle');
            return false;
        }

        const source = getTrackSource(track);
        const dbId = await db.tracks.add({
            userId: uid,
            playlistId: pl.id,
            source,
            externalId: track.id ? String(track.id) : null,
            name: track.name,
            artist: track.artist,
            album: track.album,
            duration: track.duration,
            streamUrl: track.url,
            artUrl: track.art,
            dateAdded: new Date().toISOString()
        });

        pl.tracks.push({
            ...track,
            dbId,
            source
        });

        await db.playlists.update(pl.id, { updatedAt: new Date().toISOString() });
        showToast(`Added to "${pl.name}"`, 'fa-plus-circle');
        renderSidebar();
        if (state.currentView === 'home') renderHome();
        window.PalmPlaySync?.pushPlaylist?.(pl).then(() => window.PalmPlaySync?.pushPlaylistTracks?.(pl))
            .catch((e) => console.warn('Cloud track push', e));
        return true;
    }

    async function addTracksToUserPlaylistBatch(plIndex, rawTracks, options = {}) {
        const user = getSavedUser();
        const uid = getUserId(user);
        const pl = playlists[plIndex];
        if (!uid || !isUserPlaylist(pl) || !Array.isArray(rawTracks) || !rawTracks.length) return 0;

        const rows = [];
        const staged = [];
        for (const rawTrack of rawTracks) {
            const track = normalizeStreamTrack(rawTrack);
            if (!track.url || trackExistsInPlaylist(pl, track)) continue;

            const source = getTrackSource(track);
            rows.push({
                userId: uid,
                playlistId: pl.id,
                source,
                externalId: track.id ? String(track.id) : null,
                name: track.name,
                artist: track.artist,
                album: track.album,
                duration: track.duration,
                streamUrl: track.url,
                artUrl: track.art,
                dateAdded: new Date().toISOString()
            });
            staged.push({ ...track, source });
        }

        if (!staged.length) return 0;

        let ids = [];
        try {
            ids = await db.tracks.bulkAdd(rows, { allKeys: true });
        } catch (bulkErr) {
            ids = [];
            for (const row of rows) {
                const id = await db.tracks.add(row);
                ids.push(id);
            }
        }

        staged.forEach((track, i) => {
            pl.tracks.push({
                ...track,
                dbId: ids[i]
            });
        });

        const added = staged.length;
        await db.playlists.update(pl.id, { updatedAt: new Date().toISOString() });
        if (!options.suppressUiRefresh) {
            renderSidebar();
            if (state.currentView === 'home') renderHome();
        }
        if (!options.suppressCloudSync) {
            window.PalmPlaySync?.pushPlaylist?.(pl).then(() => window.PalmPlaySync?.pushPlaylistTracks?.(pl))
                .catch((e) => console.warn('Cloud batch track push', e));
        }
        return added;
    }

    function isSpotifyConfigured() {
        return !!SPOTIFY_CLIENT_ID;
    }

    function getSpotifyRedirectUri() {
        const homePath = ppRoutes()?.page?.('home') || '/pamplay-frontend/home.html';
        return `${location.origin}${homePath}`;
    }

    function loadSpotifyTokens() {
        try {
            const raw = localStorage.getItem(SPOTIFY_TOKEN_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (!parsed?.accessToken) return null;
            return parsed;
        } catch {
            return null;
        }
    }

    function saveSpotifyPkceSession(stateToken, verifier) {
        sessionStorage.setItem(SPOTIFY_PKCE_STATE_KEY, stateToken);
        sessionStorage.setItem(SPOTIFY_PKCE_VERIFIER_KEY, verifier);
        try {
            localStorage.setItem(SPOTIFY_PKCE_CACHE_KEY, JSON.stringify({
                state: stateToken,
                verifier,
                createdAt: Date.now()
            }));
        } catch (e) {
            console.warn('Spotify PKCE cache save failed', e);
        }
    }

    function loadSpotifyPkceSession() {
        let state = sessionStorage.getItem(SPOTIFY_PKCE_STATE_KEY);
        let verifier = sessionStorage.getItem(SPOTIFY_PKCE_VERIFIER_KEY);
        if (state && verifier) return { state, verifier };
        try {
            const raw = localStorage.getItem(SPOTIFY_PKCE_CACHE_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            const fresh = parsed && (Date.now() - Number(parsed.createdAt || 0)) < (30 * 60 * 1000);
            if (!fresh || !parsed?.state || !parsed?.verifier) return null;
            state = parsed.state;
            verifier = parsed.verifier;
            sessionStorage.setItem(SPOTIFY_PKCE_STATE_KEY, state);
            sessionStorage.setItem(SPOTIFY_PKCE_VERIFIER_KEY, verifier);
            return { state, verifier };
        } catch {
            return null;
        }
    }

    function clearSpotifyPkceSession() {
        sessionStorage.removeItem(SPOTIFY_PKCE_STATE_KEY);
        sessionStorage.removeItem(SPOTIFY_PKCE_VERIFIER_KEY);
        localStorage.removeItem(SPOTIFY_PKCE_CACHE_KEY);
    }

    function saveSpotifyTokens(payload) {
        if (!payload?.access_token) return;
        const current = loadSpotifyTokens() || {};
        const expiresIn = Math.max(300, Number(payload.expires_in || 3600));
        const next = {
            accessToken: payload.access_token,
            refreshToken: payload.refresh_token || current.refreshToken || '',
            expiresAt: Date.now() + ((expiresIn - 60) * 1000)
        };
        localStorage.setItem(SPOTIFY_TOKEN_KEY, JSON.stringify(next));
    }

    async function getValidSpotifyAccessToken() {
        const stored = loadSpotifyTokens();
        if (!stored) return null;
        if (stored.accessToken && Date.now() < (stored.expiresAt || 0)) return stored.accessToken;
        if (!stored.refreshToken) return null;

        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: stored.refreshToken,
            client_id: SPOTIFY_CLIENT_ID
        });
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        if (!res.ok) throw new Error('Spotify token refresh failed');
        const data = await res.json();
        saveSpotifyTokens(data);
        return data.access_token;
    }

    async function startSpotifyConnect(autoImport = true, forcePrompt = false) {
        if (!isSpotifyConfigured()) {
            showToast('Spotify connect is not configured yet', 'fa-exclamation-triangle');
            return;
        }
        const verifier = randomToken(96);
        const stateToken = randomToken(24);
        const challenge = await pkceChallenge(verifier);
        saveSpotifyPkceSession(stateToken, verifier);
        sessionStorage.setItem(SPOTIFY_AUTO_IMPORT_KEY, autoImport ? '1' : '0');
        const params = new URLSearchParams({
            client_id: SPOTIFY_CLIENT_ID,
            response_type: 'code',
            redirect_uri: getSpotifyRedirectUri(),
            code_challenge_method: 'S256',
            code_challenge: challenge,
            scope: SPOTIFY_SCOPES,
            state: stateToken,
            show_dialog: forcePrompt ? 'true' : 'false'
        });
        window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
    }

    async function handleSpotifyOAuthCallback() {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('code');
        const returnedState = params.get('state');
        const error = params.get('error');
        if (!code && !error) return false;

        if (error) {
            showToast(`Spotify auth failed: ${error}`, 'fa-exclamation-triangle');
            clearSpotifyPkceSession();
            sessionStorage.removeItem(SPOTIFY_FORBIDDEN_RETRY_KEY);
            history.replaceState(null, '', window.location.pathname + (window.location.hash || ''));
            return true;
        }

        const pkce = loadSpotifyPkceSession();
        const expectedState = pkce?.state || '';
        const verifier = pkce?.verifier || '';
        if (!expectedState || !verifier || returnedState !== expectedState) {
            showToast('Spotify login session expired. Try again.', 'fa-exclamation-triangle');
            clearSpotifyPkceSession();
            sessionStorage.removeItem(SPOTIFY_FORBIDDEN_RETRY_KEY);
            history.replaceState(null, '', window.location.pathname + (window.location.hash || ''));
            return true;
        }

        const tokenParams = new URLSearchParams({
            client_id: SPOTIFY_CLIENT_ID,
            grant_type: 'authorization_code',
            code,
            redirect_uri: getSpotifyRedirectUri(),
            code_verifier: verifier
        });
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenParams.toString()
        });
        if (!res.ok) {
            showToast('Spotify connection failed', 'fa-exclamation-triangle');
            history.replaceState(null, '', window.location.pathname + (window.location.hash || ''));
            return true;
        }
        const payload = await res.json();
        saveSpotifyTokens(payload);
        clearSpotifyPkceSession();
        sessionStorage.removeItem(SPOTIFY_FORBIDDEN_RETRY_KEY);
        showToast('Spotify connected', 'fa-check-circle');
        history.replaceState(null, '', window.location.pathname + (window.location.hash || ''));
        return true;
    }

    function isSpotifyForbiddenError(err) {
        const msg = (err?.message || '').toLowerCase();
        return /\b403\b/.test(msg) || msg.includes('forbidden');
    }

    async function trySpotifyReconnectOnForbidden() {
        localStorage.removeItem(SPOTIFY_TOKEN_KEY);
        const hasRetried = sessionStorage.getItem(SPOTIFY_FORBIDDEN_RETRY_KEY) === '1';
        if (hasRetried) return false;
        sessionStorage.setItem(SPOTIFY_FORBIDDEN_RETRY_KEY, '1');
        showToast('Refreshing Spotify connection...', 'fa-sync');
        await startSpotifyConnect(true, true);
        return true;
    }

    async function spotifyApiGet(path) {
        const token = await getValidSpotifyAccessToken();
        if (!token) throw new Error('Spotify not connected');
        const url = path.startsWith('http')
            ? path
            : `https://api.spotify.com${path.startsWith('/') ? path : `/${path}`}`;
        for (let attempt = 0; attempt < 3; attempt++) {
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (res.ok) return res.json();
            if (res.status === 401) {
                localStorage.removeItem(SPOTIFY_TOKEN_KEY);
                throw new Error('Spotify auth expired');
            }
            const retriable = res.status === 429 || res.status >= 500;
            if (!retriable || attempt === 2) {
                let detail = '';
                try {
                    const body = await res.json();
                    const message = body?.error?.message || body?.error_description || '';
                    const statusFromBody = body?.error?.status;
                    if (statusFromBody || message) {
                        detail = `${statusFromBody || res.status}${message ? `: ${message}` : ''}`;
                    }
                } catch {
                    detail = '';
                }
                throw new Error(`Spotify API failed ${detail || `${res.status} ${res.statusText}`.trim()}`);
            }
            const backoffMs = 450 * (attempt + 1);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
        throw new Error('Spotify API failed');
    }

    async function spotifyPaginate(path, itemsKey = 'items', pageLimit = 200, maxItems = Infinity) {
        let next = path;
        const all = [];
        let guard = 0;
        while (next && guard < pageLimit) {
            guard += 1;
            const data = await spotifyApiGet(next);
            const items = Array.isArray(data?.[itemsKey]) ? data[itemsKey] : [];
            all.push(...items);
            if (all.length >= maxItems) {
                all.length = Math.min(all.length, maxItems);
                break;
            }
            next = data?.next || null;
        }
        return all;
    }

    async function mapConcurrent(items, concurrency, mapper) {
        const out = new Array(items.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
            while (cursor < items.length) {
                const i = cursor++;
                out[i] = await mapper(items[i], i);
            }
        });
        await Promise.all(workers);
        return out;
    }

    function spotifyTrackToEntry(track) {
        if (!track?.name) return null;
        const artists = Array.isArray(track.artists) ? track.artists.map(a => a?.name).filter(Boolean).join(', ') : '';
        return {
            name: track.name,
            artist: artists
        };
    }

    function dedupeImportEntries(entries) {
        const seen = new Set();
        return entries.filter((entry) => {
            const key = `${normalizeTitleKey(entry?.name)}::${primaryArtistKey(entry?.artist)}`;
            if (!entry?.name || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function formatImportEntryLabel(entry) {
        if (!entry) return 'Unknown track';
        const name = (entry.name || '').trim();
        const artist = (entry.artist || '').trim();
        return artist ? `${name} — ${artist}` : name;
    }

    async function resolveEntriesToTracks(entries, maxEntries = 350, lookupCache = new Map()) {
        const capped = dedupeImportEntries(entries).slice(0, maxEntries);
        const out = [];
        let misses = 0;
        const missingEntries = [];
        const batch = SPOTIFY_RESOLVE_BATCH_SIZE;
        for (let i = 0; i < capped.length; i += batch) {
            const chunk = capped.slice(i, i + batch);
            const resolved = await Promise.all(chunk.map(async (entry) => {
                const cacheKey = `${normalizeTitleKey(entry?.name)}::${primaryArtistKey(entry?.artist)}`;
                if (lookupCache.has(cacheKey)) {
                    const cached = lookupCache.get(cacheKey);
                    return { entry, track: cached.track, reason: cached.reason || '' };
                }
                try {
                    const track = await resolveImportedTrack(entry);
                    const payload = { track, reason: track ? '' : 'No match in catalog' };
                    lookupCache.set(cacheKey, payload);
                    return { entry, track: payload.track, reason: payload.reason };
                } catch {
                    const payload = { track: null, reason: 'Lookup failed' };
                    lookupCache.set(cacheKey, payload);
                    return { entry, track: payload.track, reason: payload.reason };
                }
            }));
            resolved.forEach(({ entry, track, reason }) => {
                if (track) {
                    out.push(track);
                } else {
                    misses += 1;
                    missingEntries.push({
                        label: formatImportEntryLabel(entry),
                        reason
                    });
                }
            });
        }
        return { tracks: out, misses, missingEntries };
    }

    async function importEntriesAsPlaylist(entries, playlistName, lookupCache = new Map()) {
        const plIndex = await createUserPlaylist(playlistName, { silent: true });
        if (plIndex < 0) {
            return {
                added: 0,
                misses: entries.length,
                missingEntries: entries.map((entry) => ({
                    label: formatImportEntryLabel(entry),
                    reason: 'Playlist creation failed'
                }))
            };
        }
        const { tracks, misses, missingEntries } = await resolveEntriesToTracks(entries, 350, lookupCache);
        const added = await addTracksToUserPlaylistBatch(plIndex, tracks, {
            suppressUiRefresh: true,
            suppressCloudSync: true
        });
        return { plIndex, added, misses, missingEntries };
    }

    function showTransferProgressModal() {
        const container = document.getElementById('modal-container');
        const titleEl = document.getElementById('modal-title');
        const messageEl = document.getElementById('modal-message');
        const inputEl = document.getElementById('modal-input');
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');
        if (!container || !titleEl || !messageEl || !inputEl || !confirmBtn || !cancelBtn) return;

        titleEl.textContent = 'Transfer My Music';
        messageEl.innerHTML = `
            <div class="transfer-flow">
                <div class="transfer-flow-icon"><i class="fas fa-compact-disc"></i></div>
                <div class="transfer-flow-title" id="transfer-flow-title">Preparing transfer...</div>
                <div class="transfer-flow-sub" id="transfer-flow-sub">Please keep this screen open.</div>
                <div class="transfer-flow-progress">
                    <div class="transfer-flow-progress-fill" id="transfer-flow-progress-fill"></div>
                </div>
            </div>
        `;
        inputEl.style.display = 'none';
        confirmBtn.style.display = 'none';
        cancelBtn.style.display = 'inline-flex';
        cancelBtn.textContent = 'Close';
        cancelBtn.onclick = () => {
            container.style.display = 'none';
        };
        container.style.display = 'flex';
    }

    function updateTransferProgress(title, subtitle, percent = null) {
        const t = document.getElementById('transfer-flow-title');
        const s = document.getElementById('transfer-flow-sub');
        const fill = document.getElementById('transfer-flow-progress-fill');
        if (t) t.textContent = title || 'Working...';
        if (s) s.textContent = subtitle || '';
        if (fill && percent != null && Number.isFinite(percent)) {
            fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        }
    }

    function finishTransferProgress({ added = 0, misses = 0, playlists = 0, plIndex = -1, logs = [] }) {
        const iconWrap = document.querySelector('.transfer-flow-icon');
        const messageEl = document.getElementById('modal-message');
        if (iconWrap) iconWrap.innerHTML = '<i class="fas fa-check-circle"></i>';
        updateTransferProgress(
            `Imported ${added} songs`,
            misses ? `${misses} songs were not available in our catalog.` : 'Everything found was imported.',
            100
        );

        if (messageEl) {
            const footer = document.createElement('div');
            footer.className = 'transfer-flow-result';
            footer.innerHTML = `
                <div><strong>${playlists}</strong> playlists created</div>
                <div><strong>${added}</strong> tracks added</div>
                <div><strong>${misses}</strong> unavailable</div>
                <button type="button" class="transfer-open-btn" id="transfer-open-btn">Open Imported Library</button>
                <button type="button" class="transfer-log-toggle" id="transfer-log-toggle">View Transfer Logs</button>
                <div class="transfer-log-panel" id="transfer-log-panel" hidden>
                    <div class="transfer-log-head">
                        <span>Unavailable tracks</span>
                        <button type="button" class="transfer-log-copy" id="transfer-log-copy">Copy logs</button>
                    </div>
                    <div class="transfer-log-list" id="transfer-log-list"></div>
                </div>
            `;
            messageEl.appendChild(footer);
            document.getElementById('transfer-open-btn')?.addEventListener('click', () => {
                if (plIndex >= 0) showPlaylist(plIndex);
                const container = document.getElementById('modal-container');
                if (container) container.style.display = 'none';
            });
            const logBtn = document.getElementById('transfer-log-toggle');
            const logPanel = document.getElementById('transfer-log-panel');
            const logList = document.getElementById('transfer-log-list');
            const copyBtn = document.getElementById('transfer-log-copy');
            const normalizedLogs = Array.isArray(logs) ? logs : [];
            if (logList) {
                if (!normalizedLogs.length) {
                    logList.innerHTML = '<div class="transfer-log-empty">No unavailable tracks. Everything matched.</div>';
                } else {
                    logList.innerHTML = normalizedLogs.map((item) => `
                        <div class="transfer-log-row">
                            <div class="transfer-log-track">${escapeHtml(item.track || 'Unknown')}</div>
                            <div class="transfer-log-meta">${escapeHtml(item.playlist || 'Library')} · ${escapeHtml(item.reason || 'Unavailable')}</div>
                        </div>
                    `).join('');
                }
            }
            logBtn?.addEventListener('click', () => {
                if (!logPanel) return;
                const hidden = logPanel.hasAttribute('hidden');
                if (hidden) {
                    logPanel.removeAttribute('hidden');
                    logBtn.textContent = 'Hide Transfer Logs';
                } else {
                    logPanel.setAttribute('hidden', '');
                    logBtn.textContent = 'View Transfer Logs';
                }
            });
            copyBtn?.addEventListener('click', async () => {
                const text = normalizedLogs.length
                    ? normalizedLogs.map((item) => `[${item.playlist || 'Library'}] ${item.track} — ${item.reason || 'Unavailable'}`).join('\n')
                    : 'No unavailable tracks. Everything matched.';
                try {
                    await navigator.clipboard.writeText(text);
                    showToast('Transfer logs copied', 'fa-copy');
                } catch {
                    showToast('Could not copy logs', 'fa-exclamation-triangle');
                }
            });
        }
    }

    async function importSpotifyLibraryToPalmPlay() {
        if (!isUserLoggedIn()) {
            showToast('Log in to import Spotify library', 'fa-user-lock');
            ppRoutes().go('login');
            return { started: false, reason: 'login_required' };
        }
        if (!isSpotifyConfigured()) {
            showToast('Set SPOTIFY_CLIENT_ID first', 'fa-exclamation-triangle');
            return { started: false, reason: 'spotify_not_configured' };
        }
        let token = null;
        try {
            token = await getValidSpotifyAccessToken();
        } catch (err) {
            console.warn('Spotify token check failed before import', err);
        }
        if (!token) {
            await startSpotifyConnect(true, true);
            return { started: true, oauthRedirected: true, reason: 'spotify_not_connected' };
        }
        showTransferProgressModal();
        updateTransferProgress('Connecting Spotify...', 'Authorizing and preparing your library import.', 6);
        let totalAdded = 0;
        let totalMisses = 0;
        let lastPlaylistIndex = -1;
        let importedPlaylistCount = 0;
        const transferLogs = [];
        const resolveCache = new Map();
        const importedPlIndices = [];
        const withErrorDetail = (baseReason, err) => {
            const msg = (err?.message || '').trim();
            return msg ? `${baseReason} (${msg})` : baseReason;
        };
        let needsSpotifyReconnect = false;
        updateTransferProgress('Importing liked songs...', 'Fetching your Spotify liked songs.', 15);
        let likedEntries = [];
        try {
            const savedItems = await spotifyPaginate('/v1/me/tracks?limit=50', 'items', 60, SPOTIFY_MAX_LIKED_IMPORT);
            likedEntries = savedItems
                .map(item => spotifyTrackToEntry(item?.track))
                .filter(Boolean);
        } catch (err) {
            console.warn('Spotify liked fetch failed', err);
            if (isSpotifyForbiddenError(err)) needsSpotifyReconnect = true;
            transferLogs.push({
                playlist: 'Spotify Liked Songs',
                track: '(batch)',
                reason: withErrorDetail('Could not fetch liked songs this run', err)
            });
        }

        updateTransferProgress('Importing playlists...', 'Reading your Spotify playlists.', 28);
        let playlistsMeta = [];
        try {
            playlistsMeta = await spotifyPaginate('/v1/me/playlists?limit=50', 'items', 40, SPOTIFY_MAX_PLAYLISTS_IMPORT);
        } catch (err) {
            console.warn('Spotify playlist list fetch failed', err);
            if (isSpotifyForbiddenError(err)) needsSpotifyReconnect = true;
            transferLogs.push({
                playlist: 'Spotify Playlists',
                track: '(batch)',
                reason: withErrorDetail('Could not fetch playlist list this run', err)
            });
        }

        if (needsSpotifyReconnect && !likedEntries.length && !playlistsMeta.length) {
            const redirected = await trySpotifyReconnectOnForbidden();
            if (redirected) {
                return { started: true, oauthRedirected: true, blocked403: true, added: 0, misses: 0, playlists: 0 };
            }
        }

        if (likedEntries.length) {
            updateTransferProgress('Matching tracks...', 'Matching liked songs in PalmPlay catalog.', 36);
            try {
                const likedResult = await importEntriesAsPlaylist(
                    likedEntries,
                    `Spotify Liked Songs ${new Date().toLocaleDateString()}`,
                    resolveCache
                );
                totalAdded += likedResult.added || 0;
                totalMisses += likedResult.misses || 0;
                lastPlaylistIndex = likedResult.plIndex ?? lastPlaylistIndex;
                if ((likedResult.added || 0) > 0) importedPlaylistCount += 1;
                if (typeof likedResult.plIndex === 'number') importedPlIndices.push(likedResult.plIndex);
                (likedResult.missingEntries || []).forEach((miss) => {
                    transferLogs.push({
                        playlist: 'Spotify Liked Songs',
                        track: miss.label,
                        reason: miss.reason
                    });
                });
            } catch (err) {
                console.warn('Liked import failed', err);
                transferLogs.push({
                    playlist: 'Spotify Liked Songs',
                    track: '(batch)',
                    reason: withErrorDetail('Could not import liked songs this run', err)
                });
            }
        }

        updateTransferProgress('Preparing playlists...', 'Fetching playlist tracks in parallel.', 40);
        const prefetchedPlaylists = await mapConcurrent(
            playlistsMeta,
            SPOTIFY_PREFETCH_CONCURRENCY,
            async (pl) => {
                if (!pl?.id || !pl?.name) return { pl, entries: [], failed: false, error: null };
                try {
                    const items = await spotifyPaginate(
                        `/v1/playlists/${encodeURIComponent(pl.id)}/tracks?limit=100`,
                        'items',
                        30,
                        SPOTIFY_MAX_PLAYLIST_TRACKS_IMPORT
                    );
                    const entries = items
                        .map(item => spotifyTrackToEntry(item?.track))
                        .filter(Boolean);
                    return { pl, entries, failed: false, error: null };
                } catch (err) {
                    console.warn('Playlist prefetch failed', pl.name, err);
                    return { pl, entries: [], failed: true, error: err };
                }
            }
        );

        const totalPlaylists = Math.max(1, prefetchedPlaylists.length);
        for (let idx = 0; idx < prefetchedPlaylists.length; idx++) {
            const { pl, entries, failed, error } = prefetchedPlaylists[idx];
            if (!pl?.name) continue;
            const pct = 48 + Math.round((idx / totalPlaylists) * 42);
            updateTransferProgress(`Importing "${pl.name}"`, 'Matching tracks and creating playlist.', pct);
            if (failed) {
                transferLogs.push({
                    playlist: pl.name,
                    track: '(batch)',
                    reason: withErrorDetail('Could not fetch this playlist this run', error)
                });
                continue;
            }
            if (!entries.length) continue;
            try {
                const result = await importEntriesAsPlaylist(entries, `${pl.name} (Spotify)`, resolveCache);
                totalAdded += result.added || 0;
                totalMisses += result.misses || 0;
                if (typeof result.plIndex === 'number') lastPlaylistIndex = result.plIndex;
                if ((result.added || 0) > 0) importedPlaylistCount += 1;
                if (typeof result.plIndex === 'number') importedPlIndices.push(result.plIndex);
                (result.missingEntries || []).forEach((miss) => {
                    transferLogs.push({
                        playlist: pl.name,
                        track: miss.label,
                        reason: miss.reason
                    });
                });
            } catch (err) {
                console.warn('Playlist import failed', pl.name, err);
                transferLogs.push({
                    playlist: pl.name,
                    track: '(batch)',
                    reason: withErrorDetail('Could not import this playlist this run', err)
                });
            }
        }

        renderSidebar();
        if (state.currentView === 'home') renderHome();
        setTimeout(() => {
            importedPlIndices.forEach((idx) => {
                const pl = playlists[idx];
                if (!pl || !isUserPlaylist(pl)) return;
                window.PalmPlaySync?.pushPlaylist?.(pl).then(() => window.PalmPlaySync?.pushPlaylistTracks?.(pl))
                    .catch((e) => console.warn('Cloud transfer sync', e));
            });
        }, 0);

        if (totalAdded > 0) {
            showToast(`Spotify imported: ${totalAdded} tracks${totalMisses ? ` (${totalMisses} unavailable)` : ''}`, 'fa-check-circle');
            finishTransferProgress({
                added: totalAdded,
                misses: totalMisses,
                playlists: importedPlaylistCount,
                plIndex: lastPlaylistIndex,
                logs: transferLogs
            });
            return {
                started: true,
                blocked403: false,
                added: totalAdded,
                misses: totalMisses,
                playlists: importedPlaylistCount
            };
        } else {
            showToast('Transfer finished. No new matched songs this run.', 'fa-info-circle');
            finishTransferProgress({
                added: 0,
                misses: totalMisses,
                playlists: importedPlaylistCount,
                plIndex: -1,
                logs: transferLogs
            });
            return {
                started: true,
                blocked403: needsSpotifyReconnect && !likedEntries.length && !playlistsMeta.length,
                added: 0,
                misses: totalMisses,
                playlists: importedPlaylistCount
            };
        }
    }

    let modalConfirmPrevDisplay = '';

    function closePlaylistPickerModal() {
        const container = document.getElementById('modal-container');
        const confirmBtn = document.getElementById('modal-confirm');
        const messageEl = document.getElementById('modal-message');
        if (confirmBtn) confirmBtn.style.display = modalConfirmPrevDisplay || '';
        if (messageEl) messageEl.innerHTML = '';
        if (container) container.style.display = 'none';
    }

    async function resolveImportedTrack(entry) {
        const query = `${entry.name} ${entry.artist || ''}`.trim();
        let tracks = await fetchCatalogTracks(query, 6);
        if (!tracks.length) tracks = await fetchAudiusCatalogFallback(query, 8);
        if (!tracks.length) return null;

        const picked = pickCuratedMatch(tracks, {
            name: entry.name || query,
            artist: entry.artist || ''
        });
        if (picked?.track && picked.score >= 0.4) return picked.track;
        return tracks[0] || null;
    }

    async function importFromApps(rawText, playlistName) {
        const entries = parseImportedTrackEntries(rawText).slice(0, 80);
        if (!entries.length) {
            showToast('Paste track list text or CSV first', 'fa-file-import');
            return;
        }

        const plName = (playlistName || '').trim() || `Imported ${new Date().toLocaleDateString()}`;
        const plIndex = await createUserPlaylist(plName);
        if (plIndex < 0) return;

        const resolvedTracks = [];
        let misses = 0;
        for (const entry of entries) {
            const match = await resolveImportedTrack(entry);
            if (match) resolvedTracks.push(match);
            else misses += 1;
        }

        const added = await addTracksToUserPlaylistBatch(plIndex, resolvedTracks);
        if (added > 0) {
            showToast(`Imported ${added} tracks${misses ? ` (${misses} not found)` : ''}`, 'fa-check-circle');
            showPlaylist(plIndex);
        } else {
            showToast('Could not import tracks from that list', 'fa-exclamation-triangle');
        }
    }

    function showImportFromAppsModal() {
        if (!isUserLoggedIn()) {
            showToast('Log in to import playlists', 'fa-user-lock');
            ppRoutes().go('login');
            return;
        }

        const container = document.getElementById('modal-container');
        const titleEl = document.getElementById('modal-title');
        const messageEl = document.getElementById('modal-message');
        const inputEl = document.getElementById('modal-input');
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');
        if (!container || !titleEl || !messageEl || !inputEl || !confirmBtn || !cancelBtn) return;

        titleEl.textContent = 'Import from Spotify & Apps';
        messageEl.innerHTML = `
            <div class="import-apps-panel">
                <p>Use TuneMyMusic first for the most reliable transfer, then paste or upload your exported list below.</p>
                <div class="import-manual-wrap" id="import-manual-wrap">
                    <p class="import-divider"><span>recommended</span></p>
                    <button type="button" class="import-tmm-btn" id="open-tmm-btn"><i class="fas fa-external-link-alt"></i> Open TuneMyMusic</button>
                    <textarea id="import-tracks-text" class="import-tracks-text" placeholder="Paste exported track list here (CSV or lines like: Song, Artist)."></textarea>
                    <label class="import-file-label">
                        <input type="file" id="import-tracks-file" accept=".txt,.csv,text/plain,text/csv">
                        <i class="fas fa-file-upload"></i> Load TXT/CSV file
                    </label>
                </div>
                <p class="import-divider"><span>optional</span></p>
                <button type="button" class="import-spotify-btn" id="import-spotify-btn"><i class="fab fa-spotify"></i> Try Spotify Connect (Beta)</button>
                <p>Use Spotify Connect only if you want direct sync and it is working on your account.</p>
                </div>
            </div>
        `;
        inputEl.style.display = 'block';
        inputEl.value = `Imported from Apps ${new Date().toLocaleDateString()}`;
        inputEl.placeholder = 'Playlist name';
        confirmBtn.style.display = 'inline-flex';
        confirmBtn.textContent = 'Import';
        cancelBtn.textContent = 'Cancel';
        container.style.display = 'flex';

        const manualWrap = document.getElementById('import-manual-wrap');
        const openTuneMyMusic = () => window.open('https://www.tunemymusic.com/', '_blank', 'noopener,noreferrer');
        const revealManualFallback = (reason, openTmm = false) => {
            if (manualWrap?.hasAttribute('hidden')) manualWrap.removeAttribute('hidden');
            if (reason) showToast(reason, 'fa-info-circle');
            if (openTmm) {
                const popup = openTuneMyMusic();
                if (!popup) showToast('Popup blocked. Tap Open TuneMyMusic button below.', 'fa-external-link-alt');
            }
        };

        const openTmm = document.getElementById('open-tmm-btn');
        openTmm?.addEventListener('click', (e) => {
            e.preventDefault();
            openTuneMyMusic();
        });
        const spotifyBtn = document.getElementById('import-spotify-btn');
        spotifyBtn?.addEventListener('click', async (e) => {
            e.preventDefault();
            const previousLabel = spotifyBtn.innerHTML;
            spotifyBtn.disabled = true;
            spotifyBtn.innerHTML = '<i class="fab fa-spotify"></i> Trying Spotify...';
            const resetButton = () => {
                spotifyBtn.disabled = false;
                spotifyBtn.innerHTML = previousLabel;
            };
            if (!isSpotifyConfigured()) {
                resetButton();
                revealManualFallback('Spotify is not configured. Using TuneMyMusic fallback.', true);
                return;
            }
            try {
                const token = await getValidSpotifyAccessToken();
                if (token) {
                    const result = await importSpotifyLibraryToPalmPlay();
                    if (result?.oauthRedirected) return;
                    if (result?.blocked403 && (result?.added || 0) === 0) {
                        resetButton();
                        revealManualFallback('Spotify access blocked. Continue with TuneMyMusic fallback.', true);
                        return;
                    }
                    container.style.display = 'none';
                } else {
                    await startSpotifyConnect(true, true);
                    return;
                }
            } catch (err) {
                console.warn('Spotify import start failed', err);
                resetButton();
                revealManualFallback('Could not start Spotify transfer. Continue with TuneMyMusic fallback.', true);
                return;
            }
            resetButton();
        });
        const tracksTextEl = document.getElementById('import-tracks-text');
        const fileEl = document.getElementById('import-tracks-file');
        fileEl?.addEventListener('change', async (e) => {
            const file = e.target?.files?.[0];
            if (!file) return;
            const text = await file.text();
            if (tracksTextEl) tracksTextEl.value = text;
        });

        confirmBtn.onclick = async () => {
            const raw = tracksTextEl?.value || '';
            const plName = inputEl.value || '';
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Importing...';
            await importFromApps(raw, plName);
            container.style.display = 'none';
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm';
            inputEl.style.display = 'none';
            messageEl.textContent = '';
        };
        cancelBtn.onclick = () => {
            container.style.display = 'none';
            inputEl.style.display = 'none';
            confirmBtn.textContent = 'Confirm';
            cancelBtn.textContent = 'Cancel';
            messageEl.textContent = '';
        };
    }

    function showAddToPlaylistPicker(rawTrack) {
        const track = normalizeStreamTrack(rawTrack);
        if (!isUserLoggedIn()) {
            showToast('Log in to save playlists', 'fa-user-lock');
            ppRoutes().go('login');
            return;
        }

        const container = document.getElementById('modal-container');
        const titleEl = document.getElementById('modal-title');
        const messageEl = document.getElementById('modal-message');
        const inputEl = document.getElementById('modal-input');
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');

        if (!container || !messageEl) return;

        modalConfirmPrevDisplay = confirmBtn?.style.display || '';
        if (confirmBtn) confirmBtn.style.display = 'none';
        if (inputEl) inputEl.style.display = 'none';

        titleEl.textContent = 'Add to playlist';
        messageEl.innerHTML = '';

        const sub = document.createElement('p');
        sub.className = 'playlist-picker-track';
        sub.textContent = `${track.name} — ${track.artist}`;
        messageEl.appendChild(sub);

        const list = document.createElement('div');
        list.className = 'playlist-picker-list';

        const userPls = playlists.filter(isUserPlaylist);
        if (!userPls.length) {
            const empty = document.createElement('p');
            empty.className = 'playlist-picker-empty';
            empty.textContent = 'No playlists yet. Create one below.';
            messageEl.appendChild(empty);
        }

        userPls.forEach((pl) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'playlist-picker-item';
            btn.innerHTML = `<i class="fas fa-music"></i><span>${escapeHtml(pl.name)}</span><small>${pl.tracks.length} tracks</small>`;
            btn.onclick = async () => {
                const idx = playlists.findIndex(p => p.id === pl.id);
                await addTrackToUserPlaylist(idx, track);
                closePlaylistPickerModal();
            };
            list.appendChild(btn);
        });

        const newBtn = document.createElement('button');
        newBtn.type = 'button';
        newBtn.className = 'playlist-picker-item playlist-picker-new';
        newBtn.innerHTML = '<i class="fas fa-plus"></i><span>New playlist</span>';
        newBtn.onclick = () => {
            closePlaylistPickerModal();
            showModal('New playlist', 'Choose a name:', async (name) => {
                const idx = await createUserPlaylist(name);
                if (idx >= 0) await addTrackToUserPlaylist(idx, track);
            }, true, '');
        };
        list.appendChild(newBtn);
        messageEl.appendChild(list);

        cancelBtn.onclick = () => closePlaylistPickerModal();
        container.style.display = 'flex';
    }

    window.showAddToPlaylistPicker = showAddToPlaylistPicker;

    window.getCurrentPalmPlayTrack = () => {
        if (state.currentPlaylistIndex < 0) return null;
        const track = playlists[state.currentPlaylistIndex]?.tracks?.[state.currentTrackIndex];
        if (!track) return null;
        return {
            track,
            plIndex: state.currentPlaylistIndex,
            tIndex: state.currentTrackIndex,
            isPlaying: state.isPlaying,
            isShuffle: state.isShuffle,
            repeatMode: state.repeatMode,
            currentTime: audio.currentTime,
            duration: audio.duration
        };
    };

    async function fetchTrackLyrics(trackName, artistName, durationSec) {
        const name = (trackName || '').trim();
        const artist = (artistName || '').trim();
        if (!name || !artist) return null;

        try {
            const params = new URLSearchParams({
                track_name: name,
                artist_name: artist
            });
            if (durationSec && isFinite(durationSec)) {
                params.set('duration', String(Math.round(durationSec)));
            }
            const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
                signal: AbortSignal.timeout(7000)
            });
            if (!res.ok) return null;
            const data = await res.json();
            const text = data.syncedLyrics || data.plainLyrics || data.instrumentalLyrics;
            return typeof text === 'string' && text.trim() ? text.trim() : null;
        } catch (e) {
            console.warn('Lyrics fetch failed', e);
            return null;
        }
    }

    window.fetchTrackLyrics = fetchTrackLyrics;

    function attachCardActions(card, track, plIndex, tIdx, options = {}) {
        card.classList.add('card--has-menu');
        const menu = document.createElement('button');
        menu.type = 'button';
        menu.className = 'card-more-btn';
        menu.setAttribute('aria-label', 'Song options');
        menu.innerHTML = '<i class="fas fa-ellipsis-h"></i>';
        menu.onclick = (e) => {
            e.stopPropagation();
            showAddToPlaylistPicker(track);
        };
        card.appendChild(menu);

        if (options.showFeedback) {
            const actions = document.createElement('div');
            actions.className = 'card-feedback-actions';
            actions.innerHTML = `
                <button type="button" class="card-feedback-btn" data-fb="boost" aria-label="Recommend more like this"><i class="fas fa-thumbs-up"></i> More like this</button>
                <button type="button" class="card-feedback-btn" data-fb="hide" aria-label="Not interested"><i class="fas fa-ban"></i> Not interested</button>
            `;
            actions.querySelectorAll('.card-feedback-btn').forEach((btn) => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const mode = btn.getAttribute('data-fb');
                    if (mode) applyTrackFeedback(track, mode);
                };
            });
            card.appendChild(actions);
        }
    }

    function createTrackCard(track, plIndex, tIdx, options = {}) {
        const card = document.createElement('div');
        card.className = 'card audius-card';
        const art = track.art || DEFAULT_ART_URL;
        card.innerHTML = `
            <div class="card-image" style="background-image: url('${escapeHtml(art)}')">
                <div class="play-btn-overlay"><i class="fas fa-play"></i></div>
            </div>
            <div class="card-title">${escapeHtml(track.name)}</div>
            <div class="card-desc">${buildTrackMetaLine(track)}</div>
        `;
        card.onclick = (e) => {
            if (e.target.closest('.meta-link, .card-more-btn, .card-feedback-btn')) return;
            playTrack(plIndex, tIdx);
        };
        attachCardActions(card, track, plIndex, tIdx, options);
        return card;
    }

    function appendHomeSection(parent, title, subtitle) {
        const section = document.createElement('section');
        section.className = 'home-section';
        section.innerHTML = `
            <div class="home-section-head">
                <div>
                    <h3 class="home-section-title">${escapeHtml(title)}</h3>
                    ${subtitle ? `<p class="home-section-sub">${escapeHtml(subtitle)}</p>` : ''}
                </div>
            </div>
            <div class="home-section-grid card-grid"></div>
        `;
        parent.appendChild(section);
        return section.querySelector('.home-section-grid');
    }

    function renderTrackRow(parent, title, subtitle, tracks, playlistId, options = {}) {
        if (!tracks?.length) return;
        const organizedTracks = organizeTracksForSelection(tracks, tracks.length);
        const grid = appendHomeSection(parent, title, subtitle);
        const plIndex = upsertTempPlaylist(playlistId, title, organizedTracks);
        organizedTracks.forEach((track, tIdx) => grid.appendChild(createTrackCard(track, plIndex, tIdx, options.cardOptions)));
    }

    function normalizeTitleKey(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function primaryArtistKey(artist) {
        return String(artist || '')
            .split(',')[0]
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || 'unknown';
    }

    function organizeTracksForSelection(tracks, limit = 20) {
        const uniq = [];
        const seen = new Set();
        tracks.forEach((track) => {
            const key = `${normalizeTitleKey(track.name)}::${primaryArtistKey(track.artist)}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniq.push(track);
            }
        });

        const buckets = new Map();
        uniq.forEach((track) => {
            const key = primaryArtistKey(track.artist);
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(track);
        });

        const keys = Array.from(buckets.keys()).sort((a, b) => buckets.get(b).length - buckets.get(a).length);
        const organized = [];
        let guard = 0;
        while (organized.length < uniq.length && guard < 2000) {
            guard += 1;
            let progressed = false;
            for (const key of keys) {
                const bucket = buckets.get(key);
                if (!bucket?.length) continue;
                const next = bucket.shift();
                const last = organized[organized.length - 1];
                if (last && primaryArtistKey(last.artist) === key && bucket.length) {
                    bucket.push(next);
                    continue;
                }
                organized.push(next);
                progressed = true;
                if (organized.length >= uniq.length) break;
            }
            if (!progressed) {
                keys.forEach((k) => {
                    const bucket = buckets.get(k) || [];
                    while (bucket.length) organized.push(bucket.shift());
                });
            }
        }
        return organized.slice(0, limit);
    }

    function renderHomeLoginBanner(parent) {
        const banner = document.createElement('div');
        banner.className = 'home-login-banner';
        banner.innerHTML = `
            <div class="home-login-banner-text">
                <strong>Save playlists & likes</strong>
                <span>Sign in to sync playlists and likes across devices.</span>
            </div>
            <div class="home-login-banner-actions">
                <button type="button" class="upgrade-btn home-login-btn" data-pp-login>Log in</button>
                <button type="button" class="upgrade-btn home-signup-btn" data-pp-signup>Sign up</button>
            </div>
        `;
        banner.querySelector('[data-pp-login]').onclick = () => ppRoutes().go('login');
        banner.querySelector('[data-pp-signup]').onclick = () => ppRoutes().go('signup');
        parent.appendChild(banner);
    }

    function renderHomeQuickActions(parent) {
        const row = document.createElement('div');
        row.className = 'home-quick-actions';
        const actions = [
            { label: 'Discover', icon: 'fa-search', route: 'discover' },
            { label: 'Explore', icon: 'fa-compass', route: 'explore' },
            { label: 'Languages', icon: 'fa-globe', route: 'discover' }
        ];
        actions.forEach((a) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'home-quick-chip';
            btn.innerHTML = `<i class="fas ${a.icon}"></i> ${escapeHtml(a.label)}`;
            btn.onclick = () => {
                if (a.route === 'explore') ppRoutes().go('explore');
                else ppRoutes().go('discover');
            };
            row.appendChild(btn);
        });
        const wrap = document.createElement('section');
        wrap.className = 'home-section home-section--compact';
        wrap.innerHTML = '<h3 class="home-section-title">Jump in</h3>';
        wrap.appendChild(row);
        parent.appendChild(wrap);
    }

    function renderHomeLibrarySection(parent, savedUser) {
        const userPlaylists = playlists.filter(pl => isUserPlaylist(pl) && pl.tracks?.length);
        if (userPlaylists.length === 0) {
            const empty = document.createElement('section');
            empty.className = 'home-section home-library-hint';
            empty.innerHTML = `
                <h3 class="home-section-title">Your collection</h3>
                <p>Add music from your device with the <strong><i class="fas fa-plus"></i></strong> button in the sidebar, or save tracks from Discover.</p>
            `;
            parent.appendChild(empty);
            return;
        }

        const grid = appendHomeSection(parent, 'Your playlists', `${userPlaylists.length} on this device`);
        grid.style.display = 'grid';
        playlists.forEach((pl, index) => {
            if (!isUserPlaylist(pl) || !pl.tracks?.length) return;
            const card = document.createElement('div');
            card.className = 'card';
            const art = pl.tracks[0]?.art || DEFAULT_ART_URL;
            card.innerHTML = `
                <div class="card-image" style="background-image: url('${escapeHtml(art)}')">
                    <div class="play-btn-overlay"><i class="fas fa-play"></i></div>
                </div>
                <div class="card-title">${escapeHtml(pl.name)}</div>
                <div class="card-desc">${pl.tracks.length} songs</div>
            `;
            card.onclick = () => showPlaylist(index);
            grid.appendChild(card);
        });
    }

    function renderLikedPreview(parent) {
        const preview = likedSongs.slice(0, 8).map(ls => ({
            id: ls.id,
            name: ls.trackName,
            artist: ls.artist,
            album: ls.album,
            duration: ls.duration,
            url: ls.url,
            art: ls.art || DEFAULT_ART_URL,
            isAudius: ls.isAudius
        })).filter(t => t.url);

        if (!preview.length) return;

        const section = document.createElement('section');
        section.className = 'home-section';
        const head = document.createElement('div');
        head.className = 'home-section-head';
        head.innerHTML = `
            <div>
                <h3 class="home-section-title">Liked songs</h3>
                <p class="home-section-sub">Your favorites</p>
            </div>
        `;
        const seeAll = document.createElement('button');
        seeAll.type = 'button';
        seeAll.className = 'home-section-link';
        seeAll.textContent = 'See all';
        seeAll.onclick = () => {
            const item = document.querySelector('.liked-songs-item');
            if (item) item.click();
            else showLikedSongs();
        };
        head.appendChild(seeAll);
        section.appendChild(head);

        const grid = document.createElement('div');
        grid.className = 'home-section-grid card-grid';
        const plIndex = upsertTempPlaylist('home_liked_preview', 'Liked songs', preview);
        preview.forEach((track, tIdx) => grid.appendChild(createTrackCard(track, plIndex, tIdx)));
        section.appendChild(grid);
        parent.appendChild(section);
    }

    async function renderHome() {
        document.body.classList.remove('lang-view-active');
        state.currentView = 'home';
        setHeaderSearchVisible(false);
        viewHeader.style.display = 'block';
        greetingEl.style.display = 'block';
        if (exploreHero) exploreHero.style.display = 'none';
        if (categoryChips) categoryChips.style.display = 'none';

        const isExplore = ppRoutes().isExplorePage();

        if (isExplore) {
            window.renderExplore = renderExplore;
            const activeChip = document.querySelector('.chip.active');
            const genre = activeChip ? activeChip.getAttribute('data-genre') : 'Trending';
            renderExplore(genre);
            return;
        }

        header.style.backgroundColor = 'transparent';
        const savedUser = getSavedUser();
        const isLoggedIn = isUserLoggedIn();

        greetingEl.className = 'greeting';
        greetingEl.textContent = isLoggedIn
            ? `${getRandomWish()}, ${savedUser.name || 'Listener'}`
            : 'Welcome to PalmPlay';
        if (sectionTitleEl) sectionTitleEl.textContent = 'Listen now';

        cardGrid.className = 'card-grid home-feed';
        cardGrid.style.display = 'block';
        cardGrid.innerHTML = `<div class="home-loading">${skeletonCardGrid(6)}</div>`;

        const feed = await fetchHomeFeed();
        if (state.currentView !== 'home') return;

        const history = getPlayHistory().slice(0, 12);
        let forYouTracks = [];
        try {
            forYouTracks = await fetchForYouTracks(feed, history);
        } catch (e) {
            console.warn('For You generation failed', e);
        }
        cardGrid.innerHTML = '';

        if (!isLoggedIn) renderHomeLoginBanner(cardGrid);

        if (forYouTracks.length) {
            renderTrackRow(
                cardGrid,
                'For you',
                'Based on your listens, likes, and feedback',
                forYouTracks,
                'home_for_you',
                { cardOptions: { showFeedback: true } }
            );
        }

        if (history.length) {
            renderTrackRow(cardGrid, 'Continue listening', 'Pick up where you left off', history, 'home_continue');
        }

        renderTrackRow(cardGrid, 'Trending now', 'Popular on PalmPlay', feed.trending, 'home_trending');
        renderTrackRow(cardGrid, 'Fresh picks', 'Curated for you', feed.picks, 'home_picks');

        renderHomeQuickActions(cardGrid);

        if (isLoggedIn) {
            renderLikedPreview(cardGrid);
            renderHomeLibrarySection(cardGrid, savedUser);
        }
    }

    async function renderExplore(category) {
        document.body.classList.remove('lang-view-active');
        state.currentView = 'explore';
        setHeaderSearchVisible(false);
        viewHeader.style.display = 'block';
        greetingEl.style.display = 'block';
        if (exploreHero) exploreHero.style.display = 'flex';
        if (categoryChips) categoryChips.style.display = 'flex';
        
        const savedUser = getSavedUser();
        greetingEl.textContent = `Explore the Treat to Your Ears, ${savedUser.name || 'Guest'}`;
        sectionTitleEl.textContent = `${category} Tracks`;
        header.style.backgroundColor = 'transparent';
        
        cardGrid.innerHTML = `<div style="grid-column:1/-1">${skeletonCardGrid(8)}</div>`;
        cardGrid.style.display = 'grid';
        
        try {
            let url = '';
            if (category === 'Trending') {
                url = `${AUDIUS_HOST}/v1/tracks/trending?app_name=${AUDIUS_APP_NAME}&limit=20`;
            } else {
                url = `${AUDIUS_HOST}/v1/tracks/search?query=${encodeURIComponent(category)}&app_name=${AUDIUS_APP_NAME}`;
            }
            
            const res = await fetch(url);
            const data = await res.json();
            const audiusTracks = data.data || [];
            
            cardGrid.innerHTML = '';
            
            if (audiusTracks.length === 0) {
                cardGrid.innerHTML = '<div style="grid-column: 1/-1; color:var(--text-subdued); padding:20px;">No tracks found for this category.</div>';
                return;
            }
            
            // Create or update temporary Audius playlist for playback
            let audiusPlIndex = playlists.findIndex(pl => pl.id === 'audius_explore');
            if (audiusPlIndex === -1) {
                audiusPlIndex = playlists.length;
                playlists.push({
                    id: 'audius_explore',
                    name: 'Explore Mix',
                    tracks: [],
                    isTemporary: true
                });
            }
            
            const mappedTracks = audiusTracks.map(t => ({
                id: t.id,
                name: t.title,
                artist: t.user?.name || 'Unknown',
                album: 'Explore',
                duration: t.duration,
                url: `${AUDIUS_HOST}/v1/tracks/${t.id}/stream?app_name=${AUDIUS_APP_NAME}`,
                art: t.artwork?.['480x480'] || t.artwork?.['150x150'] || DEFAULT_ART_URL,
                isAudius: true
            }));
            
            playlists[audiusPlIndex].tracks = mappedTracks;
            
            mappedTracks.forEach((track, tIdx) => {
                cardGrid.appendChild(createTrackCard(track, audiusPlIndex, tIdx));
            });
            
        } catch (err) {
            console.error("Explore API Error:", err);
            showErrorState(cardGrid, {
                icon: 'fa-cloud-download-alt',
                title: 'Could not load tracks',
                message: navigator.onLine ? 'The service may be busy. Try again or pick another category.' : 'You appear to be offline.',
                onRetry: () => document.querySelector('.chip.active')?.click()
            });
        }
    }

    function showPlaylist(plIndex) {
        document.body.classList.remove('lang-view-active');
        state.currentView = 'playlist';
        const pl = playlists[plIndex];

        viewHeader.style.display = 'none';
        greetingEl.style.display = 'none';
        if (exploreHero) exploreHero.style.display = 'none';
        if (categoryChips) categoryChips.style.display = 'none';
        header.style.backgroundColor = 'transparent'; // Let the gradient show

        // Calculate total duration from real track durations
        let totalSeconds = pl.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
        const hrs = Math.floor(totalSeconds / 3600);
        const mins = Math.floor((totalSeconds % 3600) / 60);
        let durationText = `${pl.tracks.length} songs`;
        if (hrs > 0) durationText += `, ${hrs} hr ${mins} min`;
        else if (mins > 0) durationText += `, ${mins} min`;

        cardGrid.innerHTML = `
            <div class="playlist-header-container">
                <div class="playlist-art-large" style="background-image: url(${pl.tracks[0]?.art})"></div>
                <div class="playlist-info-header">
                    <span class="pl-type">Private Playlist</span>
                    <h1 class="pl-title-large">${pl.name}</h1>
                    <div class="pl-meta">
                        <img src="https://ui-avatars.com/api/?name=User&background=FF0000&color=fff" style="width:24px; border-radius:50%">
                        <strong>User</strong> <span>• ${durationText}</span>
                    </div>
                </div>
            </div>
            
            <div class="pl-controls-bar">
                <button class="play-circle-btn" id="pl-main-play"><i class="fas ${state.currentPlaylistIndex === plIndex && state.isPlaying ? 'fa-pause' : 'fa-play'}"></i></button>
                <i class="fas fa-random pl-icon-btn" id="pl-shuffle" title="Shuffle" style="${state.isShuffle ? 'color:var(--primary)' : ''}"></i>
                <i class="fas fa-arrow-circle-down pl-icon-btn" id="pl-download-all" title="Download All"></i>
                <i class="fas fa-user-plus pl-icon-btn" title="Collaborate"></i>
                
                <div class="pl-options-container">
                    <i class="fas fa-ellipsis-h pl-icon-btn" id="pl-more-options" title="More Options"></i>
                    <div class="pl-options-dropdown" id="pl-options-menu">
                        <button class="dropdown-item" onclick="renamePlaylist(${plIndex})">
                            <i class="fas fa-edit"></i> Rename Folder
                        </button>
                        <button class="dropdown-item delete" onclick="deletePlaylist(${plIndex})">
                            <i class="fas fa-trash-alt"></i> Delete Folder
                        </button>
                    </div>
                </div>
            </div>

            <table class="track-table">
                <thead>
                    <tr>
                        <th class="track-index-cell">#</th>
                        <th>Title</th>
                        <th>Album</th>
                        <th>Date Added</th>
                        <th style="text-align:right"><i class="far fa-clock"></i></th>
                    </tr>
                </thead>
                <tbody id="track-list-body"></tbody>
            </table>
        `;

        cardGrid.style.display = 'block';

        // Playlist interaction listeners
        document.getElementById('pl-main-play').onclick = () => {
            if (state.currentPlaylistIndex === plIndex && audio.src) {
                togglePlay();
            } else {
                startCollectionPlayback(plIndex);
            }
        };

        document.getElementById('pl-shuffle').onclick = () => startCollectionPlayback(plIndex, { shuffle: true });

        document.getElementById('pl-download-all').onclick = () => {
            alert('Downloading all tracks in this collection...');
            pl.tracks.forEach(track => downloadTrack(track));
        };

        const moreBtn = document.getElementById('pl-more-options');
        const optionsMenu = document.getElementById('pl-options-menu');
        if (moreBtn && optionsMenu) {
            moreBtn.onclick = (e) => {
                e.stopPropagation();
                optionsMenu.classList.toggle('active');
            };
            // Close when clicking elsewhere
            window.addEventListener('click', () => optionsMenu.classList.remove('active'), { once: true });
        }

        const tbody = document.getElementById('track-list-body');
        pl.tracks.forEach((track, tIndex) => {
            const tr = document.createElement('tr');
            tr.className = `track-row ${state.currentPlaylistIndex === plIndex && state.currentTrackIndex === tIndex ? 'active' : ''}`;
            const albumName = track.album || pl.name;
            const dateAdded = track.dateAdded ? formatDateAdded(track.dateAdded) : 'Unknown';
            const duration = track.duration ? formatDuration(track.duration) : '--:--';
            tr.innerHTML = `
                <td class="track-index-cell">${(tIndex + 1).toString().padStart(2, '0')}</td>
                <td style="display:flex; align-items:center;">
                    <img src="${track.art}" class="row-art">
                    <div>
                        <div class="track-name-bold">${track.name}</div>
                        <div class="track-artist-small">${track.artist}</div>
                    </div>
                </td>
                <td style="color:var(--text-subdued); font-size:14px;">${albumName}</td>
                <td style="color:var(--text-subdued); font-size:14px;">${dateAdded}</td>
                <td style="text-align:right; color:var(--text-subdued); font-size:14px;">${duration}</td>
            `;
            tr.onclick = () => playTrack(plIndex, tIndex);
            tbody.appendChild(tr);
        });

        mainView.scrollTop = 0;
    }

    async function playTrack(plIndex, tIndex, opts = {}) {
        const autoNext = !!opts.autoNext;
        const fromQueue = !!opts.fromQueue;
        const pl = playlists[plIndex];
        let track = pl?.tracks?.[tIndex];
        if (!track) {
            state.isBuffering = false;
            state.isPlaying = false;
            updatePlayerUI();
            return;
        }
        const token = ++playRequestToken;
        state.currentPlaylistIndex = plIndex;
        state.currentTrackIndex = tIndex;
        ensureQueueForCurrentTrack(plIndex, tIndex, {
            forceReset: !autoNext && !fromQueue,
            keepExisting: autoNext || fromQueue
        });
        state.isBuffering = true;
        updatePlayerUI();

        let url = track.url;
        if (!url || track._unplayable) {
            url = await resolveTrackStreamSafe(track, true);
        }
        if (!url) {
            onPlaybackFailed(track, plIndex, tIndex, autoNext);
            return;
        }

        playlists[plIndex].tracks[tIndex].url = url;
        track = playlists[plIndex].tracks[tIndex];
        delete track._unplayable;
        state.recentPlayback.push({
            plIndex,
            tIndex,
            artistKey: primaryArtistKey(track.artist)
        });
        if (state.recentPlayback.length > 12) {
            state.recentPlayback = state.recentPlayback.slice(-12);
        }

        try {
            if (audioCtx.state === 'suspended') await audioCtx.resume();
        } catch (e) {
            console.warn('AudioContext resume failed', e);
        }

        // Immediate, reliable switch.
        audio.pause();
        audio.currentTime = 0;
        audio.src = url;
        audio.preload = 'auto';
        audio.playbackRate = state.playbackSpeed;
        if (!state.isMuted) {
            currentSource.gain.gain.setValueAtTime(state.volume, audioCtx.currentTime);
        }

        const started = await playAudioWithTimeout(audio, 7000);
        if (token !== playRequestToken) return;
        if (!started && audio.paused) {
            showToast('Playback blocked. Tap play again.', 'fa-play');
            state.isBuffering = false;
            state.isPlaying = false;
            updatePlayerUI();
            return;
        }

        let ok = await waitForPlaybackReady(6000);
        if (token !== playRequestToken) return;
        if (!ok) {
            playbackRecoveryLock = true;
            const retryUrl = await resolveTrackStreamSafe(track, true);
            playbackRecoveryLock = false;
            if (token !== playRequestToken) return;
            if (retryUrl && retryUrl !== url) {
                playlists[plIndex].tracks[tIndex].url = retryUrl;
                audio.pause();
                audio.currentTime = 0;
                audio.src = retryUrl;
                try {
                    const retryStarted = await playAudioWithTimeout(audio, 7000);
                    ok = retryStarted || await waitForPlaybackReady(5000);
                } catch (e2) {
                    console.warn('Retry play failed:', e2);
                    ok = false;
                }
            }
        }

        if (!ok) {
            onPlaybackFailed(track, plIndex, tIndex, autoNext);
            return;
        }

        autoSkipAttempts = 0;
        state.isBuffering = false;
        state.isPlaying = true;
        updatePlayerUI();
        updateMediaSession(track);
        document.body.classList.add('player-expanded');
        window.dispatchEvent(new CustomEvent('palmplay:trackchange', { detail: { plIndex, tIndex } }));
        recordPlayHistory(track);
        applyDynamicTheme(track.art);
        prefetchUpcomingTrack(plIndex, tIndex);

        if (state.currentView === 'playlist') {
            const plMainPlayIcon = document.querySelector('#pl-main-play i');
            if (plMainPlayIcon) plMainPlayIcon.className = 'fas fa-pause';
            document.querySelectorAll('.track-row').forEach((row, idx) => {
                row.classList.toggle('active', idx === tIndex);
            });
        } else if (state.currentView === 'likedSongs' && playlists[plIndex]?.id === LIKED_SONGS_PLAYLIST_ID) {
            const likedPlayIcon = document.querySelector('#liked-main-play i');
            if (likedPlayIcon) likedPlayIcon.className = 'fas fa-pause';
            document.querySelectorAll('#liked-track-list-body .track-row').forEach((row, idx) => {
                row.classList.toggle('active', idx === tIndex);
            });
        }
    }

    async function togglePlay() {
        if (!audio.src) return;
        if (state.isBuffering) return;
        if (state.isPlaying) {
            audio.pause();
            state.isPlaying = false;
        } else {
            const resumed = await playAudioWithTimeout(audio, 5000);
            if (resumed) {
                state.isPlaying = true;
            } else {
                showToast('Playback blocked. Tap play again.', 'fa-play');
                state.isPlaying = false;
            }
        }
        updatePlayerUI();
        if (state.currentPlaylistIndex >= 0) {
            const t = playlists[state.currentPlaylistIndex]?.tracks?.[state.currentTrackIndex];
            if (t) updateMediaSession(t);
        }

        // Update playlist view UI if active
        if (state.currentView === 'playlist') {
            const plMainPlayIcon = document.querySelector('#pl-main-play i');
            if (plMainPlayIcon) plMainPlayIcon.className = state.isPlaying ? 'fas fa-pause' : 'fas fa-play';
        }

        // Update liked songs view UI if active
        if (state.currentView === 'likedSongs') {
            const likedPlayIcon = document.querySelector('#liked-main-play i');
            if (likedPlayIcon) likedPlayIcon.className = state.isPlaying ? 'fas fa-pause' : 'fas fa-play';
        }
    }

    function playNext(allowWrap = true) {
        if (state.currentPlaylistIndex === -1) return;
        const pl = playlists[state.currentPlaylistIndex];
        ensureQueueForCurrentTrack(state.currentPlaylistIndex, state.currentTrackIndex, { keepExisting: true });

        if (state.queueIndices.length > 1) {
            const nextIndex = state.queueIndices[1];
            setQueueIndices(state.currentPlaylistIndex, nextIndex, state.queueIndices.slice(1), state.queueExplicit);
            playTrack(state.currentPlaylistIndex, nextIndex, { autoNext: true, fromQueue: true });
            return;
        }

        if (state.queueExplicit && state.queueIndices.length <= 1) {
            state.isPlaying = false;
            updatePlayerUI();
            return;
        }

        if (state.isShuffle) {
            const currentArtist = primaryArtistKey(pl.tracks[state.currentTrackIndex]?.artist);
            const recent = state.recentPlayback
                .filter((r) => r.plIndex === state.currentPlaylistIndex)
                .slice(-4)
                .map((r) => r.tIndex);
            let candidates = pl.tracks
                .map((t, idx) => ({ idx, artist: primaryArtistKey(t.artist) }))
                .filter((x) => x.idx !== state.currentTrackIndex)
                .filter((x) => !recent.includes(x.idx))
                .filter((x) => x.artist !== currentArtist);

            if (!candidates.length) {
                candidates = pl.tracks
                    .map((t, idx) => ({ idx, artist: primaryArtistKey(t.artist) }))
                    .filter((x) => x.idx !== state.currentTrackIndex);
            }
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            if (pick) state.currentTrackIndex = pick.idx;
        } else {
            if (state.currentTrackIndex >= pl.tracks.length - 1) {
                if (!allowWrap) {
                    state.isPlaying = false;
                    updatePlayerUI();
                    return;
                }
                state.currentTrackIndex = 0;
            } else {
                state.currentTrackIndex += 1;
            }
        }

        playTrack(state.currentPlaylistIndex, state.currentTrackIndex, { autoNext: true });
    }

    function playPrev() {
        if (state.currentPlaylistIndex === -1) return;
        const pl = playlists[state.currentPlaylistIndex];
        state.currentTrackIndex = (state.currentTrackIndex - 1 + pl.tracks.length) % pl.tracks.length;
        playTrack(state.currentPlaylistIndex, state.currentTrackIndex);
    }

    function seek(e) {
        if (!audio.src || !audio.duration) return;
        const rect = progressBar.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        audio.currentTime = pos * audio.duration;
    }

    function toggleShuffle() {
        state.isShuffle = !state.isShuffle;
        if (state.currentPlaylistIndex >= 0 && state.currentTrackIndex >= 0) {
            if (state.isShuffle) {
                setQueueIndices(
                    state.currentPlaylistIndex,
                    state.currentTrackIndex,
                    buildShuffledQueueIndices(state.currentPlaylistIndex, state.currentTrackIndex),
                    true
                );
            } else {
                setQueueIndices(state.currentPlaylistIndex, state.currentTrackIndex, null, false);
            }
        }
        updateShuffleControlIcons();
        showToast(state.isShuffle ? 'Shuffle On' : 'Shuffle Off', 'fa-random');
    }

    function downloadTrack(track) {
        const link = document.createElement('a');
        link.href = track.url;
        link.download = `${track.artist} - ${track.name}.mp3`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function setVolume(e) {
        const rect = volumeBar.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        state.volume = Math.max(0, Math.min(1, pos));
        audio.volume = state.volume;
        volumeFill.style.width = `${state.volume * 100}%`;
    }

    function updatePlayerUI() {
        // Update user profile from registration
        const savedUser = getSavedUser();
        const profileBtn = document.querySelector('.profile-btn');

        if (isUserLoggedIn()) {
            if (profileBtn) {
                // Ensure the button is wrapped in the relative container if not already
                if (!profileBtn.parentElement.classList.contains('profile-dropdown-container')) {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'profile-dropdown-container';
                    profileBtn.parentNode.insertBefore(wrapper, profileBtn);
                    wrapper.appendChild(profileBtn);

                    // Create Dropdown
                    const dropdown = document.createElement('div');
                    dropdown.className = 'profile-dropdown';
                    dropdown.id = 'profile-dropdown';
                    dropdown.innerHTML = `
                        <button class="dropdown-item" onclick="handleProfileAction('profile')">
                            <i class="fas fa-user-circle"></i> Profile
                        </button>
                        <button class="dropdown-item" onclick="handleProfileAction('switch')">
                            <i class="fas fa-random"></i> Switch User
                        </button>
                        <button class="dropdown-item" onclick="handleProfileAction('support')">
                            <i class="fas fa-headset"></i> Support
                        </button>
                        <button class="dropdown-item logout" onclick="handleProfileAction('logout')">
                            <i class="fas fa-sign-out-alt"></i> Log Out
                        </button>
                    `;
                    wrapper.appendChild(dropdown);
                }

                profileBtn.innerHTML = `<img src="https://ui-avatars.com/api/?name=${savedUser.name}&background=FF0000&color=fff" style="width:28px; border-radius:50%; margin-right:4px;"> ${savedUser.name}`;
                profileBtn.onclick = (e) => {
                    e.stopPropagation();
                    const dropdown = document.getElementById('profile-dropdown');
                    dropdown.classList.toggle('active');
                };
            }
        } else {
            if (profileBtn) {
                profileBtn.innerHTML = '<i class="fas fa-user-circle" style="font-size:24px;"></i> Sign In';
                profileBtn.onclick = () => ppRoutes().go('login');

                // Cleanup dropdown if it exists while logged out
                const wrapper = profileBtn.parentElement;
                if (wrapper && wrapper.classList.contains('profile-dropdown-container')) {
                    const dropdown = wrapper.querySelector('.profile-dropdown');
                    if (dropdown) dropdown.remove();
                }
            }
        }

        if (state.currentPlaylistIndex === -1) {
            document.body.classList.add('player-bar-hidden');
            trackNameEl.textContent = "Select a song";
            artistNameEl.textContent = "Discover music below";
            document.body.classList.remove('player-expanded');
            updateMediaSession(null);
            return;
        }

        document.body.classList.remove('player-bar-hidden');
        const track = playlists[state.currentPlaylistIndex].tracks[state.currentTrackIndex];
        if (!trackNameEl.getAttribute('aria-live')) {
            trackNameEl.setAttribute('aria-live', 'polite');
            trackNameEl.setAttribute('aria-atomic', 'true');
        }
        trackNameEl.textContent = track.name;
        artistNameEl.textContent = track.artist;
        albumArtEl.style.backgroundImage = `url(${track.art})`;

        // Sync heart icon with liked state
        const heartBtn = document.querySelector('.player-like-btn') || document.querySelector('.track-info .control-btn');
        if (heartBtn) {
            const liked = isTrackLiked(track);
            state.isLiked = liked;
            const icon = heartBtn.querySelector('i');
            icon.className = liked ? 'fas fa-heart' : 'far fa-heart';
            icon.style.color = liked ? 'var(--primary)' : '';
        }

        if (state.isBuffering) {
            playIcon.className = 'fas fa-spinner fa-spin';
        } else {
            playIcon.className = state.isPlaying ? 'fas fa-pause' : 'fas fa-play';
        }

        if (audio.duration) {
            timeTotal.textContent = formatTime(audio.duration);
        }

        updateMediaSession(track);
    }

    function decodeHtmlEntities(str) {
        if (typeof str !== 'string' || !str) return str;
        const txt = document.createElement('textarea');
        txt.innerHTML = str;
        return txt.value;
    }

    function pickMediaUrl(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return '';
        for (let i = arr.length - 1; i >= 0; i--) {
            const item = arr[i];
            if (!item) continue;
            const u = item.url || item.link;
            if (u) return u;
        }
        return '';
    }

    function mapAudiusTracksToPlaylist(items, limit) {
        return (items || []).slice(0, limit).map(t => ({
            id: t.id,
            name: t.title,
            artist: t.user?.name || 'Unknown',
            album: 'Stream',
            duration: parseInt(t.duration, 10) || 200,
            language: '',
            plays: t.play_count || 0,
            url: `${AUDIUS_HOST}/v1/tracks/${t.id}/stream?app_name=${AUDIUS_APP_NAME}`,
            art: t.artwork?.['480x480'] || t.artwork?.['150x150'] || DEFAULT_ART_URL,
            isAudius: true,
            isCatalogFallback: true
        }));
    }

    async function fetchAudiusCatalogFallback(query, limit = 30) {
        try {
            const q = (query || '').trim();
            const useTrending = /^latest\s+hits$/i.test(q) || /^trending$/i.test(q) || q.length < 2;
            const url = useTrending
                ? `${AUDIUS_HOST}/v1/tracks/trending?app_name=${AUDIUS_APP_NAME}&limit=${limit}`
                : `${AUDIUS_HOST}/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=${AUDIUS_APP_NAME}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
            const data = await res.json();
            return mapAudiusTracksToPlaylist(data.data, limit);
        } catch (e) {
            console.error('Audius fallback failed:', e);
            return [];
        }
    }

    async function fetchCatalogTracks(query, limit = 30) {
        if (catalogTraffic.shouldUseAudius()) {
            return fetchAudiusCatalogFallback(query, limit);
        }
        if (!MUSIC_CATALOG_API_BASE) {
            return fetchAudiusCatalogFallback(query, limit);
        }

        catalogTraffic.recordStart();
        try {
            const url = `${MUSIC_CATALOG_API_BASE}/search/songs?query=${encodeURIComponent(query)}&limit=${limit}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            const data = await res.json();
            const results = data?.data?.results;
            if (!Array.isArray(results) || results.length === 0) {
                return fetchAudiusCatalogFallback(query, limit);
            }

            const mapped = results.map(t => {
                const parsed = parseCatalogSong(t);
                if (!parsed) return null;
                return {
                    ...parsed,
                    language: t.language || '',
                    plays: Math.floor(Math.random() * 50000) + 10000
                };
            }).filter(Boolean);
            const q = normalizeSearchText(query);
            const tokens = new Set(q.split(' ').filter(Boolean));
            const score = (track) => {
                const tn = normalizeSearchText(track.name);
                const ta = normalizeSearchText(track.artist);
                let s = 0;
                if (tn === q) s += 120;
                else if (tn.startsWith(q)) s += 90;
                else if (tn.includes(q)) s += 70;
                if (q.includes(ta) || ta.includes(q)) s += 25;
                tokens.forEach((tk) => {
                    if (tn.includes(tk)) s += 7;
                    if (ta.includes(tk)) s += 4;
                });
                s += Math.min(30, (track.plays || 0) / 4000);
                return s;
            };
            mapped.sort((a, b) => score(b) - score(a));
            return mapped;
        } catch (e) {
            console.error('Catalog fetch failed:', e);
            catalogTraffic._enterFallback(Date.now());
            return fetchAudiusCatalogFallback(query, limit);
        } finally {
            catalogTraffic.recordEnd();
        }
    }

    let audiusSearchTimeout = null;

    function renderSearch() {
        document.body.classList.remove('lang-view-active');
        setHeaderSearchVisible(true);
        greetingEl.style.display = 'none';
        if (exploreHero) exploreHero.style.display = 'none';
        if (categoryChips) categoryChips.style.display = 'none';
        sectionTitleEl.textContent = 'Browse All Tracks';
        cardGrid.innerHTML = '';
        cardGrid.style.display = 'block';

        // Flatten all tracks for search, maintaining original playlist indexes
        const allTracks = [];
        playlists.forEach((pl, plIdx) => {
            if (!pl.isTemporary) {
                pl.tracks.forEach((t, tIdx) => {
                    allTracks.push({ ...t, plIdx, tIdx });
                });
            }
        });

        // ─── Interactive Discovery Hub ─────────────────────────────────────────
        const hub = document.createElement('div');
        hub.className = 'search-discovery-hub';

        // Quick search suggestion chips
        const quickSearches = ['Lofi Beats', 'Hip Hop', 'Chill Vibes', 'Electronic', 'R&B Soul', 'Indie', 'Jazz', 'Ambient', 'Rock', 'Acoustic'];
        const chipsHtml = quickSearches.map(q =>
            `<button class="quick-chip" onclick="document.querySelector('.premium-search-input').value='${q}'; document.querySelector('.premium-search-input').dispatchEvent(new Event('input'));">
                <i class="fas fa-search" style="margin-right:6px; font-size:10px; opacity:0.6"></i>${q}
            </button>`
        ).join('');

        // Language browse cards with unique gradients and native script
        const languages = [
            { name: 'Hindi',      script: 'हि', grad: 'linear-gradient(135deg, #F97316, #DC2626)',  moods: ['Romantic', 'Party', 'Chill', 'Devotional', 'Workout', 'Sad'] },
            { name: 'Tamil',      script: 'த',  grad: 'linear-gradient(135deg, #8B5CF6, #6366F1)',  moods: ['Romantic', 'Kuthu', 'Melody', 'Devotional', 'Mass', 'Chill'] },
            { name: 'Telugu',     script: 'తె', grad: 'linear-gradient(135deg, #EC4899, #BE185D)',  moods: ['Romantic', 'Party', 'Melody', 'Devotional', 'Mass', 'Chill'] },
            { name: 'Kannada',    script: 'ಕ',  grad: 'linear-gradient(135deg, #10B981, #059669)',  moods: ['Romantic', 'Party', 'Melody', 'Devotional', 'Chill', 'Folk'] },
            { name: 'Malayalam',  script: 'മ',  grad: 'linear-gradient(135deg, #06B6D4, #0284C7)',  moods: ['Romantic', 'Chill', 'Melody', 'Devotional', 'Folk', 'Party'] },
            { name: 'Punjabi',    script: 'ਪੰ', grad: 'linear-gradient(135deg, #EAB308, #CA8A04)',  moods: ['Bhangra', 'Party', 'Romantic', 'Chill', 'Workout', 'Sad'] },
            { name: 'English',    script: 'En', grad: 'linear-gradient(135deg, #3B82F6, #1D4ED8)',  moods: ['Pop', 'Hip-Hop', 'Rock', 'Chill', 'R&B', 'EDM'] },
            { name: 'Korean',     script: '한', grad: 'linear-gradient(135deg, #E879F9, #A855F7)',  moods: ['K-Pop', 'Ballad', 'Hip-Hop', 'R&B', 'Chill', 'Dance'] },
            { name: 'Spanish',    script: 'Es', grad: 'linear-gradient(135deg, #EF4444, #B91C1C)',  moods: ['Reggaeton', 'Latin Pop', 'Bachata', 'Chill', 'Party', 'Romantic'] },
            { name: 'Arabic',     script: 'عر', grad: 'linear-gradient(135deg, #D97706, #92400E)',  moods: ['Pop', 'Classic', 'Chill', 'Romantic', 'Party', 'Folk'] },
        ];
        window._palmplayLanguages = languages; // expose for renderLanguagePage

        const langCards = languages.map((l, idx) =>
            `<div class="genre-browse-card" style="background: ${l.grad}" onclick="window._openLanguagePage(${idx})">
                <span class="lang-script-char">${l.script}</span>
                <span class="genre-card-label">${l.name}</span>
            </div>`
        ).join('');

        // Genre browse cards (secondary row)
        const genres = [
            { name: 'Electronic', icon: 'fa-bolt',       grad: 'linear-gradient(135deg, #7C3AED, #4C1D95)' },
            { name: 'Hip-Hop',    icon: 'fa-microphone', grad: 'linear-gradient(135deg, #F97316, #EF4444)' },
            { name: 'Lo-Fi',      icon: 'fa-cloud-moon', grad: 'linear-gradient(135deg, #06B6D4, #3B82F6)' },
            { name: 'Rock',       icon: 'fa-fire',       grad: 'linear-gradient(135deg, #DC2626, #991B1B)' },
        ];
        const genreCards = genres.map(g =>
            `<div class="genre-browse-card" style="background: ${g.grad}" onclick="document.querySelector('.premium-search-input').value='${g.name}'; document.querySelector('.premium-search-input').dispatchEvent(new Event('input'));">
                <i class="fas ${g.icon} genre-card-icon"></i>
                <span class="genre-card-label">${g.name}</span>
            </div>`
        ).join('');

        hub.innerHTML = `
            <div class="search-hero-section">
                <div class="search-hero-visual">
                    <canvas id="search-visualizer" width="600" height="200"></canvas>
                </div>
                <div class="search-hero-text">
                    <h2>Discover Something New</h2>
                    <p>Search across millions of songs — browse by language, mood, and genre</p>
                </div>
            </div>

            <div class="quick-chips-row">
                <span style="color:var(--text-subdued); font-size:13px; margin-right:8px; white-space:nowrap;">Try:</span>
                ${chipsHtml}
            </div>

            ${renderRecentSearchesHtml()}

            <h3 class="browse-section-title"><i class="fas fa-globe" style="color:var(--primary); margin-right:8px;"></i>Browse by Language</h3>
            <div class="genre-browse-grid">
                ${langCards}
            </div>

            <h3 class="browse-section-title" style="margin-top:24px;"><i class="fas fa-music" style="color:var(--primary); margin-right:8px;"></i>Browse by Genre</h3>
            <div class="genre-browse-grid">
                ${genreCards}
            </div>

            <h3 class="browse-section-title" style="margin-top:32px;">
                <i class="fas fa-fire" style="color:var(--primary); margin-right:8px;"></i>Trending Right Now
            </h3>
            <div class="card-grid trending-grid" id="search-trending-grid" style="display:grid;">
                ${skeletonCardGrid(6)}
            </div>
        `;
        cardGrid.appendChild(hub);
        bindRecentSearchChips(hub);

        // Local tracks below (hidden by default, shown on search)
        const localSection = document.createElement('div');
        localSection.id = 'local-search-results';
        localSection.style.display = 'none';
        localSection.innerHTML = '<h3 class="browse-section-title">Your Library</h3>';
        const localGrid = document.createElement('div');
        localGrid.className = 'card-grid';
        localGrid.style.display = 'grid';
        allTracks.forEach(track => {
            const card = document.createElement('div');
            card.className = 'card local-card';
            card.innerHTML = `
                <div class="card-image" style="background-image: url(${track.art})">
                    <div class="play-btn-overlay"><i class="fas fa-play"></i></div>
                </div>
                <div class="card-title">${track.name}</div>
                <div class="card-desc">${track.artist}</div>
            `;
            card.onclick = () => playTrack(track.plIdx, track.tIdx);
            attachCardActions(card, track, track.plIdx, track.tIdx);
            localGrid.appendChild(card);
        });
        localSection.appendChild(localGrid);
        cardGrid.appendChild(localSection);

        // Add container for audius search results
        const audiusContainer = document.createElement('div');
        audiusContainer.id = 'audius-results';
        audiusContainer.style.marginTop = '20px';
        audiusContainer.innerHTML = '<h3 class="browse-section-title" style="color:var(--primary);">Search Results</h3><div class="card-grid" id="audius-card-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 24px;"></div>';
        audiusContainer.style.display = 'none';
        cardGrid.appendChild(audiusContainer);

        // ─── Interactive Visualizer Canvas ──────────────────────────────────────
        const canvas = document.getElementById('search-visualizer');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            const particles = [];
            const PARTICLE_COUNT = 60;

            for (let i = 0; i < PARTICLE_COUNT; i++) {
                particles.push({
                    x: Math.random() * canvas.width,
                    y: Math.random() * canvas.height,
                    radius: Math.random() * 3 + 1,
                    speedX: (Math.random() - 0.5) * 0.8,
                    speedY: (Math.random() - 0.5) * 0.8,
                    opacity: Math.random() * 0.5 + 0.2,
                    hue: Math.random() * 40 - 10 // red-ish range
                });
            }

            let animFrame;
            function drawVisualizer() {
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                // Draw connecting lines between nearby particles
                for (let i = 0; i < particles.length; i++) {
                    for (let j = i + 1; j < particles.length; j++) {
                        const dx = particles[i].x - particles[j].x;
                        const dy = particles[i].y - particles[j].y;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist < 100) {
                            ctx.beginPath();
                            ctx.strokeStyle = `rgba(255, 60, 60, ${0.15 * (1 - dist / 100)})`;
                            ctx.lineWidth = 0.5;
                            ctx.moveTo(particles[i].x, particles[i].y);
                            ctx.lineTo(particles[j].x, particles[j].y);
                            ctx.stroke();
                        }
                    }
                }

                // Draw and move particles
                particles.forEach(p => {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                    ctx.fillStyle = `hsla(${p.hue}, 80%, 60%, ${p.opacity})`;
                    ctx.fill();

                    p.x += p.speedX;
                    p.y += p.speedY;

                    // Bounce off edges
                    if (p.x < 0 || p.x > canvas.width) p.speedX *= -1;
                    if (p.y < 0 || p.y > canvas.height) p.speedY *= -1;
                });

                animFrame = requestAnimationFrame(drawVisualizer);
            }
            drawVisualizer();

            // Clean up when leaving search view
            const observer = new MutationObserver(() => {
                if (!document.getElementById('search-visualizer')) {
                    cancelAnimationFrame(animFrame);
                    observer.disconnect();
                }
            });
            observer.observe(cardGrid, { childList: true });
        }

        // ─── Auto-load Trending Tracks ──────────────────────────────────────────
        (async () => {
            const trendGrid = document.getElementById('search-trending-grid');
            if (!trendGrid) return;
            try {
                const tracks = await fetchCatalogTracks("Latest Hits", 12);

                if (tracks.length === 0) {
                    trendGrid.innerHTML = '<p style="color:var(--text-subdued); padding:20px;">Could not load trending.</p>';
                    return;
                }

                let trendPlIndex = playlists.findIndex(pl => pl.id === 'audius_trending_search');
                if (trendPlIndex === -1) {
                    trendPlIndex = playlists.length;
                    playlists.push({ id: 'audius_trending_search', name: 'Trending', tracks: [], isTemporary: true });
                }

                playlists[trendPlIndex].tracks = tracks;

                trendGrid.innerHTML = '';
                tracks.forEach((track, tIdx) => {
                    trendGrid.appendChild(createTrackCard(track, trendPlIndex, tIdx));
                });
            } catch(e) {
                trendGrid.innerHTML = '<p style="color:var(--text-subdued); padding:20px;">Couldn\'t load trending tracks.</p>';
            }
        })();
        // ────────────────────────────────────────────────────────────────────────
    }

    // ─── Language Landing Page ─────────────────────────────────────────────────
    window._openLanguagePage = function(langIdx) {
        const lang = window._palmplayLanguages[langIdx];
        if (lang) renderLanguagePage(lang);
    };

    async function renderLanguagePage(lang) {
        state.currentView = 'language';
        document.body.classList.add('lang-view-active');
        setHeaderSearchVisible(false);
        viewHeader.style.display = 'none';
        if (exploreHero) exploreHero.style.display = 'none';
        if (categoryChips) categoryChips.style.display = 'none';
        cardGrid.style.display = 'block';
        cardGrid.innerHTML = '';

        const moodIcons = {
            'Romantic': 'fa-heart', 'Party': 'fa-glass-cheers', 'Chill': 'fa-cloud-moon',
            'Devotional': 'fa-pray', 'Workout': 'fa-dumbbell', 'Sad': 'fa-cloud-rain',
            'Kuthu': 'fa-drum', 'Melody': 'fa-music', 'Mass': 'fa-bolt', 'Folk': 'fa-leaf',
            'Bhangra': 'fa-drum', 'Pop': 'fa-star', 'Hip-Hop': 'fa-microphone',
            'Rock': 'fa-guitar', 'R&B': 'fa-heart', 'EDM': 'fa-bolt',
            'K-Pop': 'fa-star', 'Ballad': 'fa-feather', 'Dance': 'fa-shoe-prints',
            'Reggaeton': 'fa-fire', 'Latin Pop': 'fa-sun', 'Bachata': 'fa-heart',
            'Classic': 'fa-landmark', 'Focus': 'fa-brain'
        };

        // Build mood chips
        const moodChips = lang.moods.map((mood, i) =>
            `<button class="lang-mood-chip ${i === 0 ? 'active' : ''}" data-mood="${mood}" data-lang="${lang.name}">
                <i class="fas ${moodIcons[mood] || 'fa-music'}"></i> ${mood}
            </button>`
        ).join('');

        // Build mood rows (each will load independently)
        const moodRows = lang.moods.map(mood =>
            `<div class="lang-mood-section" id="mood-${mood.replace(/[^a-zA-Z]/g, '')}">
                <h3 class="browse-section-title">
                    <i class="fas ${moodIcons[mood] || 'fa-music'}" style="color:var(--primary); margin-right:8px;"></i>${lang.name} ${mood}
                </h3>
                <div class="lang-mood-scroll" id="mood-grid-${mood.replace(/[^a-zA-Z]/g, '')}">
                    ${skeletonCardGrid(4)}
                </div>
            </div>`
        ).join('');

        cardGrid.innerHTML = `
            <div class="lang-page" style="animation: hubFadeIn 0.4s ease;">
                <div class="lang-hero" style="background: ${lang.grad}">
                    <button class="lang-back-btn" type="button">
                        <i class="fas fa-arrow-left"></i> Back
                    </button>
                    <div class="lang-hero-script">${lang.script}</div>
                    <div class="lang-hero-info">
                        <h1 class="lang-hero-title">${lang.name}</h1>
                        <p class="lang-hero-subtitle">Explore ${lang.moods.length} moods · PalmPlay</p>
                    </div>
                    <button class="lang-play-all-btn" id="lang-play-all">
                        <i class="fas fa-play"></i> Play All
                    </button>
                </div>

                <!-- Language Specific Contextual Search Bar -->
                <div class="lang-search-box-container">
                    <div class="lang-search-wrapper">
                        <i class="fas fa-search lang-search-icon"></i>
                        <input type="text" class="lang-search-input-field" placeholder="Search within ${lang.name} music...">
                    </div>
                </div>

                <!-- Contextual Search Results Section -->
                <div class="lang-search-results-section" style="display: none; margin-bottom: 28px;">
                    <h3 class="browse-section-title">
                        <i class="fas fa-search" style="color:var(--primary); margin-right:8px;"></i>Search Results in ${lang.name}
                    </h3>
                    <div class="card-grid lang-search-results-grid"></div>
                </div>

                <div class="lang-mood-chips-row">
                    ${moodChips}
                </div>

                <div class="lang-mood-rows">
                    ${moodRows}
                </div>
            </div>
        `;

        // Back button via Search nav link
        const backBtn = cardGrid.querySelector('.lang-back-btn');
        if (backBtn) {
            backBtn.onclick = (e) => {
                e.preventDefault();
                window.PalmPlayNav.back();
            };
        }

        const setActiveLangMood = (moodName) => {
            const safeId = 'mood-' + moodName.replace(/[^a-zA-Z]/g, '');
            cardGrid.querySelectorAll('.lang-mood-section').forEach((sec) => {
                sec.classList.toggle('mood-section-visible', sec.id === safeId);
            });
            if (window.matchMedia('(max-width: 1024px)').matches) {
                const target = document.getElementById(safeId);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        };

        if (lang.moods.length > 0) {
            setActiveLangMood(lang.moods[0]);
        }

        cardGrid.querySelectorAll('.lang-mood-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                cardGrid.querySelectorAll('.lang-mood-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                setActiveLangMood(chip.dataset.mood);
            });
        });

        // Initialize language contextual search functionality
        let langSearchTimeout = null;
        const searchInput = cardGrid.querySelector('.lang-search-input-field');
        const resultsSection = cardGrid.querySelector('.lang-search-results-section');
        const resultsGrid = cardGrid.querySelector('.lang-search-results-grid');
        const moodChipsRow = cardGrid.querySelector('.lang-mood-chips-row');
        const moodRowsContainer = cardGrid.querySelector('.lang-mood-rows');

        // Resolve healthy API host once
        let apiHost = AUDIUS_HOST;
        try {
            const hostRes = await fetch(AUDIUS_DISCOVERY_URL, { signal: AbortSignal.timeout(3000) });
            const hostData = await hostRes.json();
            if (hostData?.data?.length > 0) apiHost = hostData.data[0];
        } catch(_) {}

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const query = e.target.value.trim();
                clearTimeout(langSearchTimeout);

                if (query.length === 0) {
                    // Show standard sections
                    resultsSection.style.display = 'none';
                    moodChipsRow.style.display = 'flex';
                    moodRowsContainer.style.display = 'block';
                    return;
                }

                // Hide standard sections, show search results
                resultsSection.style.display = 'block';
                moodChipsRow.style.display = 'none';
                moodRowsContainer.style.display = 'none';

                resultsGrid.innerHTML = '<div style="padding:20px; color:var(--text-subdued);"><i class="fas fa-spinner fa-spin"></i> Searching inside ' + lang.name + '...</div>';

                langSearchTimeout = setTimeout(async () => {
                    try {
                        const tracks = await fetchCatalogTracks(`${lang.name} ${query}`, 30);

                        if (tracks.length === 0) {
                            resultsGrid.innerHTML = '<p style="color:var(--text-subdued); padding:20px;">No matching ' + lang.name + ' tracks found.</p>';
                            return;
                        }

                        // Create temporary playlist for search results
                        const plId = `lang_search_${lang.name}`;
                        let plIdx = playlists.findIndex(p => p.id === plId);
                        if (plIdx === -1) {
                            plIdx = playlists.length;
                            playlists.push({ id: plId, name: `${lang.name} Search Results`, tracks: [], isTemporary: true });
                        }

                        playlists[plIdx].tracks = tracks;

                        resultsGrid.innerHTML = '';
                        tracks.forEach((track, tIdx) => {
                            resultsGrid.appendChild(createTrackCard(track, plIdx, tIdx));
                        });
                    } catch (err) {
                        resultsGrid.innerHTML = '<p style="color:var(--text-subdued); padding:20px;">Error loading tracks.</p>';
                    }
                }, 500);
            });
        }

        // Use a stable Spotify-inspired all-time pool (instead of random mood queries)
        let allMoodTracks = [];
        const pool = await getSpotifyAllTimePool();
        const poolSize = pool.length;
        for (const mood of lang.moods) {
            const safeId = mood.replace(/[^a-zA-Z]/g, '');
            const grid = document.getElementById(`mood-grid-${safeId}`);
            if (!grid) continue;

            try {
                if (!poolSize) {
                    grid.innerHTML = '<p class="mood-empty">No tracks found for this mood.</p>';
                    continue;
                }
                const moodIdx = lang.moods.indexOf(mood);
                const tracksPerMood = Math.min(10, poolSize);
                const tracks = [];
                for (let i = 0; i < tracksPerMood; i++) {
                    const idx = (moodIdx * 3 + i) % poolSize;
                    const t = pool[idx];
                    if (t) tracks.push(t);
                }

                if (tracks.length === 0) {
                    grid.innerHTML = '<p class="mood-empty">No tracks found for this mood.</p>';
                    continue;
                }

                // Create playlist for this mood
                const plId = `lang_${lang.name}_${safeId}`;
                let plIdx = playlists.findIndex(p => p.id === plId);
                if (plIdx === -1) {
                    plIdx = playlists.length;
                    playlists.push({ id: plId, name: `${lang.name} ${mood}`, tracks: [], isTemporary: true });
                }

                playlists[plIdx].tracks = tracks;
                allMoodTracks = allMoodTracks.concat(tracks.map((t, i) => ({ plIdx, tIdx: i })));

                grid.innerHTML = '';
                tracks.forEach((track, tIdx) => {
                    const card = document.createElement('div');
                    card.className = 'lang-track-card card--has-menu';
                    const playsLabel = track.plays > 0 ? `${(track.plays / 1000).toFixed(0)}K` : '';
                    card.innerHTML = `
                        <div class="lang-track-art" style="background-image: url('${escapeHtml(track.art)}')">
                            <div class="play-btn-overlay"><i class="fas fa-play"></i></div>
                            ${playsLabel ? `<span class="plays-badge"><i class="fas fa-headphones" style="margin-right:3px"></i>${playsLabel}</span>` : ''}
                        </div>
                        <div class="lang-track-name">${escapeHtml(track.name)}</div>
                        <div class="lang-track-artist">${escapeHtml(track.artist)}</div>
                    `;
                    card.onclick = () => playTrack(plIdx, tIdx);
                    attachCardActions(card, track, plIdx, tIdx);
                    grid.appendChild(card);
                });

            } catch (e) {
                grid.innerHTML = '<p class="mood-empty">Failed to load.</p>';
            }
        }

        // Play All button: play first available track
        const playAllBtn = document.getElementById('lang-play-all');
        if (playAllBtn && allMoodTracks.length > 0) {
            playAllBtn.onclick = () => {
                const first = allMoodTracks[0];
                playTrack(first.plIdx, first.tIdx);
                showToast(`Playing ${lang.name} Collection`, 'fa-play');
            };
        }
    }
    // ─────────────────────────────────────────────────────────────────────────────

    async function filterCards(query) {
        const lowQuery = query.toLowerCase();

        // This logic depends on whether we are in search view or home view
        if (state.currentView === 'search') {
            // Toggle discovery hub vs search results
            const hub = cardGrid.querySelector('.search-discovery-hub');
            const localSection = document.getElementById('local-search-results');

            if (query.trim().length > 0) {
                // Searching: hide hub, show local + audius
                if (hub) hub.style.display = 'none';
                if (localSection) localSection.style.display = 'block';
            } else {
                // Empty: show hub, hide results
                if (hub) hub.style.display = 'block';
                if (localSection) localSection.style.display = 'none';
            }

            const localCards = cardGrid.querySelectorAll('.local-card');
            const allTracks = [];
            playlists.forEach((pl, plIdx) => {
                if (!pl.isTemporary) {
                    pl.tracks.forEach((t, tIdx) => {
                        allTracks.push({ ...t, plIdx, tIdx });
                    });
                }
            });

            localCards.forEach((card, index) => {
                const track = allTracks[index];
                if (!track) return;
                const isMatch = track.name.toLowerCase().includes(lowQuery) ||
                    track.artist.toLowerCase().includes(lowQuery);
                card.style.display = isMatch ? 'block' : 'none';
            });

            // Debounced catalog search
            clearTimeout(audiusSearchTimeout);
            const audiusContainer = document.getElementById('audius-results');
            const audiusGrid = document.getElementById('audius-card-grid');
            
            if (query.trim().length < 2) {
                audiusContainer.style.display = 'none';
                return;
            }

            audiusContainer.style.display = 'block';
            audiusGrid.innerHTML = '<p style="color:var(--text-subdued); padding:20px;"><i class="fas fa-spinner fa-spin"></i> Searching...</p>';

            audiusSearchTimeout = setTimeout(async () => {
                try {
                    const tracks = await fetchCatalogTracks(query, 30);
                    
                    if (tracks.length === 0) {
                        audiusGrid.innerHTML = '<p style="color:var(--text-subdued); padding:20px;">No tracks found for "' + escapeHtml(query) + '". Try different keywords.</p>';
                        return;
                    }

                    addRecentSearch(query);

                    // Map to internal format and render
                    let audiusPlIndex = playlists.findIndex(pl => pl.id === 'audius_search');
                    if (audiusPlIndex === -1) {
                        audiusPlIndex = playlists.length;
                        playlists.push({
                            id: 'audius_search',
                            name: 'Search Results',
                            tracks: [],
                            isTemporary: true
                        });
                    }
                    
                    playlists[audiusPlIndex].tracks = tracks;

                    audiusGrid.innerHTML = '';
                    tracks.forEach((track, tIdx) => {
                        const card = createTrackCard(track, audiusPlIndex, tIdx);
                        const desc = card.querySelector('.card-desc');
                        if (desc) {
                            const playsLabel = track.plays > 0
                                ? `${(track.plays / 1000).toFixed(0)}K plays`
                                : track.album;
                            desc.innerHTML = `${buildTrackMetaLine(track)}<span class="meta-sep"> · </span><span class="meta-plays">${escapeHtml(playsLabel)}</span>`;
                        }
                        audiusGrid.appendChild(card);
                    });
                    
                } catch (e) {
                    console.error('Catalog search failed:', e);
                    showErrorState(audiusGrid, {
                        icon: 'fa-exclamation-triangle',
                        title: 'Search failed',
                        message: navigator.onLine ? 'Could not reach the music service. Try again in a moment.' : 'You appear to be offline.',
                        onRetry: () => filterCards(query)
                    });
                }
            }, 800);
        }
    }

    // --- Formatting Helpers ---

    function formatDuration(seconds) {
        if (!seconds || !isFinite(seconds)) return '--:--';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function formatDateAdded(isoString) {
        if (!isoString) return '-';
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays} days ago`;
        if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;

        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    // --- Liked Songs Helpers ---

    function isTrackLiked(track) {
        return likedSongs.some(ls => ls.trackName === track.name && ls.artist === track.artist);
    }

    async function toggleLike(track, plIndex, tIndex) {
        const savedUser = getSavedUser();
        const uid = getUserId(savedUser);
        if (!uid) {
            showToast('Please log in to like songs!', 'fa-user-lock');
            return;
        }

        const existingIndex = likedSongs.findIndex(ls => ls.trackName === track.name && ls.artist === track.artist);

        if (existingIndex !== -1) {
            // Unlike
            const likedEntry = likedSongs[existingIndex];
            try {
                await db.likedSongs.delete(likedEntry.id);
            } catch (e) {
                console.error('Failed to delete liked song from DB:', e);
            }
            likedSongs.splice(existingIndex, 1);
            state.isLiked = false;
            showToast('Removed from Liked Songs', 'fa-heart-broken');
            window.PalmPlaySync?.removeLike?.(track.name, track.artist).catch((e) => console.warn('Cloud unlike', e));
        } else {
            // Like — store the actual blob data for persistence
            const likedData = {
                userId: uid,
                trackName: track.name,
                artist: track.artist,
                album: track.album || null,
                duration: track.duration || 0,
                dateAdded: new Date().toISOString(),
                artBlob: track.artBlob || null,
                playlistId: playlists[plIndex]?.id || null,
                trackIndex: tIndex,
                isAudius: track.isAudius || false,
                isCatalog: track.isCatalog || false,
                source: getTrackSource(track),
                externalId: track.externalId || ((track.isCatalog || track.isAudius) ? track.id : null),
                url: track.url || null,
                artUrl: track.art || null
            };
            try {
                const newId = await db.likedSongs.add(likedData);
                // In memory, keep a runtime art URL
                likedSongs.push({
                    ...likedData,
                    id: newId,
                    art: track.art || DEFAULT_ART_URL
                });
            } catch (e) {
                console.error('Failed to save liked song to DB:', e);
                // Still add to memory even if DB fails
                likedSongs.push({
                    ...likedData,
                    id: Date.now(),
                    art: track.art || DEFAULT_ART_URL
                });
            }
            state.isLiked = true;
            showToast('Added to Liked Songs', 'fa-heart');
            const last = likedSongs[likedSongs.length - 1];
            if (last) window.PalmPlaySync?.pushLike?.(last).catch((e) => console.warn('Cloud like', e));
        }

        renderSidebar();

        // Refresh liked songs view if currently showing
        if (state.currentView === 'likedSongs') {
            showLikedSongs();
        }
    }

    function showLikedSongs() {
        document.body.classList.remove('lang-view-active');
        state.currentView = 'likedSongs';
        const likedPlIndex = ensureLikedSongsPlaylist();
        const isLikedPlaylistCurrent = state.currentPlaylistIndex === likedPlIndex;

        viewHeader.style.display = 'none';
        greetingEl.style.display = 'none';
        if (exploreHero) exploreHero.style.display = 'none';
        if (categoryChips) categoryChips.style.display = 'none';
        header.style.backgroundColor = 'transparent';

        const savedUser = getSavedUser();
        const userName = savedUser.name || 'User';
        const totalSeconds = likedSongs.reduce((sum, ls) => sum + (ls.duration || 0), 0);
        const hrs = Math.floor(totalSeconds / 3600);
        const mins = Math.floor((totalSeconds % 3600) / 60);
        let durationText = `${likedSongs.length} songs`;
        if (hrs > 0) durationText += `, ${hrs} hr ${mins} min`;
        else if (mins > 0) durationText += `, ${mins} min`;

        cardGrid.innerHTML = `
            <div class="playlist-header-container liked-songs-header">
                <div class="playlist-art-large liked-art">
                    <i class="fas fa-heart" style="font-size:64px; color:white;"></i>
                </div>
                <div class="playlist-info-header">
                    <span class="pl-type">Playlist</span>
                    <h1 class="pl-title-large">Liked Songs</h1>
                    <div class="pl-meta">
                        <img src="https://ui-avatars.com/api/?name=${userName}&background=FF0000&color=fff" style="width:24px; border-radius:50%">
                        <strong>${userName}</strong> <span>• ${durationText}</span>
                    </div>
                </div>
            </div>
            
            <div class="pl-controls-bar">
                <button class="play-circle-btn" id="liked-main-play"><i class="fas ${isLikedPlaylistCurrent && state.isPlaying ? 'fa-pause' : 'fa-play'}"></i></button>
                <i class="fas fa-random pl-icon-btn" id="liked-shuffle" title="Shuffle" style="${state.isShuffle ? 'color:var(--primary)' : ''}"></i>
            </div>

            <table class="track-table">
                <thead>
                    <tr>
                        <th class="track-index-cell">#</th>
                        <th>Title</th>
                        <th>Album</th>
                        <th>Date Added</th>
                        <th style="text-align:right"><i class="far fa-clock"></i></th>
                    </tr>
                </thead>
                <tbody id="liked-track-list-body"></tbody>
            </table>
        `;

        cardGrid.style.display = 'block';

        // Play button — toggle play/pause
        const likedPlayBtn = document.getElementById('liked-main-play');
        if (likedPlayBtn) {
            likedPlayBtn.onclick = () => {
                if (state.currentPlaylistIndex === likedPlIndex && audio.src) {
                    togglePlay();
                } else {
                    startCollectionPlayback(likedPlIndex);
                }
            };
        }

        // Shuffle button
        const shuffleBtn = document.getElementById('liked-shuffle');
        if (shuffleBtn) shuffleBtn.onclick = () => startCollectionPlayback(likedPlIndex, { shuffle: true });

        // Render tracks
        const tbody = document.getElementById('liked-track-list-body');
        if (likedSongs.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align:center; padding:40px; color:var(--text-subdued);">
                        <i class="far fa-heart" style="font-size:48px; display:block; margin-bottom:16px; opacity:0.3;"></i>
                        Songs you like will appear here.<br>Click the <i class="far fa-heart"></i> on the player bar to start adding!
                    </td>
                </tr>
            `;
            return;
        }

        likedSongs.forEach((liked, tIndex) => {
            const tr = document.createElement('tr');
            tr.className = `track-row ${isLikedPlaylistCurrent && state.currentTrackIndex === tIndex ? 'active' : ''}`;
            const artSrc = liked.art || DEFAULT_ART_URL;
            const albumName = liked.album || 'Liked Songs';
            const dateAdded = liked.dateAdded ? formatDateAdded(liked.dateAdded) : '-';
            const duration = liked.duration ? formatDuration(liked.duration) : '--:--';
            tr.innerHTML = `
                <td class="track-index-cell">${(tIndex + 1).toString().padStart(2, '0')}</td>
                <td style="display:flex; align-items:center;">
                    <img src="${artSrc}" class="row-art">
                    <div>
                        <div class="track-name-bold">${escapeHtml(liked.trackName)}</div>
                        <div class="track-artist-small">${escapeHtml(liked.artist)}</div>
                    </div>
                </td>
                <td style="color:var(--text-subdued); font-size:14px;">${escapeHtml(albumName)}</td>
                <td style="color:var(--text-subdued); font-size:14px;">${dateAdded}</td>
                <td style="text-align:right; color:var(--text-subdued); font-size:14px;">${duration}</td>
            `;
            tr.onclick = () => playLikedTrack(tIndex);
            tbody.appendChild(tr);
        });

        mainView.scrollTop = 0;
    }

    function playLikedTrack(likedIndex) {
        if (!likedSongs[likedIndex]) return;
        const likedPlIndex = ensureLikedSongsPlaylist();
        const track = playlists[likedPlIndex]?.tracks?.[likedIndex];
        if (!track) {
            showToast('Track not found in your library. It may have been removed.', 'fa-exclamation-triangle');
            return;
        }
        playTrack(likedPlIndex, likedIndex);
    }

    init();
    initAtmosphere();
});
