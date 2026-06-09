from pymavlink import mavutil
import serial.tools.list_ports
import time

def auto_connect(baud=57600, timeout=3):
    ports = serial.tools.list_ports.comports()
    connections = []

    for port in ports:
        port_name = port.device
        print(f"Trying {port_name}...")

        try:
            master = mavutil.mavlink_connection(port_name, baud=baud)

            start_time = time.time()
            connected = False
            while time.time() - start_time < timeout:
                msg = master.recv_match(type='HEARTBEAT', blocking=True, timeout=1)
                if msg and msg.get_srcSystem() != 255:
                    master.target_system = msg.get_srcSystem()
                    master.target_component = msg.get_srcComponent()
                    print(f"✅ Connected on {port_name}")
                    connections.append(master)
                    connected = True
                    #return master
                    break

            if not connected:
                master.close()

        except Exception as e:
            print(f"❌ Failed on {port_name}: {e}")
    if not connections:
        raise Exception("No MAVLink device found")
    
    return connections

# Test
if __name__ == "__main__":
    drones = auto_connect()
    print(f"Connected to {len(drones)} drone(s)")