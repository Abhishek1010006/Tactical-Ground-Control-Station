import threading
import time
import os

class StateManager:
    def __init__(self):
        self._states = {}   # stores all drone states
        self._lock = threading.Lock()

    # ---------------- UPDATE ---------------- #

    def update(self, drone_id, data):
        with self._lock:
            if drone_id not in self._states:
                self._states[drone_id] = {}

            # merge new data
            self._states[drone_id].update(data)

            # track last update time
            self._states[drone_id]["last_update"] = time.time()

    # ---------------- GET ---------------- #

    def get(self, drone_id):
        with self._lock:
            return self._states.get(drone_id, {}).copy()

    def get_all(self):
        with self._lock:
            return self._states.copy()

    # ---------------- HEALTH ---------------- #

    def is_alive(self, drone_id, timeout=3):
        with self._lock:
            state = self._states.get(drone_id)

            if not state:
                return False

            last = state.get("last_update")
            if not last:
                return False

            return (time.time() - last) < timeout

    # ---------------- DEBUG ---------------- #

    def print_all(self):
        with self._lock:
            # Clear the terminal for a live dashboard effect
            os.system('cls' if os.name == 'nt' else 'clear')
            
            print("="*60)
            print(f"{'DRONE TELEMETRY DASHBOARD':^60}")
            print("="*60)
            
            if not self._states:
                print("Waiting for telemetry data...")
                return

            for drone_id, state in self._states.items():
                lat = state.get('lat', 'N/A')
                lon = state.get('lon', 'N/A')
                alt = state.get('alt', 'N/A')
                batt = state.get('battery', 'N/A')
                mode = state.get('mode', 'UNKNOWN')
                
                print(f"🚁 Drone [{drone_id}] | Mode: {mode} | Battery: {batt}%")
                if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and isinstance(alt, (int, float)):
                    print(f"   📍 Pos: {lat:.6f}, {lon:.6f} | Alt: {alt:.1f}m")
                else:
                    print(f"   📍 Pos: {lat}, {lon} | Alt: {alt}")
                print("-" * 60)
