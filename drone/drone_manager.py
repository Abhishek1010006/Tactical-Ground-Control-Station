from pymavlink import mavutil
import time


class Drone:
    def __init__(self, connection):
        self.connection = connection
        self.system_id = None
        self.component_id = None

    def connect(self):
        start_time = time.time()
        while time.time() - start_time < 5:
            msg = self.connection.recv_match(type='HEARTBEAT', blocking=True, timeout=1)
            if msg and msg.get_srcSystem() != 255:
                self.system_id = msg.get_srcSystem()
                self.component_id = msg.get_srcComponent()
                print(f"✅ Drone connected: SYS {self.system_id}")
                return
        
        # Fallback if no valid drone heartbeat found
        self.system_id = self.connection.target_system if hasattr(self.connection, 'target_system') else 1
        self.component_id = self.connection.target_component if hasattr(self.connection, 'target_component') else 1
        print(f"⚠️ Warning: Drone SYSID not found, defaulting to SYS {self.system_id}")

    def request_data_stream(self, rate=10):

        self.connection.mav.request_data_stream_send(
            self.system_id,
            self.component_id,
            mavutil.mavlink.
            MAV_DATA_STREAM_ALL,
            rate,
            1
            )

class DroneManager:
    def __init__(self):
        self.drones = {}  # key: system_id → Drone object

    # ---------------- CONNECTION ---------------- #

    def add_connection(self, connection):
        drone = Drone(connection)
        drone.connect()
        drone.request_data_stream()
        self.drones[drone.system_id] = drone

    def get_drone(self, system_id):
        return self.drones.get(system_id)

    def get_all_drones(self):
        return list(self.drones.values())

    # ---------------- COMMANDS ---------------- #

    def set_mode_guided(self, drone):
        drone.connection.mav.set_mode_send(
            drone.system_id,
            mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            4  # GUIDED
        )

    def arm(self, drone):
        self.set_mode_guided(drone)

        drone.connection.mav.command_long_send(
            drone.system_id,
            drone.component_id,
            mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            0, 1, 0, 0, 0, 0, 0, 0
        )

    def disarm(self, drone):
        drone.connection.mav.command_long_send(
            drone.system_id,
            drone.component_id,
            mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            0, 0, 0, 0, 0, 0, 0, 0
        )

    def takeoff(self, drone, altitude=5):
        drone.connection.mav.command_long_send(
            drone.system_id,
            drone.component_id,
            mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
            0,
            0, 0, 0, 0,
            0, 0, altitude
        )

    def land(self, drone):
        drone.connection.mav.command_long_send(
            drone.system_id,
            drone.component_id,
            mavutil.mavlink.MAV_CMD_NAV_LAND,
            0,
            0, 0, 0, 0,
            0, 0, 0
        )

    # ---------------- MULTI-DRONE COMMANDS ---------------- #

    def arm_all(self):
        for drone in self.drones.values():
            self.arm(drone)

    def takeoff_all(self, altitude=5):
        for drone in self.drones.values():
            self.takeoff(drone, altitude)

    def land_all(self):
        for drone in self.drones.values():
            self.land(drone)
