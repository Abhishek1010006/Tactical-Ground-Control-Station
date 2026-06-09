# ==============================================================================
# api_server/server.py — Flask App Factory and Waitress Server Runner
# ==============================================================================
# This module is responsible for:
#   1. Creating and configuring the Flask application (create_app).
#   2. Registering all route blueprints (function, map, terminal routes).
#   3. Installing the terminal tee (stdout/stderr mirroring to the UI).
#   4. Starting background tasks (heartbeat loop) and initialising MBTiles.
#   5. Running the app on Waitress (production WSGI server) at port 5000.
# ==============================================================================

from flask import Flask
from flask_cors import CORS
from waitress import serve

from .function import register_function_routes
from .map import init_mbtiles, register_map_routes
from .shared import install_terminal_tee, start_background_tasks
from .terminal import register_terminal_routes


# --- Flask Application Factory ---
def create_app():
    """Build and configure the Flask application with all route modules."""
    install_terminal_tee()
    app = Flask(__name__)
    CORS(app)

    # Register route groups
    register_function_routes(app)    # Drone commands, connection, mission state
    register_map_routes(app)         # Offline/online tile serving and management
    register_terminal_routes(app)    # Terminal clear and health endpoints
    return app


# --- Production Server Runner ---
def run():
    """Create the app and serve it with Waitress on port 5000."""
    app = create_app()
    start_background_tasks()
    init_mbtiles()

    # Startup banner
    print("=" * 40, flush=True)
    print("SwarmGCS API server ready on http://127.0.0.1:5000", flush=True)
    print("Map routes are in api_server/map.py", flush=True)
    print("Drone/button routes are in api_server/function.py", flush=True)
    print("Click CONNECT in the UI to start MAVLink link-up.", flush=True)
    print("=" * 40, flush=True)

    serve(app, host="127.0.0.1", port=5000, threads=8)
