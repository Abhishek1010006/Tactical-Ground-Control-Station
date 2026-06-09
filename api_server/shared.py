# ==============================================================================
# api_server/shared.py — Shared State, Utilities, and Background Tasks
# ==============================================================================
# This module holds all the global/shared state that the API server routes and
# background threads need to access. It acts as the single source of truth for:
#
#   - Drone Manager & State Manager instances (created once at import time).
#   - MAVLink connection status and telemetry listener list.
#   - Mission state dictionary (operating mode, roles, targets, attackers).
#   - Terminal output buffer (deque) and subscriber queues for SSE streaming.
#   - TerminalTee class that mirrors stdout/stderr into the terminal buffer.
#   - Background heartbeat loop to keep MAVLink connections alive.
#   - Helper functions for attack mode role management and drone deployment.
#
# Imported by: function.py, server.py, terminal.py, map.py
# ==============================================================================

from collections import deque
from queue import Queue
from pymavlink import mavutil
import os
import sys
import threading
import time

from Mavlink.tcp_connection import auto_connect_tcp
import Mavlink.Command as cmd
from Mavlink.Telemetry import TelemetryListener
from drone.drone_manager import DroneManager
from drone.state_manager import StateManager


# --- Force UTF-8 encoding for emoji/unicode support in terminal output ---
if hasattr(sys.stdout, "reconfigure") and sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


# =============================================================================
# SECTION: Global Drone & Connection State
# =============================================================================
# These are created once at module import time and shared across all routes.

drone_manager = DroneManager()   # Manages all connected Drone objects
state_manager = StateManager()   # Thread-safe telemetry storage per drone
listeners = []                   # Active TelemetryListener threads
connected = False                # True once at least one drone is connected


# =============================================================================
# SECTION: Mission State Dictionary
# =============================================================================
# Holds the current operating mode (swarm/attack), role assignments,
# target records, and active attacker tracking.

mission_state = {
    "operating_mode": None,              # "swarm" or "attack"
    "surveillance_id": None,             # Drone ID assigned as surveillance
    "attack_ids": [],                    # All drone IDs eligible for attack
    "attack_alt": 10,                    # Default attack altitude in meters
    "active_attackers": {},              # {drone_id: {target info}} currently attacking
    "targets": [],                       # List of target records with status
    "target_id_seq": 0,                  # Auto-incrementing target ID counter
    "_last_target_key": None,            # Deduplication key for repeated targets
    "_attack_reserve": [],               # Attack drones not yet deployed (queue)
    "_active_attackers_list": [],         # List of drone IDs currently in-flight
}


# =============================================================================
# SECTION: Terminal Output Buffer & SSE Subscriber System
# =============================================================================
# The terminal_lines deque stores the last 3000 lines of stdout/stderr output.
# terminal_subscribers is a list of Queue objects — one per connected SSE client.
# When a new line is printed, it is pushed to all subscriber queues.

terminal_lines = deque(maxlen=3000)
terminal_subscribers = []
terminal_lock = threading.Lock()


# --- Project Root Helper ---
def project_root():
    """Return the absolute path to the project root directory (one level above api_server/)."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# --- Push a line to all terminal subscribers ---
def terminal_push(line):
    """Append a line to the buffer and notify all SSE subscriber queues."""
    if not line:
        return
    with terminal_lock:
        terminal_lines.append(line)
        subscribers = list(terminal_subscribers)
    for queue in subscribers:
        try:
            queue.put_nowait(line)
        except Exception:
            pass


# =============================================================================
# SECTION: TerminalTee — Mirror stdout/stderr to the API Terminal Stream
# =============================================================================
# Wraps the original stdout/stderr so that every print() call is also captured
# into the terminal buffer for streaming to the Electron UI.

class TerminalTee:
    """Mirror stdout/stderr into the API terminal stream."""

    def __init__(self, stream):
        self._stream = stream

    def write(self, data):
        if not data:
            return
        # Write to the original stream (console)
        try:
            self._stream.write(data)
            self._stream.flush()
        except Exception:
            pass
        # Split into lines and push each to the terminal buffer
        text = data if isinstance(data, str) else data.decode("utf-8", errors="replace")
        for line in text.splitlines():
            stripped = line.rstrip()
            if stripped:
                terminal_push(stripped)

    def flush(self):
        try:
            self._stream.flush()
        except Exception:
            pass

    def isatty(self):
        return False


def install_terminal_tee():
    """Replace sys.stdout and sys.stderr with TerminalTee wrappers (idempotent)."""
    if not isinstance(sys.stdout, TerminalTee):
        sys.stdout = TerminalTee(sys.stdout)
    if not isinstance(sys.stderr, TerminalTee):
        sys.stderr = TerminalTee(sys.stderr)


# =============================================================================
# SECTION: Background Heartbeat Loop
# =============================================================================
# Sends MAVLink GCS heartbeats to every connected drone once per second.
# This keeps the MAVLink connection alive and prevents autopilot timeouts.

def heartbeat_loop():
    """Continuously send GCS heartbeats to all connected drones."""
    while True:
        if connected:
            for drone in drone_manager.drones.values():
                try:
                    drone.connection.mav.heartbeat_send(
                        mavutil.mavlink.MAV_TYPE_GCS,
                        mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                        0, 0, 0)
                except Exception as exc:
                    print(f"Heartbeat error for drone {drone.system_id}: {exc}", flush=True)
        time.sleep(1)


def start_background_tasks():
    """Start all daemon background threads (heartbeat loop)."""
    threading.Thread(target=heartbeat_loop, daemon=True).start()


# =============================================================================
# SECTION: Attack Mode Helpers
# =============================================================================
# Functions to manage the attack drone reserve pool and initialise attack mode.

def sync_attack_reserve():
    """Keep the attack reserve pool in round-robin order, excluding active attackers."""
    surv_id = mission_state["surveillance_id"]
    if surv_id is None:
        mission_state["_attack_reserve"] = []
        return

    pool = [int(d_id) for d_id in drone_manager.drones.keys() if int(d_id) != int(surv_id)]
    active = {int(d_id) for d_id in mission_state["_active_attackers_list"]}
    active.update(int(d_id) for d_id in mission_state["active_attackers"].keys())
    for target in mission_state["targets"]:
        status = str(target.get("status", "")).lower()
        assigned = target.get("assigned_drone")
        if assigned is not None and status in ("pending", "deploying", "enroute", "dispatched", "arrived"):
            active.add(int(assigned))

    current_reserve = [
        int(d_id) for d_id in mission_state["_attack_reserve"]
        if int(d_id) in pool and int(d_id) not in active
    ]
    missing = [
        d_id for d_id in pool
        if d_id not in active and d_id not in current_reserve
    ]

    mission_state["attack_ids"] = pool
    mission_state["_attack_reserve"] = current_reserve + missing


def init_attack_mode_from_roles():
    """Initialise the attack mode state from the current role assignments."""
    surv_id = mission_state["surveillance_id"]
    if surv_id is None or surv_id not in drone_manager.drones:
        return False
    sync_attack_reserve()
    print(f"\nSurveillance Drone: {surv_id}", flush=True)
    print(f"Available Attack Drones: {mission_state['_attack_reserve']}", flush=True)
    print(f"Attack Altitude: {mission_state['attack_alt']}m", flush=True)
    print("Parallel attack system ready (UI-controlled)", flush=True)
    return True


# =============================================================================
# SECTION: Drone Deployment (used by function.py attack routes)
# =============================================================================
# Full guided deployment sequence: mode change → arm → takeoff → goto target.

def _set_attack_status(drone_id, target_id, status):
    """Update the shared mission status for one attack target and its attacker."""
    for target in mission_state["targets"]:
        if int(target.get("id")) == int(target_id):
            target["status"] = status
            target["status_time"] = time.time()
            break
    drone_id = int(drone_id)
    if drone_id in mission_state["active_attackers"]:
        mission_state["active_attackers"][drone_id]["status"] = status


def _finish_failed_attack(drone_id, target_id):
    """Release a failed deployment so the attacker can be reused."""
    drone_id = int(drone_id)
    _set_attack_status(drone_id, target_id, "failed")
    if drone_id in mission_state["active_attackers"]:
        mission_state["active_attackers"].pop(drone_id)
    if drone_id in mission_state["_active_attackers_list"]:
        mission_state["_active_attackers_list"].remove(drone_id)
    if drone_id not in [int(d_id) for d_id in mission_state["_attack_reserve"]]:
        mission_state["_attack_reserve"].append(drone_id)
    sync_attack_reserve()


def _is_armed(drone_id):
    state = state_manager.get(int(drone_id)) or {}
    base_mode = state.get("armed", state.get("base_mode", 0)) or 0
    return bool(int(base_mode) & 128)


def deploy_attack_drone(drone_id, target_lat, target_lon, attack_alt, target_id):
    """Deploy a single attack drone through the full guided flight sequence."""
    drone_id = int(drone_id)
    drone = drone_manager.get_drone(drone_id)
    if not drone:
        print(f"Drone {drone_id} not found for deployment", flush=True)
        return

    # Mark the target as deploying
    _set_attack_status(drone_id, target_id, "deploying")

    mission_state["active_attackers"][drone_id] = {
        "target_lat": target_lat,
        "target_lon": target_lon,
        "target_id": target_id,
        "status": "deploying"
    }

    # Step 1: Switch to GUIDED mode
    print(f"[Drone {drone_id}] -> Switching to GUIDED mode...", flush=True)
    for _ in range(3):
        cmd.set_mode(drone.connection, 4)
        time.sleep(0.4)

    # Step 2: Arm the drone
    print(f"[Drone {drone_id}] -> Arming...", flush=True)
    _set_attack_status(drone_id, target_id, "arming")
    arm_deadline = time.time() + 8
    while time.time() < arm_deadline:
        cmd.arm(drone.connection)
        time.sleep(1)
        if _is_armed(drone_id):
            break
    if not _is_armed(drone_id):
        print(f"[Drone {drone_id}] -> Arm telemetry not confirmed; continuing with takeoff command.", flush=True)

    # Step 3: Takeoff to attack altitude
    print(f"[Drone {drone_id}] -> Taking off to {attack_alt}m...", flush=True)
    _set_attack_status(drone_id, target_id, "takeoff")
    cmd.takeoff(drone.connection, altitude=attack_alt)

    # Step 4: Wait for the drone to clear the ground (reach ≥2m or 90% of target alt)
    start_alt = (state_manager.get(drone_id) or {}).get("alt", 0) or 0
    takeoff_deadline = time.time() + 18
    attempts = 0
    while time.time() < takeoff_deadline:
        attacker_state = state_manager.get(drone_id)
        current_alt = attacker_state.get("alt", 0) if attacker_state else 0
        if isinstance(current_alt, (int, float)):
            climbed = current_alt >= (start_alt + 1.0)
            cleared = current_alt >= 2.0 or current_alt >= (float(attack_alt) * 0.90)
            if climbed or cleared:
                break
        attempts += 1
        if attempts % 4 == 0:
            cmd.arm(drone.connection)
            cmd.takeoff(drone.connection, altitude=attack_alt)
        time.sleep(0.5)
    if time.time() >= takeoff_deadline:
        print(f"[Drone {drone_id}] -> Takeoff clearance not confirmed; sending target waypoint anyway.", flush=True)

    # Step 5: Navigate to the target coordinates
    print(f"[Drone {drone_id}] -> Guiding to target: {target_lat:.6f}, {target_lon:.6f}", flush=True)
    cmd.set_mode(drone.connection, 4)
    time.sleep(0.2)
    for _ in range(3):
        cmd.takeoff(drone.connection, altitude=attack_alt)
        cmd.goto_global(drone.connection, target_lat, target_lon, attack_alt)
        time.sleep(0.4)

    # Update target and attacker status to "enroute"
    for target in mission_state["targets"]:
        if target["id"] == target_id:
            target["status"] = "enroute"
            break
    if drone_id in mission_state["active_attackers"]:
        mission_state["active_attackers"][drone_id]["status"] = "enroute"

    print(f"[Drone {drone_id}] Deployed and en route to T{target_id}", flush=True)
