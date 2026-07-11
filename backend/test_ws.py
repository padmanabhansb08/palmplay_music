import asyncio
import websockets
import json

async def test_websocket():
    url = "wss://palmplay-music.onrender.com/ws/gesture"
    try:
        async with websockets.connect(url, open_timeout=60) as ws:
            print("WebSocket Connection Successful!")
            print("Handshake complete. Backend is ready for frames.")
            return True
    except Exception as e:
        print("Connection Failed: " + str(e))
        return False

if __name__ == "__main__":
    asyncio.run(test_websocket())
