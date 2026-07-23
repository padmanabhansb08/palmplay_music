"""
PalmPlay - FastAPI Backend Server (PRECISION MODE)
Uses Google MediaPipe's GestureRecognizer neural network with
multi-frame temporal smoothing for near-perfect accuracy.

Key principle: A gesture must be HELD for HOLD_FRAMES consecutive frames
before it triggers. This eliminates virtually all false positives.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import os
import base64
import asyncio
import cv2
import numpy as np
from collections import deque, Counter
import time
import urllib.request

import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

app = FastAPI(title="PalmPlay Gesture API - Precision Mode")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Model ─────────────────────────────────────────────────────────────────────

MODEL_URL  = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gesture_recognizer.task")


def ensure_model():
    if not os.path.exists(MODEL_PATH):
        print("Downloading gesture model from Google (~25 MB)...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        print(f"Model downloaded: {MODEL_PATH}")
    else:
        print(f"Model found: {MODEL_PATH}")


# ── Precision Gesture Engine ───────────────────────────────────────────────────

# How many consecutive frames the gesture must be held before it fires.
# At 5 fps (200ms/frame), HOLD_FRAMES=3 → gesture must be held ~600ms.
HOLD_FRAMES = 3

# Minimum AI confidence to even consider a gesture (0.0 – 1.0)
MIN_CONFIDENCE = 0.90

# Cooldown between repeated triggers of the same action (seconds)
COOLDOWNS = {
    "toggle":  1.5,
    "shuffle": 2.0,
    "repeat":  2.0,
    "next":    1.3,
    "prev":    1.3,
    "volume":  0.0,   # volume fires continuously while held (no cooldown)
}

# MediaPipe gesture name → PalmPlay action
GESTURE_MAP = {
    "Closed_Fist": "toggle",
    "Open_Palm":   "shuffle",
    "Thumb_Up":    "repeat",
}


class PrecisionGestureEngine:
    """
    Wraps MediaPipe GestureRecognizer and adds temporal smoothing.
    A gesture fires ONLY when the same label appears for HOLD_FRAMES
    consecutive high-confidence frames AND the cooldown has elapsed.
    """

    def __init__(self, recognizer):
        self.recognizer = recognizer
        self.frame_buf  = deque(maxlen=HOLD_FRAMES)   # (label, score, lm)
        self.last_fired  = {}                          # action → timestamp
        self.last_volume = -1                          # suppress tiny vol changes

    # ── Cooldown ──────────────────────────────────────────────────────────────

    def _cooldown_ok(self, action: str) -> bool:
        cd = COOLDOWNS.get(action, 1.0)
        if cd == 0.0:
            return True
        now = time.time()
        if now - self.last_fired.get(action, 0) >= cd:
            self.last_fired[action] = now
            return True
        return False

    # ── Per-frame inference ───────────────────────────────────────────────────

    def process_frame(self, frame: np.ndarray) -> dict | None:
        """
        Run inference on one BGR frame.
        Returns an action dict or None.
        """
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = self.recognizer.recognize(mp_img)

        # No hand / no gesture detected this frame
        if not result.gestures or not result.gestures[0]:
            self.frame_buf.clear()   # reset streak — hand left frame
            return None

        top = result.gestures[0][0]
        label = top.category_name
        score = top.score

        # Below confidence threshold → treat as no gesture
        if score < MIN_CONFIDENCE:
            self.frame_buf.clear()
            return None

        lm = result.hand_landmarks[0] if result.hand_landmarks else None

        # Append (label, score, landmarks) to rolling buffer
        self.frame_buf.append((label, score, lm))

        # Not enough frames yet to decide
        if len(self.frame_buf) < HOLD_FRAMES:
            return None

        # All buffered labels must agree (prevents flickering transitions)
        labels_in_buf = [f[0] for f in self.frame_buf]
        if len(set(labels_in_buf)) != 1:
            return None   # mixed labels → still transitioning, ignore

        # Use the most recent landmarks for directional math
        confirmed_label = label
        confirmed_lm    = lm

        return self._dispatch(confirmed_label, confirmed_lm)

    # ── Action dispatch ───────────────────────────────────────────────────────

    def _dispatch(self, label: str, lm) -> dict | None:
        # Simple label → action mapping
        if label in GESTURE_MAP:
            action = GESTURE_MAP[label]
            if self._cooldown_ok(action):
                self.frame_buf.clear()   # reset so it doesn't re-fire immediately
                return {"gesture": action}

        # Pointing_Up → Next (right) or Prev (left) based on landmark direction
        elif label == "Pointing_Up" and lm:
            tip_x   = lm[8].x
            wrist_x = lm[0].x
            diff    = tip_x - wrist_x
            if diff > 0.09:
                if self._cooldown_ok("next"):
                    self.frame_buf.clear()
                    return {"gesture": "next"}
            elif diff < -0.09:
                if self._cooldown_ok("prev"):
                    self.frame_buf.clear()
                    return {"gesture": "prev"}

        # Victory ✌️ → Volume (continuous, no cooldown, suppress tiny changes)
        elif label == "Victory" and lm:
            avg_y = (lm[8].y + lm[12].y) / 2.0
            vol   = max(0, min(100, int((1.0 - avg_y) * 120)))
            if abs(vol - self.last_volume) >= 3:   # only send if change ≥ 3%
                self.last_volume = vol
                return {"gesture": "volume", "value": vol}

        return None


# ── Globals ───────────────────────────────────────────────────────────────────

_mp_recognizer = None
engine: PrecisionGestureEngine | None = None


def init_engine():
    global _mp_recognizer, engine
    ensure_model()
    base_options = python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.GestureRecognizerOptions(
        base_options=base_options,
        num_hands=1,
        min_hand_detection_confidence=0.75,
        min_hand_presence_confidence=0.70,
        min_tracking_confidence=0.65,
    )
    _mp_recognizer = vision.GestureRecognizer.create_from_options(options)
    engine = PrecisionGestureEngine(_mp_recognizer)
    print("Precision GestureEngine ready!")


try:
    init_engine()
except Exception as exc:
    print(f"Engine init failed: {exc}")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "PalmPlay Precision Gesture API", "engine_ready": engine is not None}


@app.get("/health")
async def health():
    return {"status": "ok", "engine_ready": engine is not None}


@app.get("/api/state")
async def api_state():
    return {"engine_ready": engine is not None}


@app.websocket("/ws/gesture")
async def websocket_gesture(websocket: WebSocket):
    await websocket.accept()
    print("Client connected /ws/gesture")

    if engine is None:
        await websocket.send_json({"gesture": None, "error": "Engine not ready"})
        await websocket.close()
        return

    # Each WebSocket connection gets its own engine instance so multi-user
    # sessions don't share state.
    session_engine = PrecisionGestureEngine(_mp_recognizer)

    try:
        while True:
            data = await websocket.receive_text()

            # Strip data-URL prefix
            if data.startswith("data:image"):
                data = data.split(",", 1)[1]

            # Decode JPEG frame
            try:
                img_bytes = base64.b64decode(data)
                nparr = np.frombuffer(img_bytes, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            except Exception:
                await asyncio.sleep(0.02)
                continue

            if frame is None:
                await asyncio.sleep(0.02)
                continue

            # Run precision engine
            result = session_engine.process_frame(frame)
            if result:
                await websocket.send_json(result)

            await asyncio.sleep(0.02)

    except WebSocketDisconnect:
        print("Client disconnected /ws/gesture")
    except Exception as exc:
        print(f"WebSocket error: {exc}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)  # nosec B104
