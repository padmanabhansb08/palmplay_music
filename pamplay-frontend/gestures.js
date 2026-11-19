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
//   🤙 Shaka (hold)            → Mute / unmute
//   3️⃣ Three fingers (hold)    → Open / close the queue
//   👋 Swipe hand left / right → Previous / next track
//   ⬆️⬇️ Swipe OPEN hand up / down → Open / close the full-screen player
//   👏 Clap (two hands)         → Play the last song that played (resume it, or start the
//                                 most recent one from history if nothing is loaded).
//                                 While two hands are visible, poses/swipes pause.
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
        minScore: 0.6,          // classifier confidence needed to START counting a pose…
        exitScore: 0.45,        // …but once held, it only drops below this (hysteresis: no boundary flicker)
        voteWindow: 5,          // a pose must win a strict majority of the last N frames (kills flicker)
        geometryScore: 0.65,    // confidence given to a pose decided by finger geometry alone (normal hold)
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
        swipeMinDy: 0.28,       // vertical swipe (full-screen player): travel needed, fraction of frame height
        swipeMaxDx: 0.15,       // …with little sideways drift; also needs an OPEN hand (see openHand)
        lostHandResetMs: 250,   // hand missing this long → reset everything (counts as "released");
                                // shorter gaps (dropped detection frames, motion blur) keep all state
        // 👏 Clap (two hands). Distances are in "hand sizes" (wrist → middle knuckle),
        // so they don't depend on how far you sit from the camera.
        clapApart: 2.2,         // hands must first be at least this far apart (seen in ≥2 frames)…
        clapTouch: 1.35,        // …then come within this distance (palms meeting)…
        clapVanish: 1.9,        // …or, if a hand vanishes on contact (overlap confuses the detector),
                                //    they must have been this close in the last frame they were both seen
        clapMaxApproachMs: 450, // from the last "apart" frame to contact
        clapMinSpeed: 5,        // hand-sizes per second closing speed: a deliberate clap, not hands slowly meeting
        clapMaxAsymmetry: 0.35, // in a clap BOTH hands move, so the midpoint between them barely shifts
                                //    (0.5 = one hand stationary, e.g. a second hand sliding in beside a still one)
        clapWindowMs: 700,      // history kept for the check
        clapCooldownMs: 1500,   // one clap = one action
    };

    // ── Finger geometry (rule-based, from MediaPipe's 21 hand landmarks) ──────
    // The built-in classifier is a best-guess over 7 fixed poses and confuses
    // look-alikes (✌️/☝️, 👍/✊). Finger extension measured directly from the
    // landmarks is deterministic, so we use it to confirm or correct the
    // classifier. All distances are divided by the hand's own size (wrist →
    // middle knuckle), so it works near/far from the camera, and it compares
    // distances rather than raw y, so a tilted/sideways hand still works.
    const LM = { WRIST: 0, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8,
        MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_TIP: 12, RING_PIP: 14, RING_TIP: 16, PINKY_MCP: 17, PINKY_PIP: 18, PINKY_TIP: 20 };

    const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    // Extension margin = (tip→wrist − pip→wrist) / hand size. Measured on a
    // proportional hand model: straight ≈ +0.35…+0.50, fully curled ≈ −0.27…−0.43,
    // relaxed half-curl ≈ 0.00. Two readings:
    //   lenient (> 0.10)      – used to CONFIRM what the classifier saw;
    //   strict (> 0.22 / < −0.12, else "unsure") – required before geometry may
    //     OVERRIDE the classifier, so a relaxed hand never becomes a command.
    const EXT_LENIENT = 0.10, EXT_STRICT = 0.22, CURL_STRICT = -0.12;
    const THUMB_LENIENT = 0.05, THUMB_STRICT = 0.12, THUMB_IN_STRICT = -0.05;

    /**
     * @returns {{fingers:boolean[], strict:(boolean|null)[], thumbDir:'up'|'down'|'side'}}
     *   fingers/strict = [thumb, index, middle, ring, pinky]; strict uses null for "unsure".
     */
    function analyzeHand(lm) {
        const scale = Math.max(1e-6, dist2d(lm[LM.WRIST], lm[LM.MIDDLE_MCP]));
        const w = lm[LM.WRIST];
        const margin = (tip, pip) => (dist2d(lm[tip], w) - dist2d(lm[pip], w)) / scale;
        const m = [margin(LM.INDEX_TIP, LM.INDEX_PIP), margin(LM.MIDDLE_TIP, LM.MIDDLE_PIP),
            margin(LM.RING_TIP, LM.RING_PIP), margin(LM.PINKY_TIP, LM.PINKY_PIP)];
        // Thumb: extended if its tip is clearly further from the pinky knuckle than its IP joint (splayed out).
        const tm = (dist2d(lm[LM.THUMB_TIP], lm[LM.PINKY_MCP]) - dist2d(lm[LM.THUMB_IP], lm[LM.PINKY_MCP])) / scale;

        // Thumb direction from the thumb's own angle (scale-free): within ~57° of
        // vertical counts as up/down. Image y grows downward.
        const vx = lm[LM.THUMB_TIP].x - lm[LM.THUMB_MCP].x, vy = lm[LM.THUMB_TIP].y - lm[LM.THUMB_MCP].y;
        const vlen = Math.hypot(vx, vy) || 1e-6;
        const up = -vy / vlen;
        const thumbDir = up > 0.55 ? 'up' : up < -0.55 ? 'down' : 'side';

        return {
            fingers: [tm > THUMB_LENIENT, ...m.map((v) => v > EXT_LENIENT)],
            strict: [tm > THUMB_STRICT ? true : tm < THUMB_IN_STRICT ? false : null,
                ...m.map((v) => (v > EXT_STRICT ? true : v < CURL_STRICT ? false : null))],
            thumbDir,
            margins: { thumb: tm, fingers: m },
        };
    }

    // Finger patterns per pose: [thumb, index, middle, ring, pinky]; null = don't care.
    const POSE_RULES = {
        ILoveYou:    { p: [true, true, false, false, true] },
        Shaka:         { p: [true, false, false, false, true] },   // 🤙 thumb + pinky out
        Three_Fingers: { p: [null, true, true, true, false] },     // index+middle+ring up, pinky curled
        Victory:     { p: [null, true, true, false, false] },
        Pointing_Up: { p: [null, true, false, false, false] },
        Thumb_Up:    { p: [true, false, false, false, false], thumb: 'up' },
        Thumb_Down:  { p: [true, false, false, false, false], thumb: 'down' },
        Open_Palm:   { p: [null, true, true, true, true] },
        // A fist's thumb is tucked. A thumb sticking out (up, down OR sideways)
        // is a deliberate thumb gesture, not "pause".
        Closed_Fist: { p: [false, false, false, false, false] },
    };

    /** strict=true: every required finger must be clearly (not "unsure") in place. */
    function poseFits(label, g, strict = false) {
        const r = POSE_RULES[label];
        if (!r) return false;
        const f = strict ? g.strict : g.fingers;
        for (let i = 0; i < 5; i++) if (r.p[i] !== null && r.p[i] !== f[i]) return false;
        if (r.thumb && g.thumbDir !== r.thumb) return false;
        return true;
    }

    /** Flat/open hand: at least 3 of the 4 fingers extended (thumb ignored). True if landmarks are unavailable. */
    function openHand(lm) {
        if (!lm || lm.length < 21) return true;
        return analyzeHand(lm).fingers.slice(1).filter(Boolean).length >= 3;
    }

    /** First pose whose finger pattern CLEARLY fits (strict), or null. */
    function geometryPose(g) {
        for (const label of Object.keys(POSE_RULES)) if (poseFits(label, g, true)) return label;
        return null;
    }

    const GESTURE_MAP = {
        Open_Palm:   { action: 'play',    label: 'Play',        icon: 'fa-play',          emoji: '✋' },
        Closed_Fist: { action: 'pause',   label: 'Pause',       icon: 'fa-pause',         emoji: '✊' },
        Victory:     { action: 'next',    label: 'Next track',  icon: 'fa-step-forward',  emoji: '✌️' },
        Pointing_Up: { action: 'prev',    label: 'Previous',    icon: 'fa-step-backward', emoji: '☝️' },
        Thumb_Up:    { action: 'volUp',   label: 'Volume up',   icon: 'fa-volume-up',     emoji: '👍', repeat: true },
        Thumb_Down:  { action: 'volDown', label: 'Volume down', icon: 'fa-volume-down',   emoji: '👎', repeat: true },
        ILoveYou:    { action: 'like',    label: 'Like',        icon: 'fa-heart',         emoji: '🤟' },
        // Geometry-only poses: MediaPipe's classifier has no label for these, so
        // they come purely from finger positions (see POSE_RULES).
        Shaka:         { action: 'mute',  label: 'Mute / unmute', icon: 'fa-volume-mute', emoji: '🤙' },
        Three_Fingers: { action: 'queue', label: 'Queue',         icon: 'fa-list',        emoji: '3️⃣' },
    };

    /**
     * Geometry of a pair of hands: `d` = distance between palm centres in units of the
     * average hand size; `mx,my` = midpoint between them; `hs` = average hand size.
     * `aspect` = frame width/height, so horizontal and vertical distances are comparable.
     */
    function handPair(a, b, aspect = 4 / 3) {
        const size = (lm) => Math.hypot((lm[LM.WRIST].x - lm[LM.MIDDLE_MCP].x) * aspect, lm[LM.WRIST].y - lm[LM.MIDDLE_MCP].y);
        const centre = (lm) => ({
            x: ((lm[LM.WRIST].x + lm[LM.INDEX_MCP].x + lm[LM.MIDDLE_MCP].x + lm[LM.PINKY_MCP].x) / 4) * aspect,
            y: (lm[LM.WRIST].y + lm[LM.INDEX_MCP].y + lm[LM.MIDDLE_MCP].y + lm[LM.PINKY_MCP].y) / 4,
        });
        const ca = centre(a), cb = centre(b);
        const hs = Math.max(1e-6, (size(a) + size(b)) / 2);
        return { d: Math.hypot(ca.x - cb.x, ca.y - cb.y) / hs, mx: (ca.x + cb.x) / 2, my: (ca.y + cb.y) / 2, hs };
    }
    const handDistance = (a, b, aspect) => handPair(a, b, aspect).d;

    // ── Pure state machine: frames in, actions out. No DOM, easy to test. ──────
    class Interpreter {
        constructor(cfg = CONFIG, map = GESTURE_MAP) {
            this.cfg = cfg;
            this.map = map;
            this.lastFire = -Infinity;   // last discrete pose action
            this.lastSwipe = -Infinity;  // swipes have their own cooldown
            this.lastClap = -Infinity;
            this.reset();
        }

        reset() {
            this.candidate = null;      // label currently being "held"
            this.since = 0;             // when the current hold started
            this.votes = [];            // last N per-frame labels (null = no pose) for majority vote
            this.firedFor = null;       // discrete label already fired for this hold
            this.lastRepeat = -Infinity;
            this.track = [];            // recent wrist positions [{x,y,t}]
            this.lastSeen = -Infinity;
            this.conf = null;           // smoothed confidence of the current candidate
            this.stillSince = null;     // when the hand last became still
            this.anchor = null;         // rested position a swipe is measured from
            this.twoHist = [];          // recent two-hand distances [{t, d}] for clap detection
        }

        /**
         * Decide this frame's pose from the classifier + finger geometry.
         *  - classifier label that the finger geometry agrees with → accept it;
         *  - otherwise, if the geometry clearly matches a pose → use that
         *    (fixes ✌️/☝️ and 👍/✊ mix-ups, and catches poses the classifier
         *    scored too low);
         *  - otherwise → no pose.
         * Hysteresis: a pose already being held needs only exitScore to stay.
         */
        frameLabel(f) {
            const c = this.cfg;
            let cls = (f.gesture && f.gesture !== 'None' && this.map[f.gesture]) ? f.gesture : null;
            const need = cls && cls === this.candidate ? c.exitScore : c.minScore;
            if (cls && (f.score ?? 0) < need) cls = null;

            if (!f.landmarks || f.landmarks.length < 21) {
                return { label: cls, score: cls ? f.score : 0 };          // no landmarks: classifier only
            }
            const g = analyzeHand(f.landmarks);
            if (cls && poseFits(cls, g)) return { label: cls, score: f.score, geometry: g };
            const geo = geometryPose(g);
            if (geo && this.map[geo]) return { label: geo, score: c.geometryScore, geometry: g, viaGeometry: true };
            return { label: null, score: 0, geometry: g };
        }

        /**
         * 👏 Clap detector. `d` = current distance between the two hands (in hand
         * sizes), or null when fewer than two hands are visible this frame.
         * A clap = hands clearly apart (≥ clapApart, in ≥2 frames) → quickly (≤ clapMaxApproachMs,
         * ≥ clapMinSpeed hand-sizes/s) to contact (≤ clapTouch), where "contact" may also be
         * one hand vanishing right after they were within clapVanish.
         */
        clapCheck(t, pair) {
            const c = this.cfg;
            if (pair) this.twoHist.push({ t, ...pair });
            while (this.twoHist.length && t - this.twoHist[0].t > c.clapWindowMs) this.twoHist.shift();
            const h = this.twoHist;
            if (t - this.lastClap < c.clapCooldownMs || h.length < 3) return false;

            const now = h[h.length - 1];                 // current frame, or the last one both hands were seen
            if (pair) {
                if (now.d > c.clapTouch) return false;
            } else if (t - now.t > 160 || now.d > c.clapVanish) {
                return false;
            }
            // Most recent frame where the hands were still clearly apart.
            let apartIdx = -1, apartCount = 0;
            for (let i = 0; i < h.length; i++) if (h[i].d >= c.clapApart) { apartIdx = i; apartCount++; }
            if (apartIdx < 0 || apartCount < 2) return false;
            const a = h[apartIdx];
            const dtMs = now.t - a.t;
            if (dtMs <= 0 || dtMs > c.clapMaxApproachMs) return false;
            const closing = a.d - now.d;                 // hand sizes
            if (closing / (dtMs / 1000) < c.clapMinSpeed) return false;
            // Both hands must move: the midpoint between them should stay roughly put.
            const midShift = Math.hypot(now.mx - a.mx, now.my - a.my) / ((a.hs + now.hs) / 2);
            if (midShift > c.clapMaxAsymmetry * closing) return false;

            this.lastClap = t;
            this.twoHist = [];
            return true;
        }

        /**
         * @param {{t:number, gesture?:string|null, score?:number, wrist?:{x:number,y:number}|null,
         *          landmarks?:{x:number,y:number}[], others?:{x:number,y:number}[][], aspect?:number}} f
         *        wrist/landmarks are in raw (un-mirrored) camera coordinates, 0..1.
         *        `others` = landmarks of any additional hands (used for clap detection).
         * @returns {{action:string|null, via?:string, candidate:string|null, progress:number, moving:boolean}}
         */
        update(f) {
            const c = this.cfg;
            const t = f.t;

            // 👏 Two hands (or one just vanished on contact): is this a clap?
            const twoHands = !!(f.landmarks && f.others && f.others.length);
            const pair = twoHands ? handPair(f.landmarks, f.others[0], f.aspect || 4 / 3) : null;
            if (this.clapCheck(t, pair)) {
                this.lastFire = t;           // swallow any pose/swipe that would fire right after
                this.lastSwipe = t;
                this.track = []; this.anchor = null; this.stillSince = null;
                this.candidate = null; this.firedFor = null; this.votes = [];
                return { action: 'playLast', via: 'clap', candidate: null, progress: 0, moving: true, twoHands };
            }

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

            // With two hands in view the "primary" hand can swap between frames, which
            // would look like a swipe — so swipes (and poses, below) pause until one hand leaves.
            if (!twoHands && this.anchor && t - this.lastSwipe >= c.cooldownMs) {
                // Camera image is un-mirrored: when the user moves their hand to
                // THEIR right, x DEcreases. Flip so +dx = user's right.
                const dx = -(f.wrist.x - this.anchor.x);
                const dy = f.wrist.y - this.anchor.y;
                // Horizontal flick = next/previous. Vertical flick of an OPEN hand =
                // open/close the full-screen player (a fist or pointing hand moving
                // up/down is just someone moving their arm, so it's ignored).
                let swipeAction = null;
                if (Math.abs(dx) >= c.swipeMinDx && Math.abs(dy) <= c.swipeMaxDy) {
                    swipeAction = dx > 0 ? 'next' : 'prev';
                } else if (Math.abs(dy) >= c.swipeMinDy && Math.abs(dx) <= c.swipeMaxDx && openHand(f.landmarks)) {
                    swipeAction = dy < 0 ? 'openPlayer' : 'closePlayer';   // image y grows downward
                }
                if (swipeAction) {
                    this.lastSwipe = t;
                    this.lastFire = t;  // also block a pose action right after a swipe
                    this.track = [];
                    this.anchor = null;
                    this.stillSince = null;
                    this.candidate = null;
                    this.firedFor = null;
                    return { action: swipeAction, via: 'swipe', candidate: null, progress: 0, moving: true };
                }
            }

            // --- pose: per-frame label → majority vote → hold ----------------
            const fl = this.frameLabel(f);
            const label = fl.label;
            this.votes.push(label);
            if (this.votes.length > c.voteWindow) this.votes.shift();

            // Strict majority of the recent frames wins; no majority → no pose.
            const counts = new Map();
            for (const v of this.votes) counts.set(v, (counts.get(v) || 0) + 1);
            let winner = null;
            for (const [v, n] of counts) if (n * 2 > this.votes.length) winner = v;

            if (winner !== this.candidate) {
                this.candidate = winner;
                this.since = t;
                this.conf = null;
                if (winner !== this.firedFor) this.firedFor = null;
            }

            if (!this.candidate) return { action: null, candidate: null, progress: 0, moving };

            // A moving hand is probably mid-swipe / repositioning, not a deliberate pose.
            if (moving || twoHands) this.since = t;

            // Smoothed confidence → confident poses fire sooner.
            const s = label === this.candidate ? (fl.score ?? 0) : 0;
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
            return { action, via: action ? 'pose' : undefined, candidate: this.candidate, progress, moving, twoHands };
        }
    }

    // ── Runtime ──────────────────────────────────────────────────────────────
    let recognizer = null;
    let recognizerPromise = null;
    let stream = null;
    let rafId = null;
    let running = false;
    let lastVideoTime = -1;
    let lastPrimary = null;     // wrist position of the hand that drives poses/swipes
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
                numHands: 2,            // second hand is only used for the 👏 clap
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
        .gesture-cam { position: fixed; right: 16px; bottom: calc(var(--player-height, 90px) + 24px); width: 220px; z-index: 2100; /* above the full-screen player (2000) and queue (1500) */
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
                <div><span>⬆️</span> Swipe open hand up: full player</div>
                <div><span>⬇️</span> Swipe open hand down: close</div>
                <div><span>👏</span> Clap (two hands): play last song</div>
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

    /** Draw every detected hand; the one driving poses/swipes is red, the other blue. */
    function drawHands(hands, primaryIdx) {
        const { canvas, ctx, video } = ui;
        if (canvas.width !== video.videoWidth) {
            canvas.width = video.videoWidth || 320;
            canvas.height = video.videoHeight || 240;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const W = canvas.width, H = canvas.height;
        hands.forEach((landmarks, idx) => {
            if (!landmarks) return;
            const primary = idx === primaryIdx;
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.beginPath();
            for (const [a, b] of HAND_LINKS) {
                ctx.moveTo(landmarks[a].x * W, landmarks[a].y * H);
                ctx.lineTo(landmarks[b].x * W, landmarks[b].y * H);
            }
            ctx.stroke();
            ctx.fillStyle = primary ? '#FF1744' : '#3DA5FF';
            for (const p of landmarks) {
                ctx.beginPath();
                ctx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        });
    }

    function perform(action) {
        const P = window.PalmPlayer;
        if (!P) { console.warn('[gestures] PalmPlayer bridge not ready'); return; }
        const needsTrack = ['play', 'pause', 'next', 'prev', 'like', 'openPlayer'].includes(action);
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
            case 'mute':    P.toggleMute(); break;               // the app shows its own Muted/Unmuted toast
            case 'queue':   P.toggleQueue(); break;
            case 'openPlayer': P.openNowPlaying(); break;
            case 'closePlayer': if (!P.dismissOverlay()) toast('Nothing to close', 'fa-chevron-down'); break;
            case 'playLast': {                                   // 👏 clap
                const r = P.playLast();
                if (r === 'already') toast('Already playing ♫', 'fa-music');
                else if (r === 'none') toast('No recent song yet — play one first', 'fa-clock');
                else toast('👏 Playing your last song', 'fa-play');
                break;
            }
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

        const out = handleResult(result, now);
        if (out.action) perform(out.action);
    }

    /** One frame of recognizer output → draw, interpret, update HUD. Returns the interpreter's output. */
    function handleResult(result, now) {
        const video = ui.video;
        // Up to two hands. MediaPipe's hand order isn't stable between frames, so the
        // "primary" hand (poses/swipes) is the one nearest where the last one was.
        const hands = result.landmarks || [];
        const gests = result.gestures || [];
        let pi = 0;
        if (hands.length > 1 && lastPrimary) {
            let best = Infinity;
            hands.forEach((lm, i) => {
                const dd = Math.hypot(lm[0].x - lastPrimary.x, lm[0].y - lastPrimary.y);
                if (dd < best) { best = dd; pi = i; }
            });
        }
        const landmarks = hands[pi] || null;
        const others = hands.filter((_, i) => i !== pi);
        const top = gests[pi] && gests[pi][0];
        lastPrimary = landmarks ? { x: landmarks[0].x, y: landmarks[0].y } : null;
        drawHands(hands, pi);

        const out = interpreter.update({
            t: now,
            gesture: top ? top.categoryName : null,
            score: top ? top.score : 0,
            wrist: landmarks ? { x: landmarks[0].x, y: landmarks[0].y } : null,
            landmarks: landmarks || null,
            others,
            aspect: (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 4 / 3,
        });

        const def = out.candidate && GESTURE_MAP[out.candidate];
        ui.label.textContent = out.via === 'clap' ? '👏 Clap!'
            : others.length ? '🙌 Two hands — clap to play'
            : landmarks
                ? (def ? `${def.emoji} ${def.label}` : (out.moving ? 'Moving…' : 'Hand detected'))
                : 'Show your hand';
        ui.meter.style.width = `${Math.round(out.progress * 100)}%`;
        ui.root.classList.toggle('firing', !!out.action);
        return out;
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

    window.PalmGestures = { start, stop, isRunning: () => running, Interpreter, CONFIG, GESTURE_MAP,
        analyzeHand, geometryPose, poseFits, handDistance, handPair,
        _handleResult: handleResult, _perform: perform, _interpreter: interpreter };   // test hooks
})();
