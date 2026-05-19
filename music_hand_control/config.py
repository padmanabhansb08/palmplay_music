"""
config.py — All configuration values, read from environment variables with defaults.
"""

import os


def _float(key: str, default: float) -> float:
    return float(os.environ.get(key, default))


def _int(key: str, default: int) -> int:
    return int(os.environ.get(key, default))


def _str(key: str, default: str) -> str:
    return os.environ.get(key, default)


# ── Server ──────────────────────────────────────────────────────────────────
HOST: str = _str("HOST", "0.0.0.0")
PORT: int = _int("PORT", 8000)

# ── Camera ───────────────────────────────────────────────────────────────────
CAMERA_INDEX: int = _int("CAMERA_INDEX", 0)
TARGET_FPS: int = _int("TARGET_FPS", 30)
FRAME_WIDTH: int = _int("FRAME_WIDTH", 640)
FRAME_HEIGHT: int = _int("FRAME_HEIGHT", 480)

# ── MediaPipe ────────────────────────────────────────────────────────────────
MP_MAX_HANDS: int = _int("MP_MAX_HANDS", 1)
MP_DET_CONF: float = _float("MP_DET_CONF", 0.65)
MP_TRACK_CONF: float = _float("MP_TRACK_CONF", 0.55)
MP_COMPLEXITY: int = _int("MP_COMPLEXITY", 1)

# ── Swipe Detection ──────────────────────────────────────────────────────────
SWIPE_WINDOW: float = _float("SWIPE_WINDOW", 0.35)       # seconds of history to keep
SWIPE_THRESHOLD: float = _float("SWIPE_THRESHOLD", 0.20)  # normalised-coordinate delta
SWIPE_COOLDOWN: float = _float("SWIPE_COOLDOWN", 0.80)   # seconds between swipes

# ── Gesture Timing ────────────────────────────────────────────────────────────
GESTURE_COOLDOWN: float = _float("GESTURE_COOLDOWN", 1.0)  # same gesture re-fire guard
HOLD_PLAY_PAUSE: float = _float("HOLD_PLAY_PAUSE", 0.5)    # seconds to hold open palm
HOLD_MUTE: float = _float("HOLD_MUTE", 0.6)                # seconds to hold fist
