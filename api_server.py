# ==============================================================================
# api_server.py — Root Launcher for the SwarmGCS API Server
# ==============================================================================
# This is the entry point script that starts the modular Flask-based API server.
# It imports the 'run' function from the api_server package (api_server/server.py)
# and launches the Waitress production WSGI server on http://127.0.0.1:5000.
#
# Usage:
#   python api_server.py
#   (or via Start_Backend.bat)
# ==============================================================================

from api_server.server import run


# --- Application Entry Point ---
if __name__ == "__main__":
    run()
