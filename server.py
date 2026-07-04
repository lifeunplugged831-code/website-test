import asyncio
import json
import logging
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import websockets

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("SyncForgeServer")

# Global canvas state
canvas_state = {
    "nodes": {},       # Map of node_id -> node_data
    "connections": []  # List of connections: { id, fromNode, fromPort, toNode, toPort }
}

# Connected clients set
connected_clients = set()

# Lock for canvas state updates
state_lock = threading.Lock()

class SPAHTTPRequestHandler(SimpleHTTPRequestHandler):
    """
    HTTP Request Handler that supports serving index.html for SPA paths
    and correctly configures cache control for local development.
    """
    def end_headers(self):
        # Disable cache for development
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        # If file doesn't exist, fall back to index.html (useful for SPAs, though we are mostly single page)
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not path.endswith("/"):
            self.path = "/index.html"
        return super().do_GET()

def start_http_server(port=8000):
    """Starts the static HTTP server in a separate thread."""
    server_address = ("", port)
    # Serve files from the current directory
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    httpd = ThreadingHTTPServer(server_address, SPAHTTPRequestHandler)
    logger.info(f"HTTP Server running on http://localhost:{port}")
    try:
        httpd.serve_forever()
    except Exception as e:
        logger.error(f"HTTP Server error: {e}")

async def broadcast(message, exclude=None):
    """Broadcasts a message to all connected WebSocket clients except 'exclude'."""
    if not connected_clients:
        return
    
    # Create copy of list to avoid issues if set size changes during iteration
    clients = list(connected_clients)
    payload = json.dumps(message)
    
    tasks = []
    for client in clients:
        if client != exclude:
            tasks.append(asyncio.create_task(send_message(client, payload)))
            
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

async def send_message(client, payload):
    try:
        await client.send(payload)
    except websockets.exceptions.ConnectionClosed:
        connected_clients.discard(client)
    except Exception as e:
        logger.error(f"Failed to send to client: {e}")

async def handle_websocket(websocket, path):
    """Handles individual WebSocket connections."""
    connected_clients.add(websocket)
    logger.info(f"Client connected. Total clients: {len(connected_clients)}")
    
    try:
        # On connection, send the initial canvas state
        await websocket.send(json.dumps({
            "type": "init",
            "state": canvas_state
        }))
        
        async for message_str in websocket:
            try:
                message = json.loads(message_str)
                msg_type = message.get("type")
                
                if msg_type == "state_update":
                    # Update global state with locking
                    with state_lock:
                        new_state = message.get("state", {})
                        if "nodes" in new_state:
                            canvas_state["nodes"] = new_state["nodes"]
                        if "connections" in new_state:
                            canvas_state["connections"] = new_state["connections"]
                    
                    # Broadcast state update to all OTHER clients
                    await broadcast({
                        "type": "state_update",
                        "state": canvas_state
                    }, exclude=websocket)
                    
                elif msg_type == "cursor_move":
                    # Broadcast cursor positions to all OTHER clients (ephemeral)
                    await broadcast({
                        "type": "cursor_move",
                        "userId": message.get("userId"),
                        "userName": message.get("userName"),
                        "color": message.get("color"),
                        "x": message.get("x"),
                        "y": message.get("y")
                    }, exclude=websocket)
                    
                elif msg_type == "ping":
                    # Broadcast ping ripples (ephemeral)
                    await broadcast({
                        "type": "ping",
                        "x": message.get("x"),
                        "y": message.get("y"),
                        "color": message.get("color")
                    }, exclude=websocket)
                    
                elif msg_type == "traffic_inject":
                    # Broadcast traffic injection events (start of load tests)
                    await broadcast({
                        "type": "traffic_inject",
                        "nodeId": message.get("nodeId"),
                        "rps": message.get("rps"),
                        "payloadSize": message.get("payloadSize")
                    }, exclude=websocket)
                    
                elif msg_type == "chaos_event":
                    # Broadcast chaos engineering triggers
                    await broadcast({
                        "type": "chaos_event",
                        "eventType": message.get("eventType"),
                        "targetId": message.get("targetId"),
                        "description": message.get("description")
                    }, exclude=websocket)

            except json.JSONDecodeError:
                logger.warning("Received invalid JSON payload")
            except Exception as e:
                logger.error(f"Error handling message: {e}")
                
    except websockets.exceptions.ConnectionClosedOK:
        logger.info("Client disconnected normally")
    except websockets.exceptions.ConnectionClosedError:
        logger.info("Client disconnected abruptly")
    finally:
        connected_clients.discard(websocket)
        logger.info(f"Client removed. Total clients: {len(connected_clients)}")

async def main():
    # Allow checking files without running by passing --check
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        print("Server code syntax is valid.")
        return

    # Start HTTP server in a background thread
    http_thread = threading.Thread(target=start_http_server, args=(8000,), daemon=True)
    http_thread.start()
    
    # Start WebSocket server
    logger.info("Starting WebSocket Server on ws://localhost:8001...")
    async with websockets.serve(handle_websocket, "0.0.0.0", 8001):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server shutting down.")
