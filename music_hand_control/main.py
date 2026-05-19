"""
main.py — FastAPI application entry-point.

Routes:
  GET  /health             → server & camera health
  GET  /gesture/current    → latest gesture state
  POST /camera/restart     → hot-restart the camera thread
  WS   /ws/gestures        → real-time gesture event stream
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any, Dict, Set

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import config
from camera import CameraManager
from gesture_engine import GestureEngine

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")
logger = logging.getLogger("main")

# ── Shared state ──────────────────────────────────────────────────────────────
_active_sockets: Set[WebSocket] = set()
gesture_engine: GestureEngine
camera_manager: CameraManager


# ── Broadcast helper ──────────────────────────────────────────────────────────

async def broadcast(payload: Dict[str, Any]) -> None:
    """Send *payload* to every connected WebSocket; silently drop dead ones."""
    dead: Set[WebSocket] = set()
    for ws in list(_active_sockets):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.add(ws)
    _active_sockets.difference_update(dead)
    if dead:
        logger.info("Removed %d dead WebSocket(s). Active: %d", len(dead), len(_active_sockets))


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global gesture_engine, camera_manager

    gesture_engine = GestureEngine()
    camera_manager = CameraManager(
        camera_index=config.CAMERA_INDEX,
        target_fps=config.TARGET_FPS,
        gesture_engine=gesture_engine,
    )

    loop = asyncio.get_event_loop()
    camera_manager.register_broadcast_callback(broadcast, loop)
    camera_manager.start()
    logger.info("Application started — camera running: %s", camera_manager.is_running)

    yield

    camera_manager.stop()
    logger.info("Application shutdown complete.")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Music Hand Control",
    description="Real-time hand gesture → music player command bridge.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── REST endpoints ────────────────────────────────────────────────────────────

@app.get("/health", tags=["system"])
async def health_check() -> Dict[str, Any]:
    return {
        "status": "ok",
        "camera_running": camera_manager.is_running,
        "connected_clients": len(_active_sockets),
    }


@app.get("/gesture/current", tags=["gesture"])
async def get_current_gesture() -> Dict[str, Any]:
    return gesture_engine.get_current_state()


@app.post("/camera/restart", tags=["camera"])
async def restart_camera() -> Dict[str, Any]:
    logger.info("Camera restart requested.")
    camera_manager.stop()
    await asyncio.sleep(0.5)  # let the thread wind down

    loop = asyncio.get_event_loop()
    camera_manager.register_broadcast_callback(broadcast, loop)
    camera_manager.start()
    return {
        "status": "restarted",
        "camera_running": camera_manager.is_running,
    }


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@app.websocket("/ws/gestures")
async def websocket_gestures(websocket: WebSocket):
    await websocket.accept()
    _active_sockets.add(websocket)
    logger.info(
        "WebSocket connected. Active clients: %d", len(_active_sockets)
    )

    try:
        while True:
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(), timeout=30.0
                )
                try:
                    msg = json.loads(raw)
                    if msg.get("action") == "ping":
                        await websocket.send_json({"type": "pong"})
                except (json.JSONDecodeError, AttributeError):
                    pass  # ignore malformed messages

            except asyncio.TimeoutError:
                # Send heartbeat to keep connection alive
                await websocket.send_json({"type": "heartbeat"})

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected.")
    except Exception as exc:
        logger.warning("WebSocket error: %s", exc)
    finally:
        _active_sockets.discard(websocket)
        logger.info(
            "WebSocket removed. Active clients: %d", len(_active_sockets)
        )


# ── Dev runner ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=config.HOST,
        port=config.PORT,
        reload=True,
    )
