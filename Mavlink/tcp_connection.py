from pymavlink import mavutil
import time

step = 10
# Common SITL TCP ports (you can expand this)
TCP_PORTS = list(range(5762, 5822, step))  # Try ports 5762–5882

def auto_connect_tcp(host="127.0.0.1", timeout=3):
    connections = []

    for port in TCP_PORTS:
        address = f"tcp:{host}:{port}"
        print(f"Trying {address}...")

        try:
            master = mavutil.mavlink_connection(address)

            # Wait for heartbeat
            start_time = time.time()
            connected = False
            while time.time() - start_time < timeout:
                msg = master.recv_match(type='HEARTBEAT', blocking=True, timeout=1)
                if msg and msg.get_srcSystem() != 255:
                    master.target_system = msg.get_srcSystem()
                    master.target_component = msg.get_srcComponent()
                    print(f"✅ Connected on {address}")
                    connections.append(master)
                    connected = True
                    break

            if not connected:
                master.close()

        except Exception as e:
            print(f"❌ Failed on {address}: {e}")

    if not connections:
        raise Exception("No TCP MAVLink devices found")

    return connections

# Test
if __name__ == "__main__":
    drones = auto_connect_tcp()
    print(f"Connected to {len(drones)} drone(s)")