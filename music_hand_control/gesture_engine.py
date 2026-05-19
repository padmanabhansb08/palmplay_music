"""
gesture_engine.py — Core gesture recognition pipeline.

Implements:
  • Point3D          — 3-D coordinate dataclass
  • HandLandmarks    — Wraps 21 MediaPipe landmarks with helpers
  • SwipeDetector    — Sliding-window horizontal swipe detector
  • GestureEngine    — Stateful classifier → returns gesture state dicts
"""

from __future__ import annotations

import math
import time as _time_module
from collections import deque
from dataclasses import dataclass
from typing import Deque, Dict, List, Optional, Tuple

import config

# ── Make `time` patchable in tests ──────────────────────────────────────────
import time  # noqa: E402  (re-import so tests can patch gesture_engine.time)

# ── MediaPipe landmark indices ────────────────────────────────────────────────
WRIST = 0
THUMB_MCP = 2
THUMB_TIP = 4
INDEX_MCP = 5
INDEX_PIP = 6
INDEX_TIP = 8
MIDDLE_MCP = 9
MIDDLE_PIP = 10
MIDDLE_TIP = 12
RING_MCP = 13
RING_PIP = 14
RING_TIP = 16
PINKY_MCP = 17
PINKY_PIP = 18
PINKY_TIP = 20

# ── Finger descriptor tuples ──────────────────────────────────────────────────
_FINGERS = [
    (INDEX_TIP,  INDEX_PIP,  INDEX_MCP),
    (MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP),
    (RING_TIP,   RING_PIP,   RING_MCP),
    (PINKY_TIP,  PINKY_PIP,  PINKY_MCP),
]


# ─────────────────────────────────────────────────────────────────────────────
# Point3D
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Point3D:
    x: float
    y: float
    z: float

    def distance(self, other: "Point3D") -> float:
        return math.sqrt(
            (self.x - other.x) ** 2
            + (self.y - other.y) ** 2
            + (self.z - other.z) ** 2
        )


# ─────────────────────────────────────────────────────────────────────────────
# HandLandmarks
# ─────────────────────────────────────────────────────────────────────────────

class HandLandmarks:
    """Wraps the raw 21-point MediaPipe landmark list."""

    def __init__(
        self,
        raw: List[Dict[str, float]],
        handedness: str,
        timestamp: float,
    ) -> None:
        self.raw = raw
        self.handedness = handedness
        self.timestamp = timestamp

    # ── Core access ──────────────────────────────────────────────────────────

    def pt(self, idx: int) -> Point3D:
        p = self.raw[idx]
        return Point3D(p["x"], p["y"], p["z"])

    # ── Finger state helpers ──────────────────────────────────────────────────

    def finger_extended(self, tip: int, pip: int, mcp: int) -> bool:
        """True when tip.y < pip.y < mcp.y  (smaller y = higher on screen)."""
        t = self.pt(tip)
        p = self.pt(pip)
        m = self.pt(mcp)
        return t.y < p.y < m.y

    def thumb_extended_up(self) -> bool:
        tip = self.pt(THUMB_TIP)
        mcp = self.pt(THUMB_MCP)
        wrist = self.pt(WRIST)
        return (tip.y < mcp.y - 0.04) and (tip.y < wrist.y)

    def thumb_extended_down(self) -> bool:
        tip = self.pt(THUMB_TIP)
        mcp = self.pt(THUMB_MCP)
        wrist = self.pt(WRIST)
        return (tip.y > mcp.y + 0.04) and (tip.y > wrist.y)

    def count_extended_fingers(self) -> int:
        """Count index through pinky (0–4); thumb excluded."""
        return sum(
            1 for tip, pip, mcp in _FINGERS if self.finger_extended(tip, pip, mcp)
        )

    def wrist_position(self) -> Tuple[float, float]:
        w = self.pt(WRIST)
        return (w.x, w.y)


# ─────────────────────────────────────────────────────────────────────────────
# SwipeDetector
# ─────────────────────────────────────────────────────────────────────────────

class SwipeDetector:
    """
    Maintains a sliding window of (timestamp, wrist_x) pairs.
    Fires "RIGHT" or "LEFT" when |delta_x| >= SWIPE_THRESHOLD
    within SWIPE_WINDOW seconds. Enforces a SWIPE_COOLDOWN between fires.
    """

    def __init__(self) -> None:
        self._window: Deque[Tuple[float, float]] = deque()
        self._last_fire: float = 0.0

    def update(self, x: float, t: float) -> Optional[str]:
        # ── Prune entries older than the sliding window ───────────────────
        cutoff = t - config.SWIPE_WINDOW
        while self._window and self._window[0][0] < cutoff:
            self._window.popleft()

        self._window.append((t, x))

        if len(self._window) < 2:
            return None

        # ── Cooldown guard ────────────────────────────────────────────────
        if t - self._last_fire < config.SWIPE_COOLDOWN:
            return None

        oldest_x = self._window[0][1]
        delta_x = x - oldest_x

        if abs(delta_x) >= config.SWIPE_THRESHOLD:
            direction = "RIGHT" if delta_x > 0 else "LEFT"
            self._last_fire = t
            self._window.clear()
            return direction

        return None


# ─────────────────────────────────────────────────────────────────────────────
# GestureEngine
# ─────────────────────────────────────────────────────────────────────────────

_IDLE_STATE: Dict = {
    "gesture": "IDLE",
    "confidence": 0.0,
    "fingers": 0,
    "hand": "Unknown",
    "wrist": {"x": 0.0, "y": 0.0},
    "landmarks": [],
    "timestamp": 0.0,
}


class GestureEngine:
    """
    Stateful gesture classifier.

    Priority inside process():
      1. Swipe detection  (NEXT/PREV/SEEK)
      2. Static classification (VOLUME_UP/DOWN, PLAY_PAUSE, MUTE)
    """

    def __init__(self) -> None:
        self._swipe = SwipeDetector()
        self._last_state: Dict = dict(_IDLE_STATE)

        # Hold-timer state
        self._hold_gesture: Optional[str] = None   # gesture being held
        self._hold_start: float = 0.0

        # Cooldown tracker
        self._last_fired_gesture: Optional[str] = None
        self._last_fired_time: float = 0.0

    # ── Public API ────────────────────────────────────────────────────────────

    def process(self, landmarks: List[Dict], handedness: str) -> Dict:
        now = time.time()
        hl = HandLandmarks(landmarks, handedness, now)

        fingers = hl.count_extended_fingers()
        thumb_up = hl.thumb_extended_up()
        thumb_down = hl.thumb_extended_down()
        wx, wy = hl.wrist_position()

        # ── Base shell ───────────────────────────────────────────────────────
        base = {
            "fingers": fingers,
            "hand": handedness,
            "wrist": {"x": wx, "y": wy},
            "landmarks": landmarks,
            "timestamp": now,
        }

        # ── 1. Swipe detection ────────────────────────────────────────────────
        swipe = self._swipe.update(wx, now)
        if swipe is not None:
            gesture = self._resolve_swipe(swipe, fingers)
            self._reset_hold()
            return self._emit(gesture, 1.0, base)

        # ── 2. Static classification ──────────────────────────────────────────
        gesture_candidate, required_hold = self._classify_static(
            thumb_up, thumb_down, fingers
        )

        if gesture_candidate == "IDLE":
            self._reset_hold()
            return self._emit("IDLE", 0.0, base)

        # Instant gestures (no hold required)
        if required_hold == 0.0:
            self._reset_hold()
            return self._emit(gesture_candidate, 1.0, base)

        # Hold gestures
        if self._hold_gesture != gesture_candidate:
            # New hold — start timer
            self._hold_gesture = gesture_candidate
            self._hold_start = now
            # Return IDLE on first frame
            return self._emit("IDLE", 0.0, base)

        elapsed = now - self._hold_start
        confidence = min(elapsed / required_hold, 1.0)

        if elapsed >= required_hold:
            self._reset_hold()
            return self._emit(gesture_candidate, confidence, base)
        else:
            # Pending — report progress without cooldown gating
            pending_state = {
                "gesture": f"PENDING_{gesture_candidate}",
                "confidence": confidence,
                **base,
            }
            self._last_state = pending_state
            return pending_state

    def process_no_hand(self) -> Dict:
        """Called when no hand is detected in the frame."""
        self._reset_hold()
        idle = {
            **_IDLE_STATE,
            "timestamp": time.time(),
        }
        self._last_state = idle
        return idle

    def get_current_state(self) -> Dict:
        return self._last_state

    # ── Private helpers ───────────────────────────────────────────────────────

    def _classify_static(
        self, thumb_up: bool, thumb_down: bool, fingers: int
    ) -> Tuple[str, float]:
        """Returns (gesture_name, hold_seconds). hold=0 means instant."""
        if thumb_up and fingers == 0:
            return ("VOLUME_UP", 0.0)
        if thumb_down and fingers == 0:
            return ("VOLUME_DOWN", 0.0)
        if fingers == 4:
            return ("PLAY_PAUSE", config.HOLD_PLAY_PAUSE)
        if fingers == 0 and not thumb_up and not thumb_down:
            return ("MUTE", config.HOLD_MUTE)
        return ("IDLE", 0.0)

    @staticmethod
    def _resolve_swipe(direction: str, fingers: int) -> str:
        """Map swipe direction + finger count → gesture name."""
        if fingers == 2:
            return "SEEK_FORWARD" if direction == "RIGHT" else "SEEK_BACKWARD"
        return "NEXT_TRACK" if direction == "RIGHT" else "PREV_TRACK"

    def _emit(self, gesture: str, confidence: float, base: Dict) -> Dict:
        """Apply cooldown, build state dict, persist and return."""
        now = base["timestamp"]

        # Cooldown check for non-IDLE, non-PENDING gestures
        if (
            gesture not in ("IDLE",)
            and not gesture.startswith("PENDING_")
            and gesture == self._last_fired_gesture
            and (now - self._last_fired_time) < config.GESTURE_COOLDOWN
        ):
            # Suppress — return IDLE
            idle = {"gesture": "IDLE", "confidence": 0.0, **base}
            self._last_state = idle
            return idle

        if gesture not in ("IDLE",) and not gesture.startswith("PENDING_"):
            self._last_fired_gesture = gesture
            self._last_fired_time = now

        state = {"gesture": gesture, "confidence": confidence, **base}
        self._last_state = state
        return state

    def _reset_hold(self) -> None:
        self._hold_gesture = None
        self._hold_start = 0.0
