# ==============================================================================
# api_server/function.py — Core API Routes (Drone Commands, Mission, Terminal)
# ==============================================================================
# This module registers the main REST endpoints consumed by the Electron UI:
#
#   Terminal & Streaming:
#     GET  /terminal/logs    — Return buffered terminal log lines as JSON.
#     GET  /terminal/stream  — Server-Sent Events (SSE) stream of live terminal output.
#
#   Health & Connection:
#     GET  /health           — Backend health check (connection status, drone count).
#     POST /connect          — Auto-detect and connect to MAVLink drones via TCP.
#
#   Telemetry & Mission State:
#     GET  /state            — Current telemetry state for all drones.
#     GET  /mission          — Current mission configuration (surveillance, attack, targets).
#
#   Operating Mode & Roles:
#     POST /mode             — Set operating mode to 'swarm' or 'attack'.
#     POST /roles            — Assign surveillance and attack drone roles.
#
#   Attack Operations:
#     POST /attack           — Launch an attack drone at the surveillance drone's position.
#     POST /target           — Send an attack drone to a manually specified GPS coordinate.
#     POST /attack_alt       — Set the altitude for attack missions.
#
#   Individual Drone Commands:
#     POST /command          — Send arm/disarm/takeoff/land/goto/drop/rtl/set_mode to a drone.
# ==============================================================================

from flask import Response, jsonify, request
from queue import Empty, Queue
import json
import threading
import time

from . import shared


def register_function_routes(app):
    """Register all core API endpoints on the Flask app."""

    # =========================================================================
    # SECTION: Terminal Logs & Live Streaming
    # =========================================================================

    @app.route("/terminal/logs")
    def terminal_logs():
        """Return all buffered terminal lines as a JSON array."""
        with shared.terminal_lock:
            lines = list(shared.terminal_lines)
        return jsonify({"lines": lines})

    @app.route("/terminal/stream")
    def terminal_stream():
        """SSE endpoint — streams terminal output to the UI in real time."""
        def generate():
            # First, send any existing buffered lines as a snapshot
            with shared.terminal_lock:
                snapshot = list(shared.terminal_lines)
            for line in snapshot:
                yield f"data: {json.dumps({'line': line}, ensure_ascii=False)}\n\n"

            # Then subscribe to new lines via a per-client queue
            queue = Queue()
            with shared.terminal_lock:
                shared.terminal_subscribers.append(queue)
            try:
                while True:
                    try:
                        line = queue.get(timeout=25)
                        yield f"data: {json.dumps({'line': line}, ensure_ascii=False)}\n\n"
                    except Empty:
                        # Send a keepalive comment to prevent the connection from timing out
                        yield ": keepalive\n\n"
            finally:
                # Unsubscribe when the client disconnects
                with shared.terminal_lock:
                    if queue in shared.terminal_subscribers:
                        shared.terminal_subscribers.remove(queue)

        response = Response(generate(), mimetype="text/event-stream")
        response.headers["Cache-Control"] = "no-cache"
        response.headers["X-Accel-Buffering"] = "no"
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    # =========================================================================
    # SECTION: Health Check
    # =========================================================================

    @app.route("/health")
    def health():
        """Return backend health status including connection state and drone count."""
        return jsonify({
            "status": "ok",
            "connected": shared.connected,
            "drone_count": len(shared.drone_manager.drones),
            "operating_mode": shared.mission_state["operating_mode"],
            "backend": "modular api_server",
        })

    # =========================================================================
    # SECTION: MAVLink Connection
    # =========================================================================

    @app.route("/connect", methods=["POST"])
    def connect():
        """Connect the UI backend to MAVLink and start telemetry listeners."""
        try:
            print("\n" + "=" * 40, flush=True)
            print("CONNECT requested from UI", flush=True)
            print("=" * 40, flush=True)

            # Auto-detect drones on TCP ports and register them
            connections = shared.auto_connect_tcp()
            for conn in connections:
                shared.drone_manager.add_connection(conn)

            # Start telemetry listener threads for any newly discovered drones
            existing_ids = {listener.drone_id for listener in shared.listeners if hasattr(listener, "drone_id")}
            for drone_id, drone in shared.drone_manager.drones.items():
                if drone_id in existing_ids:
                    continue
                listener = shared.TelemetryListener(drone.connection, drone_id, shared.state_manager)
                listener.start()
                shared.listeners.append(listener)
                print(f"Started telemetry stream for Drone {drone_id}", flush=True)

            shared.connected = True
            ids = list(shared.drone_manager.drones.keys())
            print(f"Connected drones: {ids}", flush=True)
            print("Choose SWARM or ATTACK in the top navbar.", flush=True)
            return jsonify({"connected": ids})
        except Exception as exc:
            print(f"Connection error: {exc}", flush=True)
            return jsonify({"error": str(exc)}), 500

    @app.route("/disconnect", methods=["POST"])
    def disconnect():
        """Disconnect MAVLink drones and clear active UI mission state."""
        for listener in list(shared.listeners):
            try:
                listener.stop()
            except Exception:
                pass
        shared.listeners.clear()

        for drone in list(shared.drone_manager.drones.values()):
            try:
                drone.connection.close()
            except Exception:
                pass
        shared.drone_manager.drones.clear()
        shared.state_manager._states.clear()

        shared.connected = False
        shared.mission_state.update({
            "operating_mode": None,
            "surveillance_id": None,
            "attack_ids": [],
            "attack_alt": shared.mission_state.get("attack_alt", 10),
            "active_attackers": {},
            "targets": [],
            "target_id_seq": 0,
            "_last_target_key": None,
            "_attack_reserve": [],
            "_active_attackers_list": [],
        })

        print("DISCONNECT requested from UI - MAVLink links closed.", flush=True)
        return jsonify({"status": "ok"})

    # =========================================================================
    # SECTION: Telemetry & Mission State Queries
    # =========================================================================

    @app.route("/state")
    def get_state():
        """Return the latest telemetry state for all connected drones."""
        return jsonify(shared.state_manager.get_all())

    @app.route("/mission")
    def get_mission():
        """Return the current mission configuration and active targets."""
        surv_id = shared.mission_state["surveillance_id"]
        surv_lat = surv_lon = None
        if surv_id is not None:
            surv_state = shared.state_manager.get(surv_id) or {}
            surv_lat = surv_state.get("lat")
            surv_lon = surv_state.get("lon")

        return jsonify({
            "operating_mode": shared.mission_state["operating_mode"],
            "surveillance_id": surv_id,
            "surveillance_lat": surv_lat,
            "surveillance_lon": surv_lon,
            "attack_ids": shared.mission_state["attack_ids"],
            "attack_reserve": shared.mission_state["_attack_reserve"],
            "attack_alt": shared.mission_state["attack_alt"],
            "active_attackers": shared.mission_state["active_attackers"],
            "targets": shared.mission_state["targets"],
        })

    # =========================================================================
    # SECTION: Operating Mode & Role Assignment
    # =========================================================================

    @app.route("/mode", methods=["POST"])
    def set_operating_mode():
        """Set the operating mode to 'swarm' or 'attack'."""
        data = request.json or {}
        mode = (data.get("mode") or "").strip().lower()
        if mode in ("1", "swarm"):
            mode = "swarm"
        elif mode in ("2", "attack"):
            mode = "attack"
        else:
            return jsonify({"error": "mode must be 'swarm' or 'attack'"}), 400

        if not shared.connected or len(shared.drone_manager.drones) < 2:
            return jsonify({"error": "At least 2 connected drones required"}), 400

        shared.mission_state["operating_mode"] = mode
        if mode == "swarm":
            print("\nINIT: SWARM CONFIGURATION (UI selected)", flush=True)
        else:
            print("\nINIT: PARALLEL AUTONOMOUS ATTACK SYSTEM", flush=True)
            for drone_id in shared.drone_manager.drones.keys():
                print(f" - Drone {drone_id}", flush=True)
            shared.init_attack_mode_from_roles()

        return jsonify({
            "status": "ok",
            "operating_mode": shared.mission_state["operating_mode"],
            "surveillance_id": shared.mission_state["surveillance_id"],
            "attack_ids": shared.mission_state["attack_ids"],
            "attack_reserve": shared.mission_state["_attack_reserve"],
        })

    @app.route("/roles", methods=["POST"])
    def set_roles():
        """Assign surveillance and attack drone roles."""
        data = request.json or {}
        surveillance_id = data.get("surveillance_id")
        if surveillance_id is not None:
            surveillance_id = int(surveillance_id)

        shared.mission_state["surveillance_id"] = surveillance_id
        if surveillance_id:
            shared.mission_state["attack_ids"] = [
                drone_id for drone_id in shared.drone_manager.drones.keys()
                if drone_id != surveillance_id
            ]
        else:
            shared.mission_state["attack_ids"] = []

        shared.sync_attack_reserve()
        if shared.mission_state["operating_mode"] == "attack":
            shared.init_attack_mode_from_roles()

        print(f"Roles set - surveillance: {surveillance_id}, attack: {shared.mission_state['attack_ids']}", flush=True)
        return jsonify({
            "status": "ok",
            "surveillance_id": shared.mission_state["surveillance_id"],
            "attack_ids": shared.mission_state["attack_ids"],
            "attack_reserve": shared.mission_state["_attack_reserve"],
        })

    # =========================================================================
    # SECTION: Attack Operations
    # =========================================================================

    @app.route("/attack", methods=["POST"])
    def launch_parallel_attack():
        """Launch the next available attack drone towards the surveillance drone's position."""
        if shared.mission_state["operating_mode"] != "attack":
            return jsonify({"error": "Switch to ATTACK mode first"}), 400

        surv_id = shared.mission_state["surveillance_id"]
        if surv_id is None:
            return jsonify({"error": "Select surveillance drone"}), 400
        if len(shared.drone_manager.drones) < 2:
            return jsonify({"error": "At least 2 drones required"}), 400

        shared.sync_attack_reserve()
        if not shared.mission_state["_attack_reserve"]:
            return jsonify({"error": "No attack drones available"}), 400

        # Get the surveillance drone's current GPS coordinates as the target
        surv_state = shared.state_manager.get(surv_id)
        if not surv_state or surv_state.get("lat") is None or surv_state.get("lon") is None:
            return jsonify({"error": "No GPS telemetry for surveillance drone yet"}), 400

        target_lat = float(surv_state["lat"])
        target_lon = float(surv_state["lon"])
        attack_alt = float(shared.mission_state["attack_alt"])

        # Pop the next available attack drone from the reserve queue
        attacker_id = shared.mission_state["_attack_reserve"].pop(0)
        attacker = shared.drone_manager.get_drone(attacker_id)
        if not attacker:
            shared.mission_state["_attack_reserve"].insert(0, attacker_id)
            return jsonify({"error": f"Attack drone {attacker_id} not found"}), 404

        # Create a target record for tracking
        shared.mission_state["target_id_seq"] += 1
        target_id = shared.mission_state["target_id_seq"]
        target_record = {
            "id": target_id,
            "lat": target_lat,
            "lon": target_lon,
            "alt": attack_alt,
            "time": time.time(),
            "assigned_drone": attacker_id,
            "status": "deploying",
            "source": "surveillance",
        }
        shared.mission_state["targets"].append(target_record)
        shared.mission_state["_active_attackers_list"].append(attacker_id)
        shared.mission_state["active_attackers"][attacker_id] = {
            "target_lat": target_lat,
            "target_lon": target_lon,
            "target_id": target_id,
            "status": "deploying",
        }

        print(f"Target acquired from surveillance UAV #{surv_id}: {target_lat:.6f}, {target_lon:.6f}", flush=True)

        # Deploy the drone in a background thread (GUIDED, arm, takeoff, goto)
        threading.Thread(
            target=shared.deploy_attack_drone,
            args=(attacker_id, target_lat, target_lon, attack_alt, target_id),
            daemon=True,
        ).start()

        return jsonify({
            "status": "ok",
            "target": target_record,
            "attacker_id": attacker_id,
            "surveillance_id": surv_id,
            "attack_reserve": shared.mission_state["_attack_reserve"],
        })

    @app.route("/target", methods=["POST"])
    def set_target():
        """Send an attack drone to a manually specified GPS coordinate."""
        data = request.json or {}
        lat = data.get("lat")
        lon = data.get("lon")
        alt = float(data.get("alt", shared.mission_state["attack_alt"]))
        drone_id = data.get("drone_id")
        if lat is None or lon is None:
            return jsonify({"error": "lat and lon required"}), 400

        # Auto-select the next available attack drone if none specified
        if drone_id is None:
            shared.sync_attack_reserve()
            if not shared.mission_state["_attack_reserve"]:
                return jsonify({"error": "No attack drones available"}), 400
            drone_id = shared.mission_state["_attack_reserve"].pop(0)
        else:
            drone_id = int(drone_id)

        drone = shared.drone_manager.get_drone(drone_id)
        if not drone:
            return jsonify({"error": f"Drone {drone_id} not found"}), 404

        # Create a target record for tracking
        shared.mission_state["target_id_seq"] += 1
        target_id = shared.mission_state["target_id_seq"]
        target_record = {
            "id": target_id,
            "lat": float(lat),
            "lon": float(lon),
            "alt": alt,
            "time": time.time(),
            "assigned_drone": drone_id,
            "status": "deploying",
            "source": "manual",
        }
        shared.mission_state["targets"].append(target_record)
        shared.mission_state["_active_attackers_list"].append(drone_id)
        shared.mission_state["active_attackers"][drone_id] = {
            "target_lat": float(lat),
            "target_lon": float(lon),
            "target_id": target_id,
            "status": "deploying",
        }

        # Deploy the drone in a background thread
        threading.Thread(
            target=shared.deploy_attack_drone,
            args=(drone_id, float(lat), float(lon), alt, target_id),
            daemon=True,
        ).start()
        return jsonify({"status": "ok", "target": target_record})

    @app.route("/attack_alt", methods=["POST"])
    def set_attack_alt():
        """Set the altitude used for attack missions."""
        data = request.json or {}
        alt = data.get("altitude", 10)
        shared.mission_state["attack_alt"] = float(alt)
        print(f"Attack altitude set to: {alt}m", flush=True)
        return jsonify({"status": "ok", "attack_alt": shared.mission_state["attack_alt"]})

    # =========================================================================
    # SECTION: Individual Drone Commands
    # =========================================================================

    @app.route("/command", methods=["POST"])
    def command():
        """Send a single command (arm, disarm, takeoff, land, goto, drop, rtl, set_mode) to a drone."""
        data = request.json or {}
        action = data.get("action")
        drone_id = data.get("drone_id")
        if drone_id is None:
            return jsonify({"error": "drone_id required"}), 400

        drone_id = int(drone_id)
        drone = shared.drone_manager.get_drone(drone_id)
        if not drone:
            return jsonify({"error": f"Drone {drone_id} not found"}), 404

        conn = drone.connection
        try:
            if action == "arm":
                shared.cmd.arm(conn)
            elif action == "disarm":
                shared.cmd.disarm(conn)
            elif action == "takeoff":
                shared.cmd.takeoff(conn, data.get("altitude", 5))
            elif action == "land":
                shared.cmd.land(conn)
                _finish_attacker(drone_id, "completed")
            elif action == "goto":
                shared.cmd.goto_global(conn, data["lat"], data["lon"], data.get("alt", 10))
            elif action == "drop":
                # Drop payload then automatically return to launch
                shared.cmd.drop_payload(conn)
                time.sleep(1)
                shared.cmd.rtl(conn)
                print(f"[Drone {drone_id}] -> Payload dropped. Returning home.", flush=True)
                _finish_attacker(drone_id, "completed")
            elif action == "rtl":
                shared.cmd.rtl(conn)
                print(f"[Drone {drone_id}] -> Returning to launch.", flush=True)
                _finish_attacker(drone_id, "recalled")
            elif action == "set_mode":
                shared.cmd.set_mode(conn, data["mode"])
            elif action == "loiter":
                # Legacy compat — kept for safety, not triggered by UI
                shared.cmd.set_mode(conn, 5)
                print(f"[Drone {drone_id}] -> Holding in LOITER.", flush=True)
            else:
                return jsonify({"error": f"Unknown action: {action}"}), 400

            return jsonify({"status": "ok", "action": action, "drone_id": drone_id})
        except Exception as exc:
            print(f"Command error ({action}, drone {drone_id}): {exc}", flush=True)
            return jsonify({"error": str(exc)}), 500


# =============================================================================
# HELPER: Finish Attacker — move drone out of active list back to reserve
# =============================================================================

def _finish_attacker(drone_id, target_status):
    """Remove a drone from the active attacker list and return it to the reserve pool."""
    drone_id = int(drone_id)
    if drone_id in shared.mission_state["active_attackers"]:
        shared.mission_state["active_attackers"].pop(drone_id)
    if drone_id in shared.mission_state["_active_attackers_list"]:
        shared.mission_state["_active_attackers_list"].remove(drone_id)

    # Update the status of all targets assigned to this drone
    for target in shared.mission_state["targets"]:
        if target.get("assigned_drone") == drone_id:
            target["status"] = target_status
            target["completed_time"] = time.time()

    if drone_id not in [int(d_id) for d_id in shared.mission_state["_attack_reserve"]]:
        shared.mission_state["_attack_reserve"].append(drone_id)
    shared.sync_attack_reserve()

