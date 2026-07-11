"""
PalmPlay - FastAPI Backend Server
Handles gesture detection via WebSocket and serves as an API bridge.
This is the CLOUD version - no pygame, no local music playback.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import os
import json
import base64
import asyncio
import cv2
import numpy as np
from io import BytesIO
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
        self.center_buf = deque(maxlen=6)
        self.finger_buf = deque(maxlen=6)
        self.last_trigger = {}
        self.cooldown = 1.0

    def fingers_up(self, lm):
        tips = [8, 12, 16, 20]
        count = 0
        for tip in tips:
            try:
                if lm[tip][1] < lm[tip - 2][1]:
                    count += 1
            except:
                pass
        try:
            if abs(lm[4][0] - lm[0][0]) > 0.06:
                count += 1
        except:
            pass
        return count

    def cooldown_ok(self, action):
        t = time.time()
        last = self.last_trigger.get(action, 0)
        if t - last >= self.cooldown:
            self.last_trigger[action] = t
            return True
        return False

    def recognize(self, landmarks):
        if not landmarks:
            return None

        lm = landmarks
        raw_cnt = self.fingers_up(lm)
        self.finger_buf.append(raw_cnt)
        cnt = int(round(np.median(list(self.finger_buf))))

        thumb_up  = lm[4][1] < lm[3][1]
        idx_up    = lm[8][1] < lm[6][1]
        mid_up    = lm[12][1] < lm[10][1]
        ring_up   = lm[16][1] < lm[14][1]
        pinky_up  = lm[20][1] < lm[18][1]

        # Open palm -> Shuffle
        if cnt >= 5 and idx_up and mid_up and ring_up and pinky_up and thumb_up:
            if self.cooldown_ok("shuffle"):
                return "shuffle"

        # Thumb up -> Repeat
        if thumb_up and not idx_up and not mid_up and not ring_up and not pinky_up:
            if lm[4][1] < lm[0][1] - 0.1:
                if self.cooldown_ok("repeat"):
                    return "repeat"

        # Two fingers -> Volume
        if cnt >= 2 and idx_up and mid_up and not ring_up and not pinky_up:
            vol = int((1.0 - np.mean([lm[8][1], lm[12][1]])) * 100)
            return ("volume", max(0, min(100, vol)))

        # Fist -> Toggle play/pause
        tips = [4, 8, 12, 16, 20]
        folded = sum(1 for tip in tips if lm[tip][1] > lm[tip - 2][1])
        if folded >= 4:
            if self.cooldown_ok("toggle"):
                return "toggle"

        return None


# ── Globals ──────────────────────────────────────────────────────────────────

gesture_recognizer = GestureRecognizer()
hand_detector = None


def init_hand_detector():
    global hand_detector
    # Look for the model in the same directory as this script
    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hand_landmarker.task")
    if os.path.exists(model_path):
        base_options = python.BaseOptions(model_asset_path=model_path)
        options = vision.HandLandmarkerOptions(
            base_options=base_options,
            num_hands=1,
            min_hand_detection_confidence=0.7,
            min_tracking_confidence=0.5,
        )
        hand_detector = vision.HandLandmarker.create_from_options(options)
        print(f"✅ Hand detector loaded from: {model_path}")
    else:
        print(f"⚠️  hand_landmarker.task not found at: {model_path}")


try:
    init_hand_detector()
except Exception as e:
    print(f"Hand detector init failed: {e}")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "PalmPlay Gesture API is running 🚀", "hand_detector": hand_detector is not None}


@app.get("/health")
async def health():
    return {"status": "ok", "hand_detector_ready": hand_detector is not None}


@app.websocket("/ws/gesture")
async def websocket_gesture(websocket: WebSocket):
    await websocket.accept()
    print("Client connected to /ws/gesture")

    if hand_detector is None:
        await websocket.send_json({"gesture": None, "error": "Hand detector not initialized. Check that hand_landmarker.task is present."})
        await websocket.close()
        return

    try:
        while True:
            # Receive base64 image string from frontend
            data = await websocket.receive_text()

            # Strip the data URL prefix if present
            if data.startswith("data:image"):
                data = data.split(",")[1]

            # Decode the image
            img_bytes = base64.b64decode(data)
            nparr = np.frombuffer(img_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if frame is not None:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = hand_detector.detect(mp_image)

                if result.hand_landmarks:
                    landmarks = [(lm.x, lm.y, lm.z) for lm in result.hand_landmarks[0]]
                    gesture = gesture_recognizer.recognize(landmarks)

                    if gesture:
                        if isinstance(gesture, tuple) and gesture[0] == "volume":
                            await websocket.send_json({"gesture": "volume", "value": gesture[1]})
                        else:
                            await websocket.send_json({"gesture": gesture})

            await asyncio.sleep(0.01)

    except WebSocketDisconnect:
        print("Client disconnected from /ws/gesture")
    except Exception as e:
        print(f"WebSocket error: {e}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)  # nosec B104
