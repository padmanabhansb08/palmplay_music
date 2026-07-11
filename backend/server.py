"""
PalmPlay - FastAPI Backend Server (HIGH ACCURACY VERSION)
Uses Google MediaPipe's pre-trained GestureRecognizer neural network
for 97%+ gesture detection accuracy instead of manual landmark math.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import os
import base64
import asyncio
import cv2
import numpy as np
from collections import deque
import time
import urllib.request

# MediaPipe imports
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

app = FastAPI(title="PalmPlay Gesture API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Model Download ─────────────────────────────────────────────────────────────

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gesture_recognizer.task")


def ensure_model():
    if not os.path.exists(MODEL_PATH):
        print(f"Downloading gesture model from Google...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        print(f"Model downloaded to: {MODEL_PATH}")
    else:
        print(f"Model already present at: {MODEL_PATH}")


# ── Gesture Action Mapper ──────────────────────────────────────────────────────
#
# MediaPipe GestureRecognizer returns these class names:
#   None, Closed_Fist, Open_Palm, Pointing_Up, Thumb_Up, Thumb_Down,
#   Victory, ILoveYou
#
# We map them to PalmPlay actions:

# Gestures that need ONLY the class name (no direction check)
GESTURE_MAP = {
    "Closed_Fist": "toggle",   # Fist  -> Play / Pause
    "Open_Palm":   "shuffle",  # Palm  -> Shuffle
    "Thumb_Up":    "repeat",   # Thumb -> Repeat
}

# Cooldown per action (seconds)
COOLDOWNS = {
    "toggle":  1.2,
    "shuffle": 1.5,
    "repeat":  1.5,
    "next":    1.2,
    "prev":    1.2,
}


class ActionCooldown:
    def __init__(self):
        self.last = {}

    def ok(self, action):
        now = time.time()
        cd = COOLDOWNS.get(action, 1.0)
        if now - self.last.get(action, 0) >= cd:
            self.last[action] = now
            return True
        return False


# ── Globals ───────────────────────────────────────────────────────────────────

gesture_recognizer = None
cooldown = ActionCooldown()


def init_recognizer():
    global gesture_recognizer
    ensure_model()
    base_options = python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.GestureRecognizerOptions(
        base_options=base_options,
        num_hands=1,
        min_hand_detection_confidence=0.7,
        min_hand_presence_confidence=0.6,
        min_tracking_confidence=0.6,
    )
    gesture_recognizer = vision.GestureRecognizer.create_from_options(options)
    print("GestureRecognizer (AI model) loaded successfully!")


try:
    init_recognizer()
except Exception as e:
    print(f"GestureRecognizer init failed: {e}")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "PalmPlay Gesture API running", "model_ready": gesture_recognizer is not None}


@app.get("/health")
async def health():
    return {"status": "ok", "model_ready": gesture_recognizer is not None}


@app.get("/api/state")
async def api_state():
    return {"model_ready": gesture_recognizer is not None}


@app.websocket("/ws/gesture")
async def websocket_gesture(websocket: WebSocket):
    await websocket.accept()
    print("Client connected to /ws/gesture")

    if gesture_recognizer is None:
        await websocket.send_json({"gesture": None, "error": "AI gesture model not initialized."})
        await websocket.close()
        return

    try:
        while True:
            data = await websocket.receive_text()

            # Strip data URL prefix
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

            if frame is None:
                await asyncio.sleep(0.02)
                continue

            # Run inference
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = gesture_recognizer.recognize(mp_image)

            if not result.gestures or not result.gestures[0]:
                await asyncio.sleep(0.02)
                continue

            top_gesture = result.gestures[0][0]
            label = top_gesture.category_name
            score = top_gesture.score

            # Ignore low-confidence predictions
            if score < 0.80:
                await asyncio.sleep(0.02)
                continue

            response = None

            # ── Named gestures ───────────────────────────────────────────
            if label in GESTURE_MAP:
                action = GESTURE_MAP[label]
                if cooldown.ok(action):
                    response = {"gesture": action}

            # ── Pointing Up: determine LEFT or RIGHT using landmarks ──────
            elif label == "Pointing_Up" and result.hand_landmarks:
                lm = result.hand_landmarks[0]
                # index tip x vs wrist x (0=left, 1=right in image)
                tip_x   = lm[8].x
                wrist_x = lm[0].x
                diff = tip_x - wrist_x
                if diff > 0.08:     # tip to the right → Next
                    if cooldown.ok("next"):
                        response = {"gesture": "next"}
                elif diff < -0.08:  # tip to the left  → Prev
                    if cooldown.ok("prev"):
                        response = {"gesture": "prev"}

            # ── Victory / Two fingers: Volume control ─────────────────────
            elif label == "Victory" and result.hand_landmarks:
                lm = result.hand_landmarks[0]
                avg_y = (lm[8].y + lm[12].y) / 2.0
                vol = int((1.0 - avg_y) * 120)
                vol = max(0, min(100, vol))
                response = {"gesture": "volume", "value": vol}

            if response:
                await websocket.send_json(response)

            await asyncio.sleep(0.02)

    except WebSocketDisconnect:
        print("Client disconnected from /ws/gesture")
    except Exception as e:
        print(f"WebSocket error: {e}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)  # nosec B104
