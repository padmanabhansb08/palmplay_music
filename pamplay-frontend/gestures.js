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
        // ── Robustness against real-world messiness ──
        noneScore: 0.6,         // classifier says "None" at ≥ this confidence → geometry may not invent a classifier-known pose
        geometryOnlyHoldMs: 450,// 🤙 / 3️⃣ come from finger geometry alone (no classifier label to back them), so they need a
                                //    longer, deliberate hold — a relaxed hand can drift through those shapes for an instant
        secondHandMinScore: 0.8,// a 2nd detected hand only counts if MediaPipe is this sure it's a hand…
        secondHandFrames: 3,    // …and it has been seen in this many of the last 5 frames (phantom detections flicker)
        duplicateHandDist: 0.7, // …and isn't a duplicate detection of the first hand (palm centres closer than this, in hand sizes)
        swipeConfirmMs: 70,     // a swipe fires only if the hand is still in frame this long after the flick…
        swipeEdgeMargin: 0.13,  // …and isn't at the frame edge: pulling a hand out of view is not a swipe
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

    // Two independent readings of how straight each finger is:
    //  • 2D margin  = (tip→wrist − pip→wrist) / hand size.        Fast, but blurs when the hand is turned.
    //  • 3D straightness = |tip−knuckle| / (sum of the 3 bone lengths), using MediaPipe's depth (z).
    //    1.0 = perfectly straight; it does NOT change when the hand is rotated, so it is robust to angle.
    // Measured on realistic hands (neat / sloppy-open / half-curled / sloppy-curled / tight):
    //   2D margin       0.41 / 0.23 / −0.02 / −0.27 / −0.39   (sloppy-open fingers straddled the old 0.22 cutoff)
    //   3D straightness 0.99 / 0.95 /  0.87 /  0.74 /  0.57   (rotation-independent)
    // "Lenient" = used to CONFIRM what the classifier saw; "strict" = clearly resolved (else null/"unsure"),
    // required before geometry may OVERRIDE the classifier or stand in for it.
    const EXT_LENIENT = 0.10, EXT_STRICT = 0.18, CURL_STRICT = -0.10;          // 2D margin
    const S_EXT_LENIENT = 0.86, S_EXT_STRICT = 0.92, S_CURL_STRICT = 0.80;      // 3D straightness
    const THUMB_LENIENT = 0.05, THUMB_STRICT = 0.10, THUMB_IN_STRICT = -0.03;

    const dist3d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
    /** 3D straightness of finger k (0=index … 3=pinky), or null when depth isn't available. */
    function straightness(lm, k) {
        if (typeof lm[LM.INDEX_TIP].z !== 'number') return null;
        const b = 5 + 4 * k;
        const len = dist3d(lm[b], lm[b + 1]) + dist3d(lm[b + 1], lm[b + 2]) + dist3d(lm[b + 2], lm[b + 3]);
        return len > 1e-6 ? dist3d(lm[b + 3], lm[b]) / len : null;
    }

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
        const st = [0, 1, 2, 3].map((k) => straightness(lm, k));
        // Either clear signal counts; if the two clearly disagree the finger is "unsure".
        const lenientExt = (i) => m[i] > EXT_LENIENT || (st[i] !== null && st[i] > S_EXT_LENIENT);
        const strictState = (i) => {
            const ext = m[i] > EXT_STRICT || (st[i] !== null && st[i] > S_EXT_STRICT);
            const curl = m[i] < CURL_STRICT || (st[i] !== null && st[i] < S_CURL_STRICT);
            return ext && curl ? null : ext ? true : curl ? false : null;
        };
        // Thumb: extended if its tip is clearly further from the pinky knuckle than its IP joint (splayed out).
        const tm = (dist2d(lm[LM.THUMB_TIP], lm[LM.PINKY_MCP]) - dist2d(lm[LM.THUMB_IP], lm[LM.PINKY_MCP])) / scale;

        // Thumb direction from the thumb's own angle (scale-free): within ~57° of
        // vertical counts as up/down. Image y grows downward.
        const vx = lm[LM.THUMB_TIP].x - lm[LM.THUMB_MCP].x, vy = lm[LM.THUMB_TIP].y - lm[LM.THUMB_MCP].y;
        const vlen = Math.hypot(vx, vy) || 1e-6;
        const up = -vy / vlen;
        const thumbDir = up > 0.55 ? 'up' : up < -0.55 ? 'down' : 'side';

        return {
            fingers: [tm > THUMB_LENIENT, ...[0, 1, 2, 3].map(lenientExt)],
            strict: [tm > THUMB_STRICT ? true : tm < THUMB_IN_STRICT ? false : null,
                ...[0, 1, 2, 3].map(strictState)],
            thumbDir,
            margins: { thumb: tm, fingers: m, straight: st },
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
        Shaka:         { action: 'mute',  label: 'Mute / unmute', icon: 'fa-volume-mute', emoji: '🤙', geometryOnly: true },
        Three_Fingers: { action: 'queue', label: 'Queue',         icon: 'fa-list',        emoji: '3️⃣', geometryOnly: true },
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
    const handSize = (lm, aspect = 4 / 3) => Math.hypot((lm[LM.WRIST].x - lm[LM.MIDDLE_MCP].x) * aspect, lm[LM.WRIST].y - lm[LM.MIDDLE_MCP].y);

    /**
     * Which detected hand drives poses/swipes, and which other detections count as a real
     * second hand (for the 👏 clap)? Phantom detections used to count as "two hands" and switched
     * every single-hand gesture off; now a 2nd hand must be confident, plausibly sized and not a
     * duplicate detection of the first one.
     * @param {{lm:object[], gesture:?{categoryName:string,score:number}, hscore:number}[]} hands
     * @param {?{x:number,y:number}} lastPrimary  wrist of the hand used last frame
     */
    function selectHands(hands, lastPrimary, aspect = 4 / 3, cfg = CONFIG) {
        if (!hands.length) return { pi: -1, primary: null, others: [] };
        let pi = 0;
        if (hands.length > 1) {
            if (lastPrimary) {            // stay with the hand nearest where the last one was
                let best = Infinity;
                hands.forEach((h, i) => {
                    const dd = Math.hypot(h.lm[0].x - lastPrimary.x, h.lm[0].y - lastPrimary.y);
                    if (dd < best) { best = dd; pi = i; }
                });
            } else {                       // first sight: the hand MediaPipe is surest about
                let best = -1;
                hands.forEach((h, i) => { if (h.hscore > best) { best = h.hscore; pi = i; } });
            }
        }
        const primary = hands[pi];
        const mainSize = Math.max(1e-6, handSize(primary.lm, aspect));
        const others = [];
        hands.forEach((h, i) => {
            if (i === pi) return;
            if (h.hscore < cfg.secondHandMinScore) return;                               // not sure it's a hand
            const ratio = handSize(h.lm, aspect) / mainSize;
            if (ratio < 0.4 || ratio > 2.5) return;                                      // implausible size
            if (handPair(primary.lm, h.lm, aspect).d < cfg.duplicateHandDist) return;   // same hand twice
            others.push(h.lm);
        });
        return { pi, primary, others };
    }

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
            this.secondHist = [];       // was a (filtered) second hand present? last 5 frames — phantom detections flicker
            this.pendingSwipe = null;   // a flick waiting to confirm the hand stayed in frame
            this.lastInfo = null;       // what the engine saw on the last frame (HUD / debug log)
        }

        /**
         * Decide this frame's pose from the classifier + finger geometry.
         *  1. classifier label the finger geometry agrees with           → accept it;
         *  2. geometry CLEARLY shows a different pose (e.g. ✌️ vs ☝️)    → trust geometry (fixes look-alikes);
         *  3. classifier label the fingers don't back up                 → ignore it;
         *  4. no classifier label, geometry clearly shows a pose         → use geometry (🤙 and 3️⃣ have no label);
         *  5. otherwise                                                  → no pose.
         * Hysteresis: a pose already being held needs only exitScore to stay.
         * What recovered the accuracy on real (non-textbook) hands is how the FINGERS are judged
         * (3D straightness + calibrated thresholds, see analyzeHand), not how much the classifier is trusted.
         */
        frameLabel(f) {
            const c = this.cfg;
            let cls = (f.gesture && f.gesture !== 'None' && this.map[f.gesture]) ? f.gesture : null;
            const held = cls && cls === this.candidate;
            const need = held ? c.exitScore : c.minScore;
            if (cls && (f.score ?? 0) < need) cls = null;

            if (!f.landmarks || f.landmarks.length < 21) {
                return { label: cls, score: cls ? f.score : 0, why: 'classifier only' };
            }
            const g = analyzeHand(f.landmarks);
            const geo = geometryPose(g);                         // clearly-resolved pose, or null
            if (cls) {
                if (poseFits(cls, g)) return { label: cls, score: f.score, geometry: g, why: 'classifier + geometry agree' };
                if (geo && geo !== cls && this.map[geo]) {
                    return { label: geo, score: Math.max(c.geometryScore, 0.7), geometry: g, viaGeometry: true, why: `geometry corrected ${cls}` };
                }
                // The classifier's label isn't backed by the fingers: ignore it. (Measured: trusting such labels
                // added no recall once the geometry was improved, but tripled false actions on a resting hand.)
                return { label: null, score: 0, geometry: g, why: `${cls} ignored: fingers don't match it` };
            }
            if (geo && this.map[geo]) {
                // The classifier explicitly says "no gesture" (not just "unsure"): respect that for the poses it
                // knows. Without this, a relaxed hand drifting through a fist/point shape fired actions.
                // (🤙 and 3️⃣ have no classifier label, so geometry alone must be allowed to decide those.)
                if (f.gesture === 'None' && (f.score ?? 0) >= c.noneScore && !this.map[geo].geometryOnly) {
                    return { label: null, score: 0, geometry: g, why: `model says no gesture (${Math.round((f.score ?? 0) * 100)}%)` };
                }
                return { label: geo, score: c.geometryScore, geometry: g, viaGeometry: true, why: 'geometry only' };
            }
            return { label: null, score: 0, geometry: g, why: 'no clear pose' };
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
            const rawTwo = !!(f.landmarks && f.others && f.others.length);
            const pair = rawTwo ? handPair(f.landmarks, f.others[0], f.aspect || 4 / 3) : null;
            // "Two-hand mode" needs a STABLE second hand: a phantom detection flickers in and out,
            // and used to switch every single-hand gesture off whenever it appeared.
            this.secondHist.push(rawTwo);
            if (this.secondHist.length > 5) this.secondHist.shift();
            const twoHands = this.secondHist.filter(Boolean).length >= c.secondHandFrames;
            if (this.clapCheck(t, pair)) {
                this.lastFire = t;           // swallow any pose/swipe that would fire right after
                this.lastSwipe = t;
                this.track = []; this.anchor = null; this.stillSince = null;
                this.candidate = null; this.firedFor = null; this.votes = [];
                return { action: 'playLast', via: 'clap', candidate: null, progress: 0, moving: true, twoHands };
            }

            if (!f.wrist) {
                this.pendingSwipe = null;       // the hand left the frame: that was a withdrawal, not a swipe
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
            // would look like a swipe — so swipes pause until one hand leaves.
            // A hand being PULLED OUT of view (sideways or down) looks exactly like a fast swipe
            // while it is happening, so a swipe must (a) never be at the frame edge and (b) still
            // be in frame `swipeConfirmMs` after the flick. (Measured before this guard: moving a
            // hand out sideways after a gesture changed track 100% of the time.)
            const em = c.swipeEdgeMargin;
            const atEdge = f.wrist.x < em || f.wrist.x > 1 - em || f.wrist.y < em || f.wrist.y > 1 - em;
            if (twoHands) this.pendingSwipe = null;
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
                if (swipeAction && atEdge) {            // already leaving the frame → not a swipe
                    this.pendingSwipe = null;
                    this.anchor = null;
                } else if (swipeAction && (!this.pendingSwipe || this.pendingSwipe.action !== swipeAction)) {
                    this.pendingSwipe = { action: swipeAction, t };
                }
            }
            if (this.pendingSwipe) {
                const ps = this.pendingSwipe;
                if (atEdge) {
                    this.pendingSwipe = null;
                    this.anchor = null;
                } else if (t - ps.t >= c.swipeConfirmMs) {
                    this.pendingSwipe = null;
                    this.lastSwipe = t;
                    this.lastFire = t;  // also block a pose action right after a swipe
                    this.track = [];
                    this.anchor = null;
                    this.stillSince = null;
                    this.candidate = null;
                    this.firedFor = null;
                    return { action: ps.action, via: 'swipe', candidate: null, progress: 0, moving: true };
                }
            }

            // --- pose: per-frame label → majority vote → hold ----------------
            const fl = this.frameLabel(f);
            const label = fl.label;
            this.lastInfo = {
                model: f.gesture || 'None', modelScore: f.score ?? 0, pose: label, why: fl.why,
                fingers: fl.geometry ? fl.geometry.fingers.map((b) => (b ? 1 : 0)).join('') : null,
                strict: fl.geometry ? fl.geometry.strict.map((b) => (b === null ? '?' : b ? 1 : 0)).join('') : null,
                moving, twoHands,
            };
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
            // With two hands up, only the open palm is held back (it's what a clap starts from);
            // every other pose from the main hand still works.
            if (moving || (twoHands && this.candidate === 'Open_Palm')) this.since = t;

            // Smoothed confidence → confident poses fire sooner.
            const s = label === this.candidate ? (fl.score ?? 0) : 0;
            this.conf = this.conf == null ? s : this.conf * 0.6 + s * 0.4;
            const def = this.map[this.candidate];
            let need = this.conf >= c.fastScore ? c.fastHoldMs : c.holdMs;
            if (def.geometryOnly) need = Math.max(need, c.geometryOnlyHoldMs);

            const held = t - this.since;
            const progress = Math.min(1, held / need);
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

    // ── Model loading ────────────────────────────────────────────────────────
    // The engine + model are ~17 MB. They used to be fetched inside ONE opaque
    // createFromOptions() call: no progress, no timeout, no way to cancel — on a slow
    // network the preview just said "Loading…" forever. Now we download the pieces
    // ourselves, with a % readout, a stall detector + retry + mirror host, a one-time
    // cache in the browser (Cache Storage), and a timeout at every stage.
    const MP_WASM_ALT = `https://unpkg.com/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
    const MP_BUNDLE_ALT = `https://unpkg.com/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
    const ASSET_CACHE = 'palmplay-mediapipe-v1';
    const STALL_MS = 15000;        // no bytes for this long = stalled → retry / mirror
    const GPU_INIT_MS = 15000;     // GPU init that takes longer is treated as a hang → use CPU
    const CPU_INIT_MS = 40000;
    const TOTAL_LOAD_MS = 150000;  // give up with a clear message instead of "loading…" forever

    // Browsers without WebAssembly SIMD (some older TVs) need the "nosimd" build.
    const SIMD_OK = (() => {
        try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); }
        catch (e) { return false; }
    })();
    const WASM_NAME = SIMD_OK ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
    const ASSETS = {
        loader: { urls: [`${MP_WASM}/${WASM_NAME}.js`, `${MP_WASM_ALT}/${WASM_NAME}.js`], bytes: SIMD_OK ? 209826 : 209735, type: 'text/javascript' },
        wasm:   { urls: [`${MP_WASM}/${WASM_NAME}.wasm`, `${MP_WASM_ALT}/${WASM_NAME}.wasm`], bytes: SIMD_OK ? 9423986 : 9294247, type: 'application/wasm' },
        model:  { urls: [MODEL_URL], bytes: 8373440, type: 'application/octet-stream' },
    };
    const TOTAL_BYTES = ASSETS.loader.bytes + ASSETS.wasm.bytes + ASSETS.model.bytes;

    let downloadCtl = new AbortController();   // aborts every in-flight asset download (cancel)
    let cancelled = false;
    let networkUsed = false;                    // true once anything had to come over the network
    const assetJobs = {};                       // name → { promise, listeners, bytes }  (shared by preload + start)

    const withTimeout = (p, ms, label) => Promise.race([
        p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
    ]);

    function emitProgress(pct, phase) {
        if (ui) {
            setStatus(phase === 'init' ? 'Starting hand tracking…'
                : `Downloading hand model… ${pct}%` + (networkUsed ? '\n(one-time download, ~17 MB)' : ''));
        }
        window.dispatchEvent(new CustomEvent('palmgestures:progress', { detail: { pct, phase } }));
    }

    /** Stream a URL into a Blob, reporting bytes; abort + retry on stall, then try the next mirror. */
    async function fetchBlob(urls, type, setBytes, signal) {
        let lastErr = new Error('no source');
        for (const url of urls) {
            for (let attempt = 0; attempt < 2; attempt++) {
                if (signal.aborted) throw new Error('cancelled');
                const ctl = new AbortController();
                const forward = () => ctl.abort();
                signal.addEventListener('abort', forward, { once: true });
                let stall;
                const arm = () => { clearTimeout(stall); stall = setTimeout(() => ctl.abort(), STALL_MS); };
                try {
                    arm();
                    const res = await fetch(url, { signal: ctl.signal });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    if (!res.body || !res.body.getReader) {            // very old browsers: no streaming
                        const whole = await res.blob();
                        setBytes(whole.size);
                        return new Blob([whole], { type });
                    }
                    const reader = res.body.getReader();
                    const parts = [];
                    let got = 0;
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        parts.push(value); got += value.length;
                        setBytes(got); arm();
                    }
                    return new Blob(parts, { type });
                } catch (e) {
                    if (signal.aborted) throw new Error('cancelled');
                    lastErr = e;
                    console.warn(`[gestures] download failed (${url.split('/').slice(-2).join('/')}, attempt ${attempt + 1}):`, e && e.message);
                    setBytes(0);
                } finally {
                    clearTimeout(stall);
                    signal.removeEventListener('abort', forward);
                }
            }
        }
        throw lastErr;
    }

    async function loadAssetOnce(name, notify, signal) {
        const a = ASSETS[name];
        let cache = null;
        try { cache = ('caches' in self) ? await caches.open(ASSET_CACHE) : null; } catch (e) { cache = null; }
        if (cache) {
            try {
                const hit = await cache.match(a.urls[0]);
                if (hit) { const b = await hit.blob(); notify(a.bytes); return new Blob([b], { type: a.type }); }
            } catch (e) { /* fall through to the network */ }
        }
        networkUsed = true;
        const blob = await fetchBlob(a.urls, a.type, notify, signal);
        notify(a.bytes);
        if (cache) cache.put(a.urls[0], new Response(blob, { headers: { 'content-type': a.type } })).catch(() => {});
        return blob;
    }

    /** One shared download per asset, so a hover-preload and a real start() never fetch twice. */
    function getAsset(name, setBytes) {
        let job = assetJobs[name];
        if (!job) {
            job = { listeners: new Set(), bytes: 0 };
            const notify = (n) => { job.bytes = n; job.listeners.forEach((fn) => fn(n)); };
            job.promise = loadAssetOnce(name, notify, downloadCtl.signal);
            job.promise.catch(() => { if (assetJobs[name] === job) delete assetJobs[name]; });
            assetJobs[name] = job;
        }
        job.listeners.add(setBytes);
        setBytes(job.bytes);
        return job.promise;
    }

    async function importBundle() {
        try { return await withTimeout(import(MP_BUNDLE), 20000, 'engine download'); }
        catch (e) { return await withTimeout(import(MP_BUNDLE_ALT), 20000, 'engine download (mirror)'); }
    }

    async function loadRecognizer() {
        if (recognizer) return recognizer;
        if (recognizerPromise) return recognizerPromise;
        cancelled = false;
        recognizerPromise = (async () => {
            const got = { loader: 0, wasm: 0, model: 0 };
            const track = (name) => (n) => {
                got[name] = Math.min(n, ASSETS[name].bytes);
                emitProgress(Math.min(99, Math.floor(100 * (got.loader + got.wasm + got.model) / TOTAL_BYTES)), 'download');
            };
            emitProgress(0, 'download');
            const [loaderBlob, wasmBlob, modelBlob, vision] = await Promise.all([
                getAsset('loader', track('loader')),
                getAsset('wasm', track('wasm')),
                getAsset('model', track('model')),
                importBundle(),
            ]);
            if (cancelled) throw new Error('cancelled');

            emitProgress(100, 'init');
            const loaderUrl = URL.createObjectURL(new Blob([loaderBlob], { type: 'text/javascript' }));
            const wasmUrl = URL.createObjectURL(new Blob([wasmBlob], { type: 'application/wasm' }));
            const fileset = { wasmLoaderPath: loaderUrl, wasmBinaryPath: wasmUrl };
            const modelBytes = new Uint8Array(await modelBlob.arrayBuffer());
            const create = (delegate) => vision.GestureRecognizer.createFromOptions(fileset, {
                baseOptions: { modelAssetBuffer: modelBytes.slice(), delegate },   // fresh copy per attempt
                runningMode: 'VIDEO',
                numHands: 2,            // second hand is only used for the 👏 clap
                minHandDetectionConfidence: 0.5,   // MediaPipe's defaults: 0.6 missed tilted / distant hands
                minHandPresenceConfidence: 0.5,    // (phantom hands are now filtered by selectHands instead)
                minTrackingConfidence: 0.5,
            });
            try {
                try {
                    recognizer = await withTimeout(create('GPU'), GPU_INIT_MS, 'GPU start-up');
                } catch (gpuErr) {
                    console.warn('[gestures] GPU delegate unavailable or too slow, using CPU:', gpuErr && gpuErr.message);
                    recognizer = await withTimeout(create('CPU'), CPU_INIT_MS, 'CPU start-up');
                }
            } finally {
                setTimeout(() => { URL.revokeObjectURL(loaderUrl); URL.revokeObjectURL(wasmUrl); }, 5000);
            }
            // Warm-up: the very first inference compiles GPU shaders and can block the page for
            // seconds on a cold start (we measured 5.7 s once). Do it NOW, behind the
            // "Starting hand tracking…" message, rather than freezing the live preview afterwards.
            try {
                await new Promise((r) => setTimeout(r, 60));          // let the status text paint first
                const c = document.createElement('canvas');
                c.width = 320; c.height = 240;
                c.getContext('2d').fillRect(0, 0, 320, 240);
                recognizer.recognizeForVideo(c, performance.now());
            } catch (e) { /* warm-up is best effort */ }
            if (cancelled) { try { recognizer.close(); } catch (e) {} recognizer = null; throw new Error('cancelled'); }
            return recognizer;
        })();
        try {
            return await recognizerPromise;
        } catch (e) {
            recognizerPromise = null; // allow retry later
            throw e;
        }
    }

    /** Download the model in the background (e.g. when the user hovers the Gestures button), no camera. */
    let preloading = false;
    async function preload() {
        if (recognizer || recognizerPromise || preloading) return;
        const c = navigator.connection;
        if (c && (c.saveData || /^(slow-2g|2g|3g)$/.test(c.effectiveType || ''))) return;   // don't burn mobile data on a guess
        preloading = true;
        try { await Promise.all(['loader', 'wasm', 'model'].map((n) => getAsset(n, () => {}))); }
        catch (e) { /* silent: a real start() will report problems */ }
        finally { preloading = false; }
    }

    /** Abort loading (or stop running) — wired to a second click on the Gestures button. */
    function abortDownloads() {
        try { downloadCtl.abort(); } catch (e) {}
        downloadCtl = new AbortController();
        for (const k of Object.keys(assetJobs)) delete assetJobs[k];
    }

    function cancel() {
        cancelled = true;
        abortDownloads();
        stop();
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
            text-align: center; padding: 12px; font-size: 12px; color: #ddd; background: rgba(0,0,0,.6); white-space: pre-line; }
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
        .gesture-cam-label { cursor: pointer; }
        .gesture-cam-debug { display: none; margin-top: 6px; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            color: #8fe3c0; white-space: pre-line; word-break: break-word; }
        .gesture-cam.debug .gesture-cam-debug { display: block; }
        .gesture-cam-copy { margin-top: 6px; background: rgba(255,255,255,.1); color: #fff; border: 1px solid rgba(255,255,255,.2);
            border-radius: 8px; padding: 6px 8px; font-size: 11px; cursor: pointer; }
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
                <span class="gesture-cam-label" title="Tap to show / hide what the engine sees" role="button" tabindex="0">—</span>
                <div class="gesture-cam-meter"><div class="gesture-cam-meter-fill"></div></div>
                <div class="gesture-cam-debug"></div>
            </div>
            <button class="gesture-cam-help" type="button" aria-label="Show gesture guide">?</button>
            <div class="gesture-cam-guide" hidden>
                ${Object.values(GESTURE_MAP).map(g => `<div><span>${g.emoji}</span> ${g.label}</div>`).join('')}
                <div><span>👋</span> Swipe left/right: prev/next</div>
                <div><span>⬆️</span> Swipe open hand up: full player</div>
                <div><span>⬇️</span> Swipe open hand down: close</div>
                <div><span>👏</span> Clap (two hands): play last song</div>
                <button type="button" class="gesture-cam-copy">Copy debug data</button>
            </div>`;
        document.body.appendChild(root);
        const guide = root.querySelector('.gesture-cam-guide');
        root.querySelector('.gesture-cam-help').onclick = () => { guide.hidden = !guide.hidden; };
        root.querySelector('.gesture-cam-copy').onclick = copyDebug;
        ui = {
            root,
            video: root.querySelector('video'),
            canvas: root.querySelector('canvas'),
            status: root.querySelector('.gesture-cam-status'),
            label: root.querySelector('.gesture-cam-label'),
            meter: root.querySelector('.gesture-cam-meter-fill'),
            debug: root.querySelector('.gesture-cam-debug'),
        };
        root.classList.toggle('debug', debugOn);
        const toggleDebug = () => setDebug(!debugOn);
        ui.label.addEventListener('click', toggleDebug);
        ui.label.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDebug(); } });
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

    /** Draw every detected hand: main = red, accepted second hand = blue, rejected/phantom = grey. */
    function drawHands(hands, primaryIdx, accepted = []) {
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
            ctx.fillStyle = primary ? '#FF1744' : accepted.includes(landmarks) ? '#3DA5FF' : '#777';
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
            case 'closePlayer': P.dismissOverlay(); break;      // silently ignored when there's nothing to close
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

    // ── Debug: what the engine saw on each frame (HUD + copyable log) ───────────
    const DEBUG_KEY = 'palmplay_gesture_debug';
    const debugLog = [];            // ring buffer of the last ~8 s of frames
    const DEBUG_MAX = 240;
    let debugOn = false;
    try { debugOn = localStorage.getItem(DEBUG_KEY) === '1'; } catch (e) { /* storage blocked */ }

    function setDebug(on) {
        debugOn = !!on;
        try { localStorage.setItem(DEBUG_KEY, debugOn ? '1' : '0'); } catch (e) {}
        if (ui) ui.root.classList.toggle('debug', debugOn);
    }

    /** Copy the last few seconds of per-frame decisions as JSON — paste it to get accuracy problems diagnosed. */
    async function copyDebug() {
        const payload = JSON.stringify({ ua: navigator.userAgent, config: CONFIG, frames: debugLog }, null, 0);
        try { await navigator.clipboard.writeText(payload); toast(`Copied ${debugLog.length} frames of debug data`, 'fa-clipboard-check'); }
        catch (e) { console.log(payload); toast('Could not copy — debug data was printed to the browser console', 'fa-terminal'); }
    }

    function handednessScore(result, i) {
        const h = (result.handedness || result.handednesses || [])[i];
        return h && h[0] && typeof h[0].score === 'number' ? h[0].score : 1;
    }

    /** One frame of recognizer output → draw, interpret, update HUD. Returns the interpreter's output. */
    function handleResult(result, now) {
        const video = ui.video;
        const aspect = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 4 / 3;
        // Up to two hands. MediaPipe's hand order isn't stable between frames, and it sometimes reports
        // "phantom" hands, so choose the main hand and validate any second one (see selectHands).
        const raw = (result.landmarks || []).map((lm, i) => ({
            lm, gesture: (result.gestures && result.gestures[i] && result.gestures[i][0]) || null, hscore: handednessScore(result, i),
        }));
        const sel = selectHands(raw, lastPrimary, aspect);
        const landmarks = sel.primary ? sel.primary.lm : null;
        const top = sel.primary ? sel.primary.gesture : null;
        const others = sel.others;
        lastPrimary = landmarks ? { x: landmarks[0].x, y: landmarks[0].y } : null;
        drawHands(raw.map((h) => h.lm), sel.pi, others);

        const out = interpreter.update({
            t: now,
            gesture: top ? top.categoryName : null,
            score: top ? top.score : 0,
            wrist: landmarks ? { x: landmarks[0].x, y: landmarks[0].y } : null,
            landmarks: landmarks || null,
            others,
            aspect,
        });

        const def = out.candidate && GESTURE_MAP[out.candidate];
        ui.label.textContent = out.via === 'clap' ? '👏 Clap!'
            : out.twoHands ? '🙌 Two hands — clap to play'
            : landmarks
                ? (def ? `${def.emoji} ${def.label}` : (out.moving ? 'Moving…' : 'Hand detected'))
                : 'Show your hand';
        ui.meter.style.width = `${Math.round(out.progress * 100)}%`;
        ui.root.classList.toggle('firing', !!out.action);

        const info = interpreter.lastInfo;
        debugLog.push({
            t: Math.round(now), hands: raw.length, hs: raw.map((h) => +h.hscore.toFixed(2)), counted2nd: others.length,
            model: info ? info.model : null, ms: info ? +info.modelScore.toFixed(2) : null, pose: info ? info.pose : null,
            why: info ? info.why : null, f: info ? info.fingers : null, s: info ? info.strict : null,
            mv: info ? info.moving : null, two: out.twoHands || false, hold: +(out.progress || 0).toFixed(2), act: out.action || null,
        });
        if (debugLog.length > DEBUG_MAX) debugLog.shift();
        if (debugOn && ui.debug) {
            ui.debug.textContent = info
                ? `model ${info.model} ${Math.round(info.modelScore * 100)}%  ·  fingers ${info.fingers || '-'} (clear ${info.strict || '-'})\n→ ${info.pose || 'no pose'}: ${info.why}${info.moving ? ' · moving' : ''}\nhands seen ${raw.length}${others.length ? ` (+${others.length} counted)` : ''}`
                : `hands seen ${raw.length}`;
        }
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
        let timedOut = false;
        let loadTimer = null;
        // Start the model download in parallel with the camera prompt.
        const modelP = loadRecognizer();
        modelP.catch(() => {}); // handled below; avoid unhandled-rejection noise
        try {
            setStatus('Starting camera…');
            await openCamera();
            if (!running) throw new Error('cancelled');
            phase = 'model';
            if (!recognizer) setStatus('Downloading hand model…');
            // The clock starts once the camera is on (the permission prompt can take as long as the user likes).
            const timeout = new Promise((_, rej) => {
                loadTimer = setTimeout(() => { timedOut = true; rej(new Error('timeout')); }, TOTAL_LOAD_MS);
            });
            await Promise.race([modelP, timeout]);
        } catch (e) {
            const byUser = !running || (e && e.message === 'cancelled');
            if (timedOut) abortDownloads();
            stop();
            if (byUser && !timedOut) return { ok: false, error: 'cancelled' };
            console.error('[gestures] start failed', e);
            const msg = phase === 'camera' ? describeCameraError(e)
                : timedOut ? 'Loading the gesture model is taking too long. Check your connection and try again — the model only has to download once.'
                : `Could not load the gesture model: ${(e && e.message) || 'check your connection'}.`;
            return { ok: false, error: msg };
        } finally {
            clearTimeout(loadTimer);
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

    window.PalmGestures = { start, stop, cancel, preload, isRunning: () => running, Interpreter, CONFIG, GESTURE_MAP,
        analyzeHand, geometryPose, poseFits, handDistance, handPair, selectHands,
        getDebugLog: () => debugLog.slice(), copyDebug, setDebug,
        _handleResult: handleResult, _perform: perform, _interpreter: interpreter, _loadRecognizer: loadRecognizer };   // test hooks
})();
