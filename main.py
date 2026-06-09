from drone.state_manager import StateManager
from drone.drone_manager import DroneManager
from Mavlink.Connection import auto_connect
from Mavlink.tcp_connection import auto_connect_tcp
from Mavlink.Telemetry import TelemetryListener
import time
import sys

# Force UTF-8 encoding for standard output to support emojis
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

def main():
    print("🚀 Starting Swarm Backend...")

    # 1. Initialize our managers
    state_manager = StateManager()
    drone_manager = DroneManager()

    # 2. Connect to the drones and add them to DroneManager
    #connections = auto_connect()
    connections = auto_connect_tcp()
    for conn in connections:
        drone_manager.add_connection(conn)

    # drone_manager.drones is your dictionary: { system_id : Drone Object }
    connected_drones = drone_manager.drones 
    
    # 3. Start a parallel Telemetry stream for each drone
    listeners = []
    for drone_id, drone in connected_drones.items():
        # Pass the connection, the drone's ID, and our shared state_manager
        listener = TelemetryListener(drone.connection, drone_id, state_manager)
        listener.start()  # This starts the background thread!
        listeners.append(listener)
        print(f"📡 Started parallel telemetry stream for Drone {drone_id}")

    import Mavlink.Command as cmd

    # 4. Select Operating Mode
    print("\nSelect Operating Mode:")
    print("1. Swarming")
    print("2. Autonomous Attack")
    mode_selection = input("Enter mode (1 or 2): ").strip()

    if mode_selection == '1':
        import core_logic.swarm_controller as swarm_ctrl
        swarm_ctrl.run_swarm_mode(state_manager, connected_drones, listeners, drone_manager)

    elif mode_selection == '2':
        import core_logic.parallel_attack_system as parallel_attack_sys
        try:
            parallel_attack_sys.start_parallel_attack_mode(drone_manager, state_manager)
        except KeyboardInterrupt:
            print("\n🛑 Attack Mode Aborted via Keyboard Interrupt.")
        finally:
            print("Stopping listeners...")
            for listener in listeners:
                listener.stop()
                
    else:
        print("❌ Invalid mode selected. Exiting.")
        for listener in listeners:
            listener.stop()

if __name__ == "__main__":
    main()
