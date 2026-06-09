import threading
import time


class TelemetryListener:
    def __init__(self, connection, drone_id, state_manager):
        self.connection = connection
        self.drone_id = drone_id
        self.state_manager = state_manager
        self.running = False

    def start(self):
        self.running = True
        thread = threading.Thread(target=self._listen)
        thread.daemon = True
        thread.start()

    def stop(self):
        self.running = False

    def _listen(self):
        while self.running:
            try:
                msg = self.connection.recv_match(blocking=False)
            except Exception as exc:
                print(f"[Drone {self.drone_id}] Telemetry disconnected: {exc}", flush=True)
                self.running = False
                try:
                    self.connection.close()
                except Exception:
                    pass
                break

            if not msg:
                time.sleep(0.01)
                continue

            msg_type = msg.get_type()

            if msg_type == "HEARTBEAT":
                self._handle_heartbeat(msg)
            elif msg_type == "GLOBAL_POSITION_INT":
                self._handle_position(msg)
            elif msg_type == "ATTITUDE":
                self._handle_attitude(msg)
            elif msg_type == "SYS_STATUS":
                self._handle_status(msg)
            elif msg_type == "LOCAL_POSITION_NED":
                self._handle_local_position(msg)
            elif msg_type == "RC_CHANNELS":
                self._handle_rc_channels(msg)

    def _handle_heartbeat(self, msg):
        self.state_manager.update(self.drone_id, {
            "mode": msg.custom_mode,
            "armed": msg.base_mode
        })

    def _handle_position(self, msg):
        self.state_manager.update(self.drone_id, {
            "lat": msg.lat / 1e7,
            "lon": msg.lon / 1e7,
            "alt": msg.relative_alt / 1000
        })

    def _handle_attitude(self, msg):
        self.state_manager.update(self.drone_id, {
            "roll": msg.roll,
            "pitch": msg.pitch,
            "yaw": msg.yaw
        })

    def _handle_status(self, msg):
        self.state_manager.update(self.drone_id, {
            "battery": msg.battery_remaining
        })

    def _handle_local_position(self, msg):
        self.state_manager.update(self.drone_id, {
            "ned_x": msg.x,
            "ned_y": msg.y,
            "ned_z": msg.z,
            "ned_vx": msg.vx,
            "ned_vy": msg.vy,
            "ned_vz": msg.vz
        })

    def _handle_rc_channels(self, msg):
        # Keep channel 5 visible in telemetry, but do not auto-create targets.
        self.state_manager.update(self.drone_id, {
            "rc_ch5": msg.chan5_raw
        })
