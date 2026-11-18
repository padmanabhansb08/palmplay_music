// ─── PalmPlay Hand-Gesture Controls ──────────────────────────────────────────
// Uses MediaPipe Gesture Recognizer (runs 100% in the browser, no server).
// Webcam frames never leave the device.
//
//   ✋ Open palm (hold)        → Play
//   ✊ Fist (hold)             → Pause
//   ✌️ Victory (hold)          → Next track
//   ☝️ Pointing up (hold)      → Previous track
//   👍 Thumb up (hold)         → Volume up (repeats while held)
//   👎 Thumb down (hold)       → Volume down (repeats while held)
//   🤟 "I love you" (hold)     → Like / unlike current track
//   👋 Swipe hand left / right → Previous / next track
//
// Exposes window.PalmGestures = { start, stop, isRunning, Interpreter }
// and talks to the player only through window.PalmPlayer (defined in app.js).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const MP_VERSION = '0.10.14';
    const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
    const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
    const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

    const CONFIG = {
        minScore: 0.6,          // classifier confidence needed for a frame to count
        switchMs: 70,           // a new label must persist this long (~2 frames; kills 1-frame flicker)
        holdMs: 260,            // a pose must be held (still) this long before it fires
        fastScore: 0.85,        // ...but if the model is this confident,
        fastHoldMs: 160,        // ...this much hold is enough
        cooldownMs: 450,        // min gap between discrete actions (same pose can't re-fire until released anyway)
        volumeRepeatMs: 220,    // thumb up/down repeats at this rate while held
        volumeStep: 0.05,
        stillWindowMs: 100,     // window used to measure hand speed
        stillMaxDist: 0.04,     // wrist may move < 4% of frame in that window to count as "still"
        swipeWindowMs: 400,     // swipe must happen within this time
        swipeMinDx: 0.25,       // horizontal travel needed (fraction of frame width)
        swipeMaxDy: 0.15,       // and not too much vertical travel
        swipeRestMs: 150,       // hand must rest this long before a swipe (filters out waving)
        lostHandResetMs: 180,   // hand missing this long → reset everything (counts as "released")
    };

    const GESTURE_MAP = {
        Open_Palm:   { action: 'play',    label: 'Play',        icon: 'fa-play',          emoji: '✋' },
        Closed_Fist: { action: 'pause',   label: 'Pause',       icon: 'fa-pause',         emoji: '✊' },
        Victory:     { action: 'next',    label: 'Next track',  icon: 'fa-step-forward',  emoji: '✌️' },
        Pointing_Up: { action: 'prev',    label: 'Previous',    icon: 'fa-step-backward', emoji: '☝️' },
        Thumb_Up:    { action: 'volUp',   label: 'Volume up',   icon: 'fa-volume-up',     emoji: '👍', repeat: true },
        Thumb_Down:  { action: 'volDown', label: 'Volume down', icon: 'fa-volume-down',   emoji: '👎', repeat: true },
        ILoveYou:    { action: 'like',    label: 'Like',        icon: 'fa-heart',         emoji: '🤟' },
    };

    // ── Pure state machine: frames in, actions out. No DOM, easy to test. ──────
    class Interpreter {
        constructor(cfg = CONFIG, map = GESTURE_MAP) {
            this.cfg = cfg;
            this.map = map;
            this.lastFire = -Infinity;   // last discrete pose action
            this.lastSwipe = -Infinity;  // swipes have their own cooldown
            this.reset();
        }

        reset() {
            this.candidate = null;      // label currently being "held"
            this.since = 0;             // when the current hold started
            this.pending = undefined;   // label trying to replace the candidate (undefined = none; null = "no pose")
            this.pendingSince = 0;
            this.firedFor = null;       // discrete label already fired for this hold
            this.lastRepeat = -Infinity;
            this.track = [];            // recent wrist positions [{x,y,t}]
            this.lastSeen = -Infinity;
            this.conf = null;           // smoothed confidence of the current candidate
            this.stillSince = null;     // when the hand last became still
            this.anchor = null;         // rested position a swipe is measured from
        }

        /**
         * @param {{t:number, gesture?:string|null, score?:number, wrist?:{x:number,y:number}|null}} f
         *        wrist is in raw (un-mirrored) camera coordinates, 0..1
         * @returns {{action:string|null, via?:string, candidate:string|null, progress:number, moving:boolean}}
         */
        update(f) {
            const c = this.cfg;
            const t = f.t;

            if (!f.wrist) {
                if (t - this.lastSeen > c.lostHandResetMs) this.reset();
                return { action: null, candidate: null, progress: 0, moving: false };
            }
            this.lastSeen = t;

            // --- motion tracking --------------------------------------------
            this.track.push({ x: f.wrist.x, y: f.wrist.y, t });
            while (this.track.length && t - this.track[0].t > c.swipeWindowMs) this.track.shift();

            const recent = this.track.find(p => t - p.t <= c.stillWindowMs) || this.track[0];
            const moving = Math.hypot(f.wrist.x - recent.x, f.wrist.y - recent.y) > c.stillMaxDist;

            // --- swipe ------------------------------------------------------
            // A swipe = rest, then a fast horizontal flick. Requiring the rest
            // first is what stops a friendly wave (continuous motion) or the
            // hand returning after a swipe from triggering track changes.
            if (!moving) {
                if (this.stillSince === null) this.stillSince = t;
                if (t - this.stillSince >= c.swipeRestMs) this.anchor = { x: f.wrist.x, y: f.wrist.y, t };
            } else {
                this.stillSince = null;
            }
            if (this.anchor && t - this.anchor.t > c.swipeWindowMs) this.anchor = null;

            if (this.anchor && t - this.lastSwipe >= c.cooldownMs) {
                // Camera image is un-mirrored: when the user moves their hand to
                // THEIR right, x DEcreases. Flip so +dx = user's right.
                const dx = -(f.wrist.x - this.anchor.x);
                const dy = f.wrist.y - this.anchor.y;
                if (Math.abs(dx) >= c.swipeMinDx && Math.abs(dy) <= c.swipeMaxDy) {
                    this.lastSwipe = t;
                    this.lastFire = t;  // also block a pose action right after a swipe
                    this.track = [];
                    this.anchor = null;
                    this.stillSince = null;
                    this.candidate = null;
                    this.firedFor = null;
                    return { action: dx > 0 ? 'next' : 'prev', via: 'swipe', candidate: null, progress: 0, moving: true };
                }
            }

            // --- pose (debounced) -------------------------------------------
            let label = (f.gesture && f.gesture !== 'None' && (f.score ?? 0) >= c.minScore) ? f.gesture : null;
            if (label && !this.map[label]) label = null;

            if (label !== this.candidate) {
                if (label !== this.pending) {
                    this.pending = label;
                    this.pendingSince = t;
                }
                if (t - this.pendingSince >= c.switchMs || this.candidate === null) {
                    this.candidate = label;
                    this.since = t;
                    this.conf = null;
                    this.pending = undefined;
                    if (label !== this.firedFor) this.firedFor = null;
                }
            } else {
                this.pending = undefined;
            }

            if (!this.candidate) return { action: null, candidate: null, progress: 0, moving };

            // A moving hand is probably mid-swipe / repositioning, not a deliberate pose.
            if (moving) this.since = t;

            // Smoothed confidence → confident poses fire sooner.
            const s = label === this.candidate ? (f.score ?? 0) : 0;
            this.conf = this.conf == null ? s : this.conf * 0.6 + s * 0.4;
            const need = this.conf >= c.fastScore ? c.fastHoldMs : c.holdMs;

            const held = t - this.since;
            const progress = Math.min(1, held / need);
            const def = this.map[this.candidate];
            let action = null;

            if (held >= need) {
                if (def.repeat) {
                    if (t - this.lastRepeat >= c.volumeRepeatMs) {
                        this.lastRepeat = t;
                        action = def.action;
                    }
                } else if (this.firedFor !== this.candidate && t - this.lastFire >= c.cooldownMs) {
                    this.firedFor = this.candidate;
                    this.lastFire = t;
                    action = def.action;
                }
            }
            return { action, via: action ? 'pose' : undefined, candidate: this.candidate, progress, moving };
        }
    }

    // ── Runtime ──────────────────────────────────────────────────────────────
    let recognizer = null;
    let recognizerPromise = null;
    let stream = null;
    let rafId = null;
    let running = false;
    let lastVideoTime = -1;
    let ui = null;
    const interpreter = new Interpreter();

    const toast = (msg, icon) => (typeof showToast === 'function' ? showToast(msg, icon) : console.log(msg));

    async function loadRecognizer() {
        if (recognizer) return recognizer;
        if (recognizerPromise) return recognizerPromise;
        recognizerPromise = (async () => {
            const { FilesetResolver, GestureRecognizer } = await import(MP_BUNDLE);
            const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
            const opts = (delegate) => ({
                baseOptions: { modelAssetPath: MODEL_URL, delegate },
                runningMode: 'VIDEO',
                numHands: 1,
                minHandDetectionConfidence: 0.6,
                minHandPresenceConfidence: 0.6,
                minTrackingConfidence: 0.5,
            });
            try {
                recognizer = await GestureRecognizer.createFromOptions(fileset, opts('GPU'));
            } catch (gpuErr) {
                console.warn('[gestures] GPU delegate failed, falling back to CPU', gpuErr);
                recognizer = await GestureRecognizer.createFromOptions(fileset, opts('CPU'));
            }
            return recognizer;
        })();
        try {
            return await recognizerPromise;
        } catch (e) {
            recognizerPromise = null; // allow retry later
            throw e;
        }
    }

    // Self-contained styles so this module doesn't depend on the app's CSS files.
    const STYLES = `
        .gesture-cam { position: fixed; right: 16px; bottom: calc(var(--player-height, 90px) + 24px); width: 220px; z-index: 900;
            background: rgba(18,18,18,.94); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; overflow: hidden;
            box-shadow: 0 10px 30px rgba(0,0,0,.5); display: none; transition: box-shadow .2s, border-color .2s;
            font-family: inherit; color: #fff; }
        .gesture-cam.visible { display: block; }
        .gesture-cam.firing { border-color: var(--primary, #FF1744); box-shadow: 0 0 24px rgba(255,23,68,.5); }
        .gesture-cam-view { position: relative; aspect-ratio: 4 / 3; background: #000; }
        .gesture-cam-view video, .gesture-cam-view canvas { position: absolute; inset: 0; width: 100%; height: 100%;
            object-fit: cover; transform: scaleX(-1); }
        .gesture-cam-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
            text-align: center; padding: 12px; font-size: 12px; color: #ddd; background: rgba(0,0,0,.6); }
        .gesture-cam-hud { padding: 8px 10px 10px; }
        .gesture-cam-label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 6px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .gesture-cam-meter { height: 4px; border-radius: 2px; background: rgba(255,255,255,.12); overflow: hidden; }
        .gesture-cam-meter-fill { height: 100%; width: 0; background: var(--primary, #FF1744); transition: width .06s linear; }
        .gesture-cam-help { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%;
            border: none; background: rgba(0,0,0,.55); color: #fff; font-weight: 700; font-size: 12px; cursor: pointer; }
        .gesture-cam-guide { padding: 0 10px 10px; font-size: 12px; color: #ccc; display: grid; gap: 4px; }
        .gesture-cam-guide[hidden] { display: none; }
        .gesture-cam-guide span { display: inline-block; width: 20px; }
        @media (max-width: 768px) {
            .gesture-cam { width: 140px; right: 8px; bottom: calc(var(--player-height, 90px) + 76px); }
            .gesture-cam-guide { font-size: 11px; }
        }`;

    function buildUI() {
        if (ui) return ui;
        if (!document.getElementById('palm-gesture-styles')) {
            const style = document.createElement('style');
            style.id = 'palm-gesture-styles';
            style.textContent = STYLES;
            document.head.appendChild(style);
        }
        const root = document.createElement('div');
        root.className = 'gesture-cam';
        root.innerHTML = `
            <div class="gesture-cam-view">
                <video playsinline muted></video>
                <canvas></canvas>
                <div class="gesture-cam-status">Starting camera…</div>
            </div>
            <div class="gesture-cam-hud">
                <span class="gesture-cam-label">—</span>
                <div class="gesture-cam-meter"><div class="gesture-cam-meter-fill"></div></div>
            </div>
            <button class="gesture-cam-help" type="button" aria-label="Show gesture guide">?</button>
            <div class="gesture-cam-guide" hidden>
                ${Object.values(GESTURE_MAP).map(g => `<div><span>${g.emoji}</span> ${g.label}</div>`).join('')}
                <div><span>👋</span> Swipe left/right: prev/next</div>
            </div>`;
        document.body.appendChild(root);
        const guide = root.querySelector('.gesture-cam-guide');
        root.querySelector('.gesture-cam-help').onclick = () => { guide.hidden = !guide.hidden; };
        ui = {
            root,
            video: root.querySelector('video'),
            canvas: root.querySelector('canvas'),
            status: root.querySelector('.gesture-cam-status'),
            label: root.querySelector('.gesture-cam-label'),
            meter: root.querySelector('.gesture-cam-meter-fill'),
        };
        ui.ctx = ui.canvas.getContext('2d');
        return ui;
    }

    function setStatus(text) {
        if (!ui) return;
        ui.status.textContent = text || '';
        ui.status.style.display = text ? 'flex' : 'none';
    }

    const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
                        [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

    function drawHand(landmarks) {
        const { canvas, ctx, video } = ui;
        if (canvas.width !== video.videoWidth) {
            canvas.width = video.videoWidth || 320;
            canvas.height = video.videoHeight || 240;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!landmarks) return;
        const W = canvas.width, H = canvas.height;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        for (const [a, b] of HAND_LINKS) {
            ctx.moveTo(landmarks[a].x * W, landmarks[a].y * H);
            ctx.lineTo(landmarks[b].x * W, landmarks[b].y * H);
        }
        ctx.stroke();
        ctx.fillStyle = '#FF1744';
        for (const p of landmarks) {
            ctx.beginPath();
            ctx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function perform(action) {
        const P = window.PalmPlayer;
        if (!P) { console.warn('[gestures] PalmPlayer bridge not ready'); return; }
        const needsTrack = action !== 'volUp' && action !== 'volDown';
        if (needsTrack && !P.hasTrack()) {
            toast('Pick a song first, then gestures can control it', 'fa-hand-paper');
            return;
        }
        switch (action) {
            case 'play':
                if (P.isPlaying()) return;           // idempotent: no double toggles
                P.play(); toast('Play ✋', 'fa-play'); break;
            case 'pause':
                if (!P.isPlaying()) return;
                P.pause(); toast('Pause ✊', 'fa-pause'); break;
            case 'next':    P.next();  toast('Next track', 'fa-step-forward'); break;
            case 'prev':    P.prev();  toast('Previous track', 'fa-step-backward'); break;
            case 'volUp':   toast(`Volume: ${P.changeVolume(+CONFIG.volumeStep)}%`, 'fa-volume-up'); break;
            case 'volDown': toast(`Volume: ${P.changeVolume(-CONFIG.volumeStep)}%`, 'fa-volume-down'); break;
            case 'like':    P.toggleLike(); break;
        }
    }

    function loop() {
        if (!running) return;
        rafId = requestAnimationFrame(loop);
        const video = ui.video;
        if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
        lastVideoTime = video.currentTime;

        const now = performance.now();
        let result;
        try {
            result = recognizer.recognizeForVideo(video, now);
        } catch (e) {
            console.error('[gestures] recognition error', e);
            return;
        }

        const landmarks = result.landmarks && result.landmarks[0];
        const top = result.gestures && result.gestures[0] && result.gestures[0][0];
        drawHand(landmarks);

        const out = interpreter.update({
            t: now,
            gesture: top ? top.categoryName : null,
            score: top ? top.score : 0,
            wrist: landmarks ? { x: landmarks[0].x, y: landmarks[0].y } : null,
        });

        const def = out.candidate && GESTURE_MAP[out.candidate];
        ui.label.textContent = landmarks
            ? (def ? `${def.emoji} ${def.label}` : (out.moving ? 'Moving…' : 'Hand detected'))
            : 'Show your hand';
        ui.meter.style.width = `${Math.round(out.progress * 100)}%`;
        ui.root.classList.toggle('firing', !!out.action);

        if (out.action) perform(out.action);
    }

    function describeCameraError(e) {
        switch (e && e.name) {
            case 'NotAllowedError':
            case 'SecurityError':    return 'Camera permission was blocked. Allow it in the address bar to use gestures.';
            case 'NotFoundError':
            case 'OverconstrainedError': return 'No camera found on this device.';
            case 'NotReadableError': return 'Camera is busy (another app or tab is using it).';
            default:                 return 'Could not start the camera.';
        }
    }

    async function openCamera() {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
            audio: false,
        });
        ui.video.srcObject = stream;
        await ui.video.play();
        // If the camera is unplugged / revoked mid-session, shut down cleanly.
        stream.getVideoTracks().forEach(tr => tr.addEventListener('ended', () => {
            if (running) { stop(); toast('Camera disconnected — gestures turned off', 'fa-video-slash'); window.dispatchEvent(new Event('palmgestures:stopped')); }
        }));
    }

    function closeCamera() {
        if (stream) stream.getTracks().forEach(tr => tr.stop());
        stream = null;
        if (ui) ui.video.srcObject = null;
    }

    // Release the camera while the tab is hidden; reacquire when visible.
    async function onVisibility() {
        if (!running) return;
        if (document.hidden) {
            cancelAnimationFrame(rafId);
            closeCamera();
            interpreter.reset();
            setStatus('Paused (tab hidden)');
        } else {
            try {
                setStatus('Resuming camera…');
                await openCamera();
                setStatus('');
                lastVideoTime = -1;
                loop();
            } catch (e) {
                stop();
                toast(describeCameraError(e), 'fa-video-slash');
                window.dispatchEvent(new Event('palmgestures:stopped'));
            }
        }
    }

    /** @returns {Promise<{ok:boolean, error?:string}>} */
    async function start() {
        if (running) return { ok: true };
        if (!window.isSecureContext) {
            return { ok: false, error: 'Gestures need HTTPS or localhost (camera is blocked on insecure pages).' };
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return { ok: false, error: 'This browser does not support camera access.' };
        }
        buildUI();
        ui.root.classList.add('visible');
        running = true;
        let phase = 'camera';
        // Start the model download in parallel with the camera prompt.
        const modelP = loadRecognizer();
        modelP.catch(() => {}); // handled below; avoid unhandled-rejection noise
        try {
            setStatus('Starting camera…');
            await openCamera();
            phase = 'model';
            if (!recognizer) setStatus('Loading hand model…');
            await modelP;
        } catch (e) {
            const msg = phase === 'camera' ? describeCameraError(e) : 'Could not load the gesture model (check your connection).';
            console.error('[gestures] start failed', e);
            stop();
            return { ok: false, error: msg };
        }
        if (!running) return { ok: false, error: 'cancelled' }; // toggled off while loading
        setStatus('');
        interpreter.reset();
        lastVideoTime = -1;
        document.addEventListener('visibilitychange', onVisibility);
        loop();
        return { ok: true };
    }

    function stop() {
        running = false;
        cancelAnimationFrame(rafId);
        document.removeEventListener('visibilitychange', onVisibility);
        closeCamera();
        interpreter.reset();
        if (ui) {
            ui.root.classList.remove('visible', 'firing');
            ui.ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
        }
    }

    window.PalmGestures = { start, stop, isRunning: () => running, Interpreter, CONFIG, GESTURE_MAP };
})();
