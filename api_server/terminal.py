# ==============================================================================
# api_server/terminal.py — Terminal Management API Routes
# ==============================================================================
# Provides endpoints for managing the in-app terminal output panel:
#
#   POST /terminal/clear   — Clears all buffered terminal lines.
#   GET  /terminal/health  — Simple health check for the terminal subsystem.
#
# The actual terminal log retrieval and SSE streaming endpoints are in
# function.py (/terminal/logs and /terminal/stream).
# ==============================================================================

from flask import jsonify
from . import shared


def register_terminal_routes(app):
    """Register terminal management endpoints on the Flask app."""

    # --- Clear Terminal Buffer ---
    @app.route("/terminal/clear", methods=["POST"])
    def terminal_clear():
        """Clear all lines from the terminal output buffer."""
        with shared.terminal_lock:
            shared.terminal_lines.clear()
        return jsonify({"status": "ok", "message": "Terminal cleared"})

    # --- Terminal Health Check ---
    @app.route("/terminal/health")
    def terminal_health():
        """Return a simple OK status for the terminal subsystem."""
        return jsonify({"status": "ok"})
