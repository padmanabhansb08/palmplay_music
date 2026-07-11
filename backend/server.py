"""
PalmPlay - FastAPI Backend Server
Handles gesture detection via WebSocket and serves as an API bridge.
This is the CLOUD version - no pygame, no local music playback.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import os
import base64
import asyncio
import cv2
import numpy as np
from collections import deque
import time

# MediaPipe imports
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

app = FastAPI(title="PalmPlay Gesture API")

# CORS - allow all origins so the Vercel frontend can connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Gesture Recognizer ──────────────────────────────────────────────────────

class GestureRecognizer:
    def __init__(self):
        self.finger_buf = deque(maxlen=5)
        self.last_trigger = {}
        self.cooldown = 1.2

    def is_extended(self, lm, tip, pip, use_x=False):
        """Returns True if a finger is clearly extended."""
        if use_x:
            return abs(lm[tip][0] - lm[pip][0]) > 0.04
        return lm[tip][1] < lm[pip][1] - 0.02

    def is_folded(self, lm, tip, pip):
        """Returns True if a finger is clearly folded down."""
        return lm[tip][1] > lm[pip][1] + 0.02

    def cooldown_ok(self, action):
        t = time.time()
        if t - self.last_trigger.get(action, 0) >= self.cooldown:
            self.last_trigger[action] = t
            return True
        return False

    def recognize(self, lm):
        if not lm or len(lm) < 21:
            return None

        # Per-finger extended/folded states with margin to reduce jitter
        thumb_ext  = abs(lm[4][0] - lm[2][0]) > 0.04
        idx_ext    = self.is_extended(lm, 8, 6)
        mid_ext    = self.is_extended(lm, 12, 10)
        ring_ext   = self.is_extended(lm, 16, 14)
        pinky_ext  = self.is_extended(lm, 20, 18)

        idx_fold   = self.is_folded(lm, 8, 6)
        mid_fold   = self.is_folded(lm, 12, 10)
        ring_fold  = self.is_folded(lm, 16, 14)
        pinky_fold = self.is_folded(lm, 20, 18)

        ext_count = sum([thumb_ext, idx_ext, mid_ext, ring_ext, pinky_ext])
        self.finger_buf.append(ext_count)
        smooth_count = int(round(np.median(list(self.finger_buf))))

        # ── FIST → Toggle play/pause ──────────────────────────────────────
        # All 4 fingers clearly folded regardless of thumb
        if idx_fold and mid_fold and ring_fold and pinky_fold:
            if self.cooldown_ok("toggle"):
                return {"gesture": "toggle"}

        # ── OPEN PALM → Shuffle ───────────────────────────────────────────
        if smooth_count >= 5 and idx_ext and mid_ext and ring_ext and pinky_ext:
            if self.cooldown_ok("shuffle"):
                return {"gesture": "shuffle"}

        # ── THUMB UP → Repeat ─────────────────────────────────────────────
        # Thumb tip well above wrist, all fingers folded
        if (lm[4][1] < lm[0][1] - 0.10 and
                not idx_ext and not mid_ext and not ring_ext and not pinky_ext):
            if self.cooldown_ok("repeat"):
                return {"gesture": "repeat"}

        # ── INDEX POINTING RIGHT → Next track ─────────────────────────────
        # Only index finger extended AND pointing to the right of wrist
        if idx_ext and not mid_ext and not ring_ext and not pinky_ext:
            if lm[8][0] > lm[0][0] + 0.10:
                if self.cooldown_ok("next"):
                    return {"gesture": "next"}
            # ── INDEX POINTING LEFT → Prev track ──────────────────────────
            elif lm[8][0] < lm[0][0] - 0.10:
                if self.cooldown_ok("prev"):
                    return {"gesture": "prev"}

        # ── TWO FINGERS (index + middle) → Volume control ─────────────────
        # Volume mapped from fingertip height: high hand = loud, low hand = quiet
        if idx_ext and mid_ext and not ring_ext and not pinky_ext:
            avg_y = (lm[8][1] + lm[12][1]) / 2.0
            vol = int((1.0 - avg_y) * 120)
            return {"gesture": "volume", "value": max(0, min(100, vol))}

        return None


# ── Globals ──────────────────────────────────────────────────────────────────

gesture_recognizer = GestureRecognizer()
hand_detector = None


def init_hand_detector():
    global hand_detector
    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hand_landmarker.task")
    if os.path.exists(model_path):
        base_options = python.BaseOptions(model_asset_path=model_path)
        options = vision.HandLandmarkerOptions(
            base_options=base_options,
            num_hands=1,
            min_hand_detection_confidence=0.6,
            min_hand_presence_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        hand_detector = vision.HandLandmarker.create_from_options(options)
        print(f"Hand detector loaded from: {model_path}")
    else:
        print(f"WARNING: hand_landmarker.task not found at: {model_path}")


try:
    init_hand_detector()
except Exception as e:
    print(f"Hand detector init failed: {e}")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "PalmPlay Gesture API is running", "hand_detector": hand_detector is not None}


@app.get("/health")
async def health():
    return {"status": "ok", "hand_detector_ready": hand_detector is not None}


@app.get("/api/state")
async def api_state():
    return {"hand_detector_ready": hand_detector is not None}


@app.websocket("/ws/gesture")
async def websocket_gesture(websocket: WebSocket):
    await websocket.accept()
    print("Client connected to /ws/gesture")

    if hand_detector is None:
        await websocket.send_json({
            "gesture": None,
            "error": "Hand detector not initialized. Check that hand_landmarker.task is present."
        })
        await websocket.close()
        return

    try:
        while True:
            # Receive base64 image string from frontend
            data = await websocket.receive_text()

            # Strip data URL prefix if present
            if data.startswith("data:image"):
                data = data.split(",")[1]

            # Decode image
            try:
                img_bytes = base64.b64decode(data)
                nparr = np.frombuffer(img_bytes, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            except Exception:
                await asyncio.sleep(0.02)
                continue

            if frame is not None:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = hand_detector.detect(mp_image)

                if result.hand_landmarks:
                    landmarks = [(lm.x, lm.y, lm.z) for lm in result.hand_landmarks[0]]
                    gesture_result = gesture_recognizer.recognize(landmarks)
                    if gesture_result:
                        await websocket.send_json(gesture_result)

            await asyncio.sleep(0.02)

    except WebSocketDisconnect:
        print("Client disconnected from /ws/gesture")
    except Exception as e:
        print(f"WebSocket error: {e}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)  # nosec B104
