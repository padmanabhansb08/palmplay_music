"""
camera.py — Background camera capture thread + MediaPipe hand-detection pipeline.

CameraManager runs inside a daemon thread so it never blocks FastAPI's event loop.
After each meaningful gesture event it pushes to FastAPI via asyncio.run_coroutine_threadsafe.
"""

from __future__ import annotations

import asyncio
import io
import logging
import threading
import time
from typing import Any, Callable, Coroutine, Optional, Set

import cv2
import mediapipe as mp
import numpy as np

import config
from gesture_engine import GestureEngine

logger = logging.getLogger(__name__)

_mp_hands = mp.solutions.hands


class CameraManager:
    """
    Manages the webcam capture loop inside a daemon background thread.

    Usage:
        cam = CameraManager(camera_index=0, target_fps=30, gesture_engine=engine)
        cam.register_broadcast_callback(broadcast_fn, asyncio_loop)
        cam.start()
        ...
        cam.stop()
    """

    def __init__(
        self,
        camera_index: int,
        target_fps: int,
        gesture_engine: GestureEngine,
    ) -> None:
        self._index = camera_index
        self._fps = target_fps
        self._engine = gesture_engine

        self._cap: Optional[cv2.VideoCapture] = None
        self._thread: Optional[threading.Thread] = None
        self._running = threading.Event()

        self._broadcast_cb: Optional[Callable[..., Coroutine]] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        # Last JPEG frame (for snapshot endpoint)
        self._frame_lock = threading.Lock()
        self._last_jpeg: Optional[bytes] = None

        # Track previous gesture to suppress IDLE→IDLE noise
        self._last_emitted_gesture: str = ""

    # ── Public API ────────────────────────────────────────────────────────────

    def register_broadcast_callback(
        self,
        cb: Callable[..., Coroutine],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._broadcast_cb = cb
        self._loop = loop

    def start(self) -> None:
        if self._running.is_set():
            logger.warning("CameraManager already running.")
            return
        self._running.set()
        self._thread = threading.Thread(
            target=self._capture_loop,
            name="camera-capture",
            daemon=True,
        )
        self._thread.start()
        logger.info("CameraManager started (camera_index=%d).", self._index)

    def stop(self) -> None:
        self._running.clear()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3.0)
        if self._cap and self._cap.isOpened():
            self._cap.release()
        logger.info("CameraManager stopped.")

    @property
    def is_running(self) -> bool:
        return self._running.is_set()

    def get_frame_as_jpeg(self) -> Optional[bytes]:
        with self._frame_lock:
            return self._last_jpeg

    # ── Internal capture loop (runs in daemon thread) ─────────────────────────

    def _capture_loop(self) -> None:
        frame_interval = 1.0 / self._fps

        self._cap = cv2.VideoCapture(self._index)
        if not self._cap.isOpened():
            logger.error("Failed to open camera at index %d.", self._index)
            self._running.clear()
            return

        # Configure camera properties
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.FRAME_WIDTH)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.FRAME_HEIGHT)
        self._cap.set(cv2.CAP_PROP_FPS, config.TARGET_FPS)
        self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        with _mp_hands.Hands(
            static_image_mode=False,
            max_num_hands=config.MP_MAX_HANDS,
            model_complexity=config.MP_COMPLEXITY,
            min_detection_confidence=config.MP_DET_CONF,
            min_tracking_confidence=config.MP_TRACK_CONF,
        ) as hands:
            while self._running.is_set():
                loop_start = time.monotonic()

                ret, frame = self._cap.read()
                if not ret or frame is None:
                    logger.warning("Empty frame from camera — retrying.")
                    time.sleep(0.05)
                    continue

                # Mirror the frame (selfie mode)
                frame = cv2.flip(frame, 1)

                # Save JPEG snapshot for the REST endpoint
                ok, jpeg_buf = cv2.imencode(".jpg", frame)
                if ok:
                    with self._frame_lock:
                        self._last_jpeg = jpeg_buf.tobytes()

                # MediaPipe expects RGB; disable writeable for performance
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                rgb.flags.writeable = False
                results = hands.process(rgb)

                # ── Parse MediaPipe results ──────────────────────────────────
                if results.multi_hand_landmarks and results.multi_handedness:
                    lm_list = results.multi_hand_landmarks[0]
                    handedness_label = (
                        results.multi_handedness[0]
                        .classification[0]
                        .label
                    )

                    raw = [
                        {"x": lm.x, "y": lm.y, "z": lm.z}
                        for lm in lm_list.landmark
                    ]
                    state = self._engine.process(raw, handedness_label)
                else:
                    state = self._engine.process_no_hand()

                # ── Suppress IDLE→IDLE noise ──────────────────────────────────
                gesture = state.get("gesture", "IDLE")
                if gesture == "IDLE" and self._last_emitted_gesture == "IDLE":
                    pass  # don't broadcast
                else:
                    self._last_emitted_gesture = gesture
                    payload = {"type": "gesture", **state}
                    self._push(payload)

                # ── Pace to target FPS ────────────────────────────────────────
                elapsed = time.monotonic() - loop_start
                sleep_for = frame_interval - elapsed
                if sleep_for > 0:
                    time.sleep(sleep_for)

        if self._cap:
            self._cap.release()

    def _push(self, payload: dict) -> None:
        """Thread-safe: schedule broadcast coroutine on the asyncio event loop."""
        if self._broadcast_cb is None or self._loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast_cb(payload), self._loop)
        except Exception as exc:
            logger.error("Failed to schedule broadcast: %s", exc)
