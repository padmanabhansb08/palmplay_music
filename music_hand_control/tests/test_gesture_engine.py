"""
tests/test_gesture_engine.py

All 20 tests covering HandLandmarks, SwipeDetector, and GestureEngine.
Run with: pytest tests/ -v
"""

from __future__ import annotations

import sys
import os
import time as real_time
from typing import Dict, List
from unittest.mock import patch, MagicMock

import pytest

# ── Make the parent package importable from tests/ ────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from gesture_engine import (
    GestureEngine,
    HandLandmarks,
    SwipeDetector,
    WRIST,
    THUMB_MCP,
    THUMB_TIP,
    INDEX_MCP,
    INDEX_PIP,
    INDEX_TIP,
    MIDDLE_MCP,
    MIDDLE_PIP,
    MIDDLE_TIP,
    RING_MCP,
    RING_PIP,
    RING_TIP,
    PINKY_MCP,
    PINKY_PIP,
    PINKY_TIP,
)


# ─────────────────────────────────────────────────────────────────────────────
# Landmark fixture helpers
# ─────────────────────────────────────────────────────────────────────────────

def _base_landmarks() -> List[Dict]:
    """21 neutral points at (0.5, 0.5, 0.0)."""
    return [{"x": 0.5, "y": 0.5, "z": 0.0} for _ in range(21)]


def _open_palm_landmarks() -> List[Dict]:
    """
    Wrist at y=0.80.
    Each finger: mcp=0.65, pip=0.50, tip=0.35 → all four fingers extended.
    Thumb neutral (not up, not down).
    """
    lms = _base_landmarks()
    # Wrist
    lms[WRIST] = {"x": 0.5, "y": 0.80, "z": 0.0}

    # Thumb — keep it neutral (won't trigger thumb_up or thumb_down)
    lms[THUMB_MCP] = {"x": 0.5, "y": 0.70, "z": 0.0}
    lms[THUMB_TIP] = {"x": 0.5, "y": 0.68, "z": 0.0}   # tip < mcp − 0.04? no. neutral.

    # Index
    lms[INDEX_MCP] = {"x": 0.5, "y": 0.65, "z": 0.0}
    lms[INDEX_PIP] = {"x": 0.5, "y": 0.50, "z": 0.0}
    lms[INDEX_TIP] = {"x": 0.5, "y": 0.35, "z": 0.0}

    # Middle
    lms[MIDDLE_MCP] = {"x": 0.5, "y": 0.65, "z": 0.0}
    lms[MIDDLE_PIP] = {"x": 0.5, "y": 0.50, "z": 0.0}
    lms[MIDDLE_TIP] = {"x": 0.5, "y": 0.35, "z": 0.0}

    # Ring
    lms[RING_MCP] = {"x": 0.5, "y": 0.65, "z": 0.0}
    lms[RING_PIP] = {"x": 0.5, "y": 0.50, "z": 0.0}
    lms[RING_TIP] = {"x": 0.5, "y": 0.35, "z": 0.0}

    # Pinky
    lms[PINKY_MCP] = {"x": 0.5, "y": 0.65, "z": 0.0}
    lms[PINKY_PIP] = {"x": 0.5, "y": 0.50, "z": 0.0}
    lms[PINKY_TIP] = {"x": 0.5, "y": 0.35, "z": 0.0}

    return lms


def _fist_landmarks() -> List[Dict]:
    """
    All fingers curled: mcp=0.40, pip=0.55, tip=0.65
    (tip.y > pip.y > mcp.y → not extended).
    Thumb neutral.
    """
    lms = _base_landmarks()
    lms[WRIST] = {"x": 0.5, "y": 0.80, "z": 0.0}

    # Thumb — neutral (not up, not down)
    lms[THUMB_MCP] = {"x": 0.5, "y": 0.60, "z": 0.0}
    lms[THUMB_TIP] = {"x": 0.5, "y": 0.58, "z": 0.0}

    # Fingers curled
    for mcp_i, pip_i, tip_i in [
        (INDEX_MCP,  INDEX_PIP,  INDEX_TIP),
        (MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP),
        (RING_MCP,   RING_PIP,   RING_TIP),
        (PINKY_MCP,  PINKY_PIP,  PINKY_TIP),
    ]:
        lms[mcp_i] = {"x": 0.5, "y": 0.40, "z": 0.0}
        lms[pip_i] = {"x": 0.5, "y": 0.55, "z": 0.0}
        lms[tip_i] = {"x": 0.5, "y": 0.65, "z": 0.0}

    return lms


def _thumb_up_landmarks() -> List[Dict]:
    """
    Fist base + wrist.y=0.80, THUMB_MCP.y=0.60, THUMB_TIP.y=0.40
    → tip.y (0.40) < mcp.y (0.60) − 0.04 = 0.56 ✓
    → tip.y (0.40) < wrist.y (0.80) ✓
    """
    lms = _fist_landmarks()
    lms[WRIST]     = {"x": 0.5, "y": 0.80, "z": 0.0}
    lms[THUMB_MCP] = {"x": 0.5, "y": 0.60, "z": 0.0}
    lms[THUMB_TIP] = {"x": 0.5, "y": 0.40, "z": 0.0}
    return lms


def _thumb_down_landmarks() -> List[Dict]:
    """
    Fist base + wrist.y=0.20, THUMB_MCP.y=0.35, THUMB_TIP.y=0.55
    → tip.y (0.55) > mcp.y (0.35) + 0.04 = 0.39 ✓
    → tip.y (0.55) > wrist.y (0.20) ✓
    """
    lms = _fist_landmarks()
    lms[WRIST]     = {"x": 0.5, "y": 0.20, "z": 0.0}
    lms[THUMB_MCP] = {"x": 0.5, "y": 0.35, "z": 0.0}
    lms[THUMB_TIP] = {"x": 0.5, "y": 0.55, "z": 0.0}
    # Keep fingers curled — re-apply (fist_landmarks already sets them)
    return lms


# ─────────────────────────────────────────────────────────────────────────────
# TestHandLandmarks (6 tests)
# ─────────────────────────────────────────────────────────────────────────────

class TestHandLandmarks:

    def _make(self, raw) -> HandLandmarks:
        return HandLandmarks(raw, "Right", real_time.time())

    # 1 ── finger_extended True
    def test_finger_extended_true(self):
        lms = _base_landmarks()
        lms[INDEX_TIP] = {"x": 0.5, "y": 0.30, "z": 0.0}
        lms[INDEX_PIP] = {"x": 0.5, "y": 0.50, "z": 0.0}
        lms[INDEX_MCP] = {"x": 0.5, "y": 0.70, "z": 0.0}
        hl = self._make(lms)
        assert hl.finger_extended(INDEX_TIP, INDEX_PIP, INDEX_MCP) is True

    # 2 ── finger curled
    def test_finger_curled(self):
        lms = _base_landmarks()
        lms[INDEX_TIP] = {"x": 0.5, "y": 0.70, "z": 0.0}
        lms[INDEX_PIP] = {"x": 0.5, "y": 0.55, "z": 0.0}
        lms[INDEX_MCP] = {"x": 0.5, "y": 0.40, "z": 0.0}
        hl = self._make(lms)
        assert hl.finger_extended(INDEX_TIP, INDEX_PIP, INDEX_MCP) is False

    # 3 ── count_extended open palm → 4
    def test_count_extended_open_palm(self):
        hl = self._make(_open_palm_landmarks())
        assert hl.count_extended_fingers() == 4

    # 4 ── count_extended fist → 0
    def test_count_extended_fist(self):
        hl = self._make(_fist_landmarks())
        assert hl.count_extended_fingers() == 0

    # 5 ── thumb_up
    def test_thumb_up(self):
        hl_up   = self._make(_thumb_up_landmarks())
        hl_down = self._make(_thumb_down_landmarks())
        assert hl_up.thumb_extended_up()   is True
        assert hl_down.thumb_extended_up() is False

    # 6 ── thumb_down
    def test_thumb_down(self):
        hl_down = self._make(_thumb_down_landmarks())
        hl_up   = self._make(_thumb_up_landmarks())
        assert hl_down.thumb_extended_down() is True
        assert hl_up.thumb_extended_down()   is False


# ─────────────────────────────────────────────────────────────────────────────
# TestSwipeDetector (4 tests)
# ─────────────────────────────────────────────────────────────────────────────

class TestSwipeDetector:

    # 7 ── right swipe
    def test_right_swipe(self):
        det = SwipeDetector()
        t0 = 1000.0
        result = None
        xs = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35]
        for i, x in enumerate(xs):
            r = det.update(x, t0 + i * 0.05)
            if r is not None and result is None:
                result = r
        assert result == "RIGHT"

    # 8 ── left swipe
    def test_left_swipe(self):
        det = SwipeDetector()
        t0 = 2000.0
        result = None
        xs = [0.90, 0.80, 0.70, 0.60, 0.55]
        for i, x in enumerate(xs):
            r = det.update(x, t0 + i * 0.05)
            if r is not None and result is None:
                result = r
        assert result == "LEFT"

    # 9 ── no swipe on small movement
    def test_no_swipe_small_movement(self):
        det = SwipeDetector()
        t0 = 3000.0
        results = [det.update(0.50 + i * 0.01, t0 + i * 0.05) for i in range(10)]
        assert all(r is None for r in results)

    # 10 ── cooldown prevents immediate repeat
    def test_cooldown_prevents_immediate_repeat(self):
        det = SwipeDetector()
        t0 = 4000.0
        # First swipe: fire
        first = None
        for i, x in enumerate([0.10, 0.15, 0.20, 0.25, 0.30, 0.35]):
            r = det.update(x, t0 + i * 0.05)
            if r is not None and first is None:
                first = r
        assert first == "RIGHT"

        # Second swipe 0.3 s later — within cooldown (0.8 s)
        t1 = t0 + 0.3
        second = None
        for i, x in enumerate([0.10, 0.15, 0.20, 0.25, 0.30, 0.35]):
            r = det.update(x, t1 + i * 0.05)
            if r is not None and second is None:
                second = r
        assert second is None


# ─────────────────────────────────────────────────────────────────────────────
# TestGestureEngine (10 tests)
# ─────────────────────────────────────────────────────────────────────────────

class TestGestureEngine:

    # 11 ── no hand → IDLE
    def test_no_hand_returns_idle(self):
        engine = GestureEngine()
        state = engine.process_no_hand()
        assert state["gesture"] == "IDLE"
        assert state["confidence"] == 0.0

    # 12 ── thumb up → VOLUME_UP (instant)
    def test_volume_up_instant(self):
        engine = GestureEngine()
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 5000.0
            state = engine.process(_thumb_up_landmarks(), "Right")
        assert state["gesture"] == "VOLUME_UP"

    # 13 ── thumb down → VOLUME_DOWN (instant)
    def test_volume_down_instant(self):
        engine = GestureEngine()
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 5000.0
            state = engine.process(_thumb_down_landmarks(), "Right")
        assert state["gesture"] == "VOLUME_DOWN"

    # 14 ── open palm first frame → not PLAY_PAUSE yet
    def test_play_pause_requires_hold(self):
        engine = GestureEngine()
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 6000.0
            state = engine.process(_open_palm_landmarks(), "Right")
        assert state["gesture"] in ("IDLE", "PENDING_PLAY_PAUSE")

    # 15 ── open palm held 0.6 s → PLAY_PAUSE fires
    def test_play_pause_fires_after_hold(self):
        engine = GestureEngine()
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 1000.0
            engine.process(_open_palm_landmarks(), "Right")   # start hold
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 1000.6
            state = engine.process(_open_palm_landmarks(), "Right")
        assert state["gesture"] == "PLAY_PAUSE"
        assert state["confidence"] >= 0.9

    # 16 ── fist first frame → not MUTE yet
    def test_mute_requires_hold(self):
        engine = GestureEngine()
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 7000.0
            state = engine.process(_fist_landmarks(), "Right")
        assert state["gesture"] != "MUTE"

    # 17 ── fist held 0.7 s → MUTE fires
    def test_mute_fires_after_hold(self):
        engine = GestureEngine()
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 2000.0
            engine.process(_fist_landmarks(), "Right")   # start hold
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 2000.7
            state = engine.process(_fist_landmarks(), "Right")
        assert state["gesture"] == "MUTE"

    # 18 ── cooldown prevents duplicate VOLUME_UP within 1 s
    def test_gesture_cooldown(self):
        engine = GestureEngine()
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 3000.0
            state1 = engine.process(_thumb_up_landmarks(), "Right")
        assert state1["gesture"] == "VOLUME_UP"

        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 3000.3   # 0.3 s later — within 1.0 s cooldown
            state2 = engine.process(_thumb_up_landmarks(), "Right")
        assert state2["gesture"] == "IDLE"

    # 19 ── state contains all required keys
    def test_state_contains_required_keys(self):
        engine = GestureEngine()
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 4000.0
            state = engine.process(_open_palm_landmarks(), "Right")
        for key in ("gesture", "confidence", "timestamp", "fingers", "hand"):
            assert key in state, f"Missing key: {key}"

    # 20 ── handedness is recorded
    def test_handedness_recorded(self):
        engine = GestureEngine()
        with patch("gesture_engine.time") as mock_t:
            mock_t.time.return_value = 5000.0
            state = engine.process(_open_palm_landmarks(), "Left")
        assert state["hand"] == "Left"
