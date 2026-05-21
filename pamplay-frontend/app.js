
// API config (public: env-config.js; catalog URL: gitignored catalog-config.js only)
const _env = (typeof window !== 'undefined' && window.PALMPLAY_ENV) ? window.PALMPLAY_ENV : {};
const _catalog = (typeof window !== 'undefined' && window.PALMPLAY_CATALOG) ? window.PALMPLAY_CATALOG : {};
const AUDIUS_HOST = (_env.AUDIUS_API_HOST || 'https://discoveryprovider.audius.co').replace(/\/$/, '');
const AUDIUS_DISCOVERY_URL = _env.AUDIUS_DISCOVERY_URL || 'https://api.audius.co';
const AUDIUS_APP_NAME = _env.AUDIUS_APP_NAME || 'PalmPlay';
const MUSIC_CATALOG_API_BASE = (_catalog.apiBase || '').replace(/\/$/, '');
const DEFAULT_ART_URL = _env.DEFAULT_ART_URL || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=300&h=300&fit=crop';

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
                showToast('High demand — showing Audius picks for now', 'fa-bolt');
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
    gestureMode: false
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

// ─── Audio Engine with Crossfade Support ─────────────────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);

const audio = new Audio();
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
    const timeCurrent = document.querySelector('.progress-time:first-child');
    const timeTotal = document.querySelector('.progress-time:last-child');
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

    // Global Dropdown Helpers
    window.handleProfileAction = (action) => {
        const dropdown = document.getElementById('profile-dropdown');
        if (dropdown) dropdown.classList.remove('active');

        switch (action) {
            case 'logout':
                showModal('Log Out', 'Are you sure you want to log out of PalmPlay?', () => {
                    // Remove from active session
                    const savedUser = JSON.parse(localStorage.getItem('palmplay_user') || '{}');
                    localStorage.removeItem('palmplay_user');

                    // Also remove from switcher list on explicit logout
                    const accounts = JSON.parse(localStorage.getItem('palmplay_accounts') || '[]');
                    const filtered = accounts.filter(a => a.email !== savedUser.email);
                    localStorage.setItem('palmplay_accounts', JSON.stringify(filtered));

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
            <div class="dropdown-item" onclick="window.location.href='login.html'" style="border: 1px dashed rgba(255,255,255,0.2); justify-content:center; padding:16px;">
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
                // Delete tracks first then playlist
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
    async function init() {
        setupEventListeners();
        setupKeyboardShortcuts();
        await loadFromDatabase();
        updatePlayerUI();
    }

    async function loadFromDatabase() {
        console.log('Loading from database fresh...');
        playlists = []; // Clear existing state to prevent duplicates
        likedSongs = []; // Clear liked songs
        const savedUser = JSON.parse(localStorage.getItem('palmplay_user') || '{}');
        if (!savedUser.email) {
            console.log('No user logged in, skipping database load.');
            renderHome();
            return;
        }

        try {
            const savedPlaylists = await db.playlists.where('userId').equals(savedUser.email).toArray();
            for (const pl of savedPlaylists) {
                const plTracks = await db.tracks.where('playlistId').equals(pl.id).toArray();

                // Recreate blob URLs for each track and compute missing durations
                const tracksWithUrls = [];
                for (const t of plTracks) {
                    const url = URL.createObjectURL(t.audioBlob);
                    let duration = t.duration || 0;
                    // Compute duration if not stored
                    if (!duration && t.audioBlob) {
                        duration = await getAudioDuration(t.audioBlob);
                    }
                    tracksWithUrls.push({
                        ...t,
                        url,
                        duration,
                        art: t.artBlob ? URL.createObjectURL(t.artBlob) : DEFAULT_ART_URL
                    });
                }

                playlists.push({
                    id: pl.id,
                    name: pl.name,
                    tracks: tracksWithUrls
                });
            }

            // Load liked songs from DB
            try {
                const savedLiked = await db.likedSongs.where('userId').equals(savedUser.email).toArray();
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
                            name: 'Audius Search Results',
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
            renderHome();
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

        fileInput.onchange = (e) => handleFiles(e.target.files, false);
        folderInput.onchange = (e) => handleFiles(e.target.files, true);

        // Navigation Links
        const navLinks = document.querySelectorAll('.nav-item');
        navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                const href = link.getAttribute('href');
                // Allow navigation if it's a different HTML file
                if (href && href.includes('.html') && !href.includes(window.location.pathname.split('/').pop())) {
                    return; // Let the browser navigate
                }

                e.preventDefault();
                navLinks.forEach(l => l.classList.remove('active'));
                link.classList.add('active');

                const view = link.textContent.trim().toLowerCase();
                if (view === 'home' || view === 'explore') {
                    state.currentView = 'home';
                    searchContainer.style.display = 'none';
                    viewHeader.style.display = 'block';
                    renderHome();
                } else if (view === 'search') {
                    state.currentView = 'search';
                    searchContainer.style.display = 'flex';
                    viewHeader.style.display = 'none';
                    renderSearch();
                }
            });
        });

        // Search Filtering
        const searchInput = searchContainer.querySelector('input');
        searchInput.addEventListener('input', (e) => {
            filterCards(e.target.value);
        });

        // Back Navigation
        document.querySelector('.fa-chevron-left').parentElement.onclick = () => {
            if (state.currentView !== 'home') {
                const homeLink = document.querySelector('.nav-item');
                if (homeLink) homeLink.click();
            }
        };

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
        volumeBar.addEventListener('click', setVolume);

        // Heart / Like Control
        const heartBtn = document.querySelector('.track-info .control-btn');
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

        // Auxiliary Premium Toasts
        const auxButtonsSelector = ['.fa-microphone', '.fa-list', '.fa-desktop'];
        auxButtonsSelector.forEach(selector => {
            const btn = document.querySelector(selector);
            if (btn) {
                btn.addEventListener('click', () => showToast('Feature Coming Soon...', 'fa-star'));
            }
        });

        // Audio Events
        audio.ontimeupdate = () => {
            if (audio.duration) {
                state.progress = (audio.currentTime / audio.duration) * 100;
                progressFill.style.width = `${state.progress}%`;
                timeCurrent.textContent = formatTime(audio.currentTime);
            }
        };

        audio.onended = () => {
            if (state.repeatMode === 2) { // Repeat One
                audio.currentTime = 0;
                audio.play();
            } else if (state.repeatMode === 1 || state.repeatMode === 0) { // Repeat All or None
                playNext(); // playNext handles looping to start if at end
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
        const savedUser = JSON.parse(localStorage.getItem('palmplay_user') || '{}');

        if (!savedUser.email) {
            showToast('Please log in or sign up to save your music collection!', 'fa-user-lock');
            window.location.href = 'login.html';
            return;
        }

        showToast(`Adding folder "${folderName}"...`, 'fa-folder-plus');

        // Save to DB first to get a playlist ID
        const plId = await db.playlists.add({
            name: folderName,
            userId: savedUser.email
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
                userId: savedUser.email,
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
            const item = document.createElement('a');
            item.href = '#';
            item.className = 'playlist-item';
            item.innerHTML = `<i class="fas fa-music" style="margin-right:8px; opacity:0.7"></i> ${pl.name}`;
            item.onclick = (e) => {
                e.preventDefault();
                showPlaylist(index);
            };
            localTracksList.appendChild(item);
        });
    }

    function renderHome() {
        state.currentView = 'home';
        searchContainer.style.display = 'none';
        viewHeader.style.display = 'block';
        greetingEl.style.display = 'block';
        if (exploreHero) exploreHero.style.display = 'flex';
        if (categoryChips) categoryChips.style.display = 'flex';

        // Dynamic Title based on Page
        const isExplore = window.location.pathname.includes('explore.html');
        
        if (isExplore) {
            window.renderExplore = renderExplore;
            const activeChip = document.querySelector('.chip.active');
            const genre = activeChip ? activeChip.getAttribute('data-genre') : 'Trending';
            renderExplore(genre);
            return;
        }

        sectionTitleEl.textContent = 'Your Collection';
        header.style.backgroundColor = 'transparent';

        const savedUser = JSON.parse(localStorage.getItem('palmplay_user') || '{}');

        if (!savedUser.isLoggedIn) {
            greetingEl.textContent = "Welcome to PalmPlay";
            cardGrid.innerHTML = `
                <div style="color:var(--text-subdued); padding:60px 40px; background: radial-gradient(circle at top left, rgba(255,0,0,0.1), transparent); border-radius:16px; border: 1px solid rgba(255,255,255,0.05); grid-column: 1/-1; text-align:center;">
                    <h2 style="color:white; margin-bottom:16px; font-size:42px; font-weight:800; letter-spacing:-1.5px;">Your personal music hub.</h2>
                    <p style="font-size:18px; margin-bottom:40px; max-width:600px; margin-left:auto; margin-right:auto;">Log in or sign up to access your saved playlists, local tracks, and personalized premium vibes.</p>
                    <div style="display:flex; justify-content:center; gap:20px;">
                        <button onclick="window.location.href='login.html'" class="upgrade-btn" style="padding: 16px 40px; font-size:16px;">Log In</button>
                        <button onclick="window.location.href='signup.html'" class="upgrade-btn" style="background:transparent; border:1px solid white; color:white; padding: 16px 40px; font-size:16px;">Sign Up</button>
                    </div>
                </div>
            `;
            return;
        }

        if (isExplore) {
            greetingEl.textContent = `Explore the Treat to Your Ears, ${savedUser.name}`;
        } else {
            greetingEl.textContent = `${getRandomWish()}, ${savedUser.name}`;
        }
        cardGrid.innerHTML = '';
        cardGrid.style.display = 'grid'; // Ensure grid layout
        playlists.forEach((pl, index) => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `
                <div class="card-image" style="background-image: url(${pl.tracks[0]?.art})">
                    <div class="play-btn-overlay"><i class="fas fa-play"></i></div>
                </div>
                <div class="card-title">${pl.name}</div>
                <div class="card-desc">${pl.tracks.length} songs</div>
            `;
            card.onclick = () => showPlaylist(index);
            cardGrid.appendChild(card);
        });

        if (playlists.length === 0) {
            cardGrid.innerHTML = `
                <div style="color:var(--text-subdued); padding:40px; background: rgba(255,255,255,0.02); border-radius:12px; border: 1px dashed rgba(255,255,255,0.1); grid-column: 1/-1;">
                    <h3 style="color:white; margin-bottom:16px; font-size:20px;">Start your collection in 3 easy steps:</h3>
                    <p style="margin-bottom:12px;"><strong>Step 1:</strong> Click the <strong><i class="fas fa-plus"></i></strong> icon in the sidebar.</p>
                    <p style="margin-bottom:12px;"><strong>Step 2:</strong> Select <strong>"Add Folder"</strong> to choose your music directory.</p>
                    <p><strong>Step 3:</strong> Your songs will automatically appear here with metadata!</p>
                </div>
            `;
        }
    }

    async function renderExplore(category) {
        state.currentView = 'explore';
        searchContainer.style.display = 'none';
        viewHeader.style.display = 'block';
        greetingEl.style.display = 'block';
        if (exploreHero) exploreHero.style.display = 'flex';
        if (categoryChips) categoryChips.style.display = 'flex';
        
        const savedUser = JSON.parse(localStorage.getItem('palmplay_user') || '{}');
        greetingEl.textContent = `Explore the Treat to Your Ears, ${savedUser.name || 'Guest'}`;
        sectionTitleEl.textContent = `${category} Tracks`;
        header.style.backgroundColor = 'transparent';
        
        cardGrid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding: 40px; color: var(--text-subdued);"><i class="fas fa-spinner fa-spin" style="font-size: 24px; margin-bottom: 16px;"></i><p>Loading Audius Network...</p></div>';
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
                    name: 'Audius Explore',
                    tracks: [],
                    isTemporary: true
                });
            }
            
            const mappedTracks = audiusTracks.map(t => ({
                id: t.id,
                name: t.title,
                artist: t.user?.name || 'Unknown',
                album: 'Audius',
                duration: t.duration,
                url: `${AUDIUS_HOST}/v1/tracks/${t.id}/stream?app_name=${AUDIUS_APP_NAME}`,
                art: t.artwork?.['480x480'] || t.artwork?.['150x150'] || DEFAULT_ART_URL,
                isAudius: true
            }));
            
            playlists[audiusPlIndex].tracks = mappedTracks;
            
            mappedTracks.forEach((track, tIdx) => {
                const card = document.createElement('div');
                card.className = 'card audius-card';
                card.innerHTML = `
                    <div class="card-image" style="background-image: url(${track.art})">
                        <div class="play-btn-overlay"><i class="fas fa-play"></i></div>
                    </div>
                    <div class="card-title">${track.name}</div>
                    <div class="card-desc">${track.artist}</div>
                `;
                card.onclick = () => playTrack(audiusPlIndex, tIdx);
                cardGrid.appendChild(card);
            });
            
        } catch (err) {
            console.error("Explore API Error:", err);
            cardGrid.innerHTML = '<div style="grid-column: 1/-1; color:#ff4444; padding:20px;">Failed to fetch tracks from Audius.</div>';
        }
    }

    function showPlaylist(plIndex) {
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
                <button class="play-circle-btn" id="pl-main-play"><i class="fas fa-play"></i></button>
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
            if (state.currentPlaylistIndex === plIndex && state.isPlaying) {
                // Already playing this playlist, toggle pause
                togglePlay();
            } else if (state.currentPlaylistIndex === plIndex && !state.isPlaying && audio.src) {
                // Same playlist but paused, resume
                togglePlay();
            } else {
                // Start playing from track 0
                if (pl.tracks.length > 0) playTrack(plIndex, 0);
            }
        };

        document.getElementById('pl-shuffle').onclick = toggleShuffle;

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

    function playTrack(plIndex, tIndex) {
        state.currentPlaylistIndex = plIndex;
        state.currentTrackIndex = tIndex;
        const track = playlists[plIndex].tracks[tIndex];

        // ── Crossfade Engine ────────────────────────────────────────────────────
        // Resume AudioContext if suspended (browser policy)
        if (audioCtx.state === 'suspended') audioCtx.resume();

        const isFirstPlay = !audio.src;
        const FADE = CROSSFADE_DURATION;
        const now = audioCtx.currentTime;

        if (!isFirstPlay && currentSource.gain) {
            // Fade OUT current track
            currentSource.gain.gain.setValueAtTime(currentSource.gain.gain.value, now);
            currentSource.gain.gain.linearRampToValueAtTime(0, now + FADE);
            setTimeout(() => {
                audio.pause();
                audio.currentTime = 0;
            }, FADE * 1000);
        } else {
            audio.pause();
            audio.currentTime = 0;
        }

        // Load new track and fade IN
        audio.src = track.url;
        audio.playbackRate = state.playbackSpeed;
        if (!state.isMuted) {
            currentSource.gain.gain.setValueAtTime(isFirstPlay ? state.volume : 0, audioCtx.currentTime);
            if (!isFirstPlay) {
                currentSource.gain.gain.linearRampToValueAtTime(state.volume, audioCtx.currentTime + FADE);
            }
        }
        audio.play().catch(e => console.warn('Play blocked:', e));
        // ────────────────────────────────────────────────────────────────────────

        state.isPlaying = true;
        updatePlayerUI();

        // ── Dynamic Theme from Album Art ────────────────────────────────────────
        applyDynamicTheme(track.art);
        // ────────────────────────────────────────────────────────────────────────

        // Update playlist view UI if active
        if (state.currentView === 'playlist') {
            const plMainPlayIcon = document.querySelector('#pl-main-play i');
            if (plMainPlayIcon) plMainPlayIcon.className = 'fas fa-pause';

            const rows = document.querySelectorAll('.track-row');
            rows.forEach((row, idx) => {
                row.classList.toggle('active', idx === tIndex);
            });
        }
    }

    function togglePlay() {
        if (!audio.src) return;
        if (state.isPlaying) {
            audio.pause();
        } else {
            audio.play();
        }
        state.isPlaying = !state.isPlaying;
        updatePlayerUI();

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

    function playNext() {
        if (state.currentPlaylistIndex === -1) return;
        const pl = playlists[state.currentPlaylistIndex];

        if (state.isShuffle) {
            state.currentTrackIndex = Math.floor(Math.random() * pl.tracks.length);
        } else {
            state.currentTrackIndex = (state.currentTrackIndex + 1) % pl.tracks.length;
        }

        playTrack(state.currentPlaylistIndex, state.currentTrackIndex);
    }

    function playPrev() {
        if (state.currentPlaylistIndex === -1) return;
        const pl = playlists[state.currentPlaylistIndex];
        state.currentTrackIndex = (state.currentTrackIndex - 1 + pl.tracks.length) % pl.tracks.length;
        playTrack(state.currentPlaylistIndex, state.currentTrackIndex);
    }

    function seek(e) {
        if (!audio.src) return;
        const rect = progressBar.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        audio.currentTime = pos * audio.duration;
    }

    function toggleShuffle() {
        state.isShuffle = !state.isShuffle;
        const shuffleBtn = document.querySelector('#pl-shuffle');
        if (shuffleBtn) {
            shuffleBtn.style.color = state.isShuffle ? 'var(--primary)' : 'var(--text-subdued)';
        }
        // Also update player bar shuffle if it exists
        const playerShuffle = document.querySelector('.player-bar .fa-random');
        if (playerShuffle) {
            playerShuffle.style.color = state.isShuffle ? 'var(--primary)' : 'var(--text-subdued)';
        }
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
        const savedUser = JSON.parse(localStorage.getItem('palmplay_user') || '{}');
        const profileBtn = document.querySelector('.profile-btn');

        if (savedUser.isLoggedIn) {
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
                profileBtn.onclick = () => window.location.href = 'login.html';

                // Cleanup dropdown if it exists while logged out
                const wrapper = profileBtn.parentElement;
                if (wrapper && wrapper.classList.contains('profile-dropdown-container')) {
                    const dropdown = wrapper.querySelector('.profile-dropdown');
                    if (dropdown) dropdown.remove();
                }
            }
        }

        if (state.currentPlaylistIndex === -1) {
            trackNameEl.textContent = "Select a song";
            artistNameEl.textContent = "Add music from sidebar";
            return;
        }

        const track = playlists[state.currentPlaylistIndex].tracks[state.currentTrackIndex];
        trackNameEl.textContent = track.name;
        artistNameEl.textContent = track.artist;
        albumArtEl.style.backgroundImage = `url(${track.art})`;

        // Sync heart icon with liked state
        const heartBtn = document.querySelector('.track-info .control-btn');
        if (heartBtn) {
            const liked = isTrackLiked(track);
            state.isLiked = liked;
            const icon = heartBtn.querySelector('i');
            icon.className = liked ? 'fas fa-heart' : 'far fa-heart';
            icon.style.color = liked ? 'var(--primary)' : '';
        }

        playIcon.className = state.isPlaying ? 'fas fa-pause' : 'fas fa-play';

        if (audio.duration) {
            timeTotal.textContent = formatTime(audio.duration);
        }
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
            album: 'Audius',
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
            const useTrending = /^latest\s+hits$/i.test(q) || q.length < 2;
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

            return results.map(t => {
                const img = pickMediaUrl(t.image) || DEFAULT_ART_URL;
                const streamUrl = pickMediaUrl(t.downloadUrl);

                let artist = '';
                if (Array.isArray(t.artists?.primary) && t.artists.primary.length > 0) {
                    artist = t.artists.primary.map(a => a?.name).filter(Boolean).join(', ');
                } else if (Array.isArray(t.artists?.all) && t.artists.all.length > 0) {
                    artist = t.artists.all.map(a => a?.name).filter(Boolean).join(', ');
                } else if (typeof t.primaryArtists === 'string') {
                    artist = t.primaryArtists;
                }

                return {
                    id: t.id,
                    name: decodeHtmlEntities(t.name) || 'Unknown',
                    artist: decodeHtmlEntities(artist) || 'Various Artists',
                    album: decodeHtmlEntities(t.album?.name) || 'Single',
                    duration: parseInt(t.duration) || 200,
                    language: t.language || '',
                    plays: Math.floor(Math.random() * 50000) + 10000,
                    url: streamUrl,
                    art: img,
                    isCatalog: true
                };
            }).filter(t => t.url);
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
        searchContainer.style.display = 'flex';
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
                <div style="grid-column: 1/-1; text-align:center; padding:30px; color:var(--text-subdued);">
                    <i class="fas fa-spinner fa-spin" style="font-size:20px;"></i>
                    <p style="margin-top:8px;">Loading trending tracks...</p>
                </div>
            </div>
        `;
        cardGrid.appendChild(hub);

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
                    const card = document.createElement('div');
                    card.className = 'card';
                    const playsLabel = track.plays > 0 ? `${(track.plays / 1000).toFixed(0)}K` : '';
                    card.innerHTML = `
                        <div class="card-image" style="background-image: url(${track.art})">
                            <div class="play-btn-overlay"><i class="fas fa-play"></i></div>
                            ${playsLabel ? `<span class="plays-badge"><i class="fas fa-headphones" style="margin-right:4px"></i>${playsLabel}</span>` : ''}
                        </div>
                        <div class="card-title">${track.name}</div>
                        <div class="card-desc">${track.artist}</div>
                    `;
                    card.onclick = () => playTrack(trendPlIndex, tIdx);
                    trendGrid.appendChild(card);
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
        searchContainer.style.display = 'none';
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
                    <div class="mood-loader"><i class="fas fa-spinner fa-spin"></i> Loading...</div>
                </div>
            </div>`
        ).join('');

        cardGrid.innerHTML = `
            <div class="lang-page" style="animation: hubFadeIn 0.4s ease;">
                <div class="lang-hero" style="background: ${lang.grad}">
                    <button class="lang-back-btn" onclick="document.querySelector('.nav-item:last-child').click()">
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
                    <div class="card-grid lang-search-results-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 24px;"></div>
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
                state.currentView = 'search';
                renderSearch();
            };
        }

        // Mood chip click → scroll to that section
        cardGrid.querySelectorAll('.lang-mood-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                cardGrid.querySelectorAll('.lang-mood-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                const targetId = 'mood-' + chip.dataset.mood.replace(/[^a-zA-Z]/g, '');
                const target = document.getElementById(targetId);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
                            const card = document.createElement('div');
                            card.className = 'card';
                            const playsLabel = track.plays > 0 ? `${(track.plays / 1000).toFixed(0)}K` : '';
                            card.innerHTML = `
                                <div class="card-image" style="background-image: url(${track.art})">
                                    <div class="play-btn-overlay"><i class="fas fa-play"></i></div>
                                    ${playsLabel ? `<span class="plays-badge"><i class="fas fa-headphones" style="margin-right:4px"></i>${playsLabel}</span>` : ''}
                                </div>
                                <div class="card-title">${track.name}</div>
                                <div class="card-desc">${track.artist}</div>
                            `;
                            card.onclick = () => playTrack(plIdx, tIdx);
                            resultsGrid.appendChild(card);
                        });
                    } catch (err) {
                        resultsGrid.innerHTML = '<p style="color:var(--text-subdued); padding:20px;">Error loading tracks.</p>';
                    }
                }, 500);
            });
        }

        // Fetch each mood row independently
        let allMoodTracks = [];
        for (const mood of lang.moods) {
            const safeId = mood.replace(/[^a-zA-Z]/g, '');
            const grid = document.getElementById(`mood-grid-${safeId}`);
            if (!grid) continue;

            try {
                const query = `${lang.name} ${mood}`;
                const tracks = await fetchCatalogTracks(query, 15);

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
                    card.className = 'lang-track-card';
                    const playsLabel = track.plays > 0 ? `${(track.plays / 1000).toFixed(0)}K` : '';
                    card.innerHTML = `
                        <div class="lang-track-art" style="background-image: url(${track.art})">
                            <div class="play-btn-overlay"><i class="fas fa-play"></i></div>
                            ${playsLabel ? `<span class="plays-badge"><i class="fas fa-headphones" style="margin-right:3px"></i>${playsLabel}</span>` : ''}
                        </div>
                        <div class="lang-track-name">${track.name}</div>
                        <div class="lang-track-artist">${track.artist}</div>
                    `;
                    card.onclick = () => playTrack(plIdx, tIdx);
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

            // Debounced Audius Fetch
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
                        audiusGrid.innerHTML = '<p style="color:var(--text-subdued); padding:20px;">No tracks found for "' + query + '". Try different keywords.</p>';
                        return;
                    }

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
                        const card = document.createElement('div');
                        card.className = 'card';
                        const playsLabel = track.plays > 0
                            ? `${(track.plays / 1000).toFixed(0)}K plays`
                            : track.album;
                        card.innerHTML = `
                            <div class="card-image" style="background-image: url(${track.art})">
                                <div class="play-btn-overlay"><i class="fas fa-play"></i></div>
                            </div>
                            <div class="card-title">${track.name}</div>
                            <div class="card-desc">${track.artist} · <span style="color:var(--primary)">${playsLabel}</span></div>
                        `;
                        card.onclick = () => playTrack(audiusPlIndex, tIdx);
                        audiusGrid.appendChild(card);
                    });
                    
                } catch (e) {
                    console.error('Catalog search failed:', e);
                    audiusGrid.innerHTML = '<p style="color:#ff4444; padding:20px;"><i class="fas fa-exclamation-triangle"></i> Could not load results. Check your connection.</p>';
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
        const savedUser = JSON.parse(localStorage.getItem('palmplay_user') || '{}');
        if (!savedUser.email) {
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
        } else {
            // Like — store the actual blob data for persistence
            const likedData = {
                userId: savedUser.email,
                trackName: track.name,
                artist: track.artist,
                album: track.album || null,
                duration: track.duration || 0,
                dateAdded: new Date().toISOString(),
                artBlob: track.artBlob || null,
                playlistId: playlists[plIndex]?.id || null,
                trackIndex: tIndex,
                isAudius: track.isAudius || false,
                url: track.isAudius ? track.url : null,
                artUrl: track.isAudius ? track.art : null
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
        }

        renderSidebar();

        // Refresh liked songs view if currently showing
        if (state.currentView === 'likedSongs') {
            showLikedSongs();
        }
    }

    function showLikedSongs() {
        state.currentView = 'likedSongs';

        viewHeader.style.display = 'none';
        greetingEl.style.display = 'none';
        if (exploreHero) exploreHero.style.display = 'none';
        if (categoryChips) categoryChips.style.display = 'none';
        header.style.backgroundColor = 'transparent';

        const savedUser = JSON.parse(localStorage.getItem('palmplay_user') || '{}');
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
                <button class="play-circle-btn" id="liked-main-play"><i class="fas ${state.isPlaying ? 'fa-pause' : 'fa-play'}"></i></button>
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
                if (state.isPlaying && audio.src) {
                    // Currently playing, toggle pause
                    togglePlay();
                } else if (!state.isPlaying && audio.src) {
                    // Paused, resume
                    togglePlay();
                } else {
                    // Nothing playing, start from first liked track
                    if (likedSongs.length > 0) {
                        playLikedTrack(0);
                    }
                }
            };
        }

        // Shuffle button
        const shuffleBtn = document.getElementById('liked-shuffle');
        if (shuffleBtn) shuffleBtn.onclick = toggleShuffle;

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
            tr.className = 'track-row';
            const artSrc = liked.art || DEFAULT_ART_URL;
            const albumName = liked.album || 'Liked Songs';
            const dateAdded = liked.dateAdded ? formatDateAdded(liked.dateAdded) : '-';
            const duration = liked.duration ? formatDuration(liked.duration) : '--:--';
            tr.innerHTML = `
                <td class="track-index-cell">${(tIndex + 1).toString().padStart(2, '0')}</td>
                <td style="display:flex; align-items:center;">
                    <img src="${artSrc}" class="row-art">
                    <div>
                        <div class="track-name-bold">${liked.trackName}</div>
                        <div class="track-artist-small">${liked.artist}</div>
                    </div>
                </td>
                <td style="color:var(--text-subdued); font-size:14px;">${albumName}</td>
                <td style="color:var(--text-subdued); font-size:14px;">${dateAdded}</td>
                <td style="text-align:right; color:var(--text-subdued); font-size:14px;">${duration}</td>
            `;
            tr.onclick = () => playLikedTrack(tIndex);
            tbody.appendChild(tr);
        });

        mainView.scrollTop = 0;
    }

    function playLikedTrack(likedIndex) {
        const liked = likedSongs[likedIndex];
        // Find the track in playlists
        for (let pi = 0; pi < playlists.length; pi++) {
            for (let ti = 0; ti < playlists[pi].tracks.length; ti++) {
                const track = playlists[pi].tracks[ti];
                if (track.name === liked.trackName && track.artist === liked.artist) {
                    playTrack(pi, ti);
                    return;
                }
            }
        }
        showToast('Track not found in your library. It may have been removed.', 'fa-exclamation-triangle');
    }

    init();
    initAtmosphere();
});
