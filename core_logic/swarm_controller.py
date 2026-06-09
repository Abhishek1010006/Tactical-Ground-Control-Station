import time
import Mavlink.Command as cmd

def run_swarm_mode(state_manager, connected_drones, listeners, drone_manager):
    print("\n" + "="*40)
    print("🚀 INIT: SWARM CONFIGURATION")
    print("="*40)
    
    if len(connected_drones) < 2:
        print("❌ Error: At least 2 drones are required for swarm mode.")
        return

    print("\nConnected Drones:")
    for d_id in connected_drones.keys():
        print(f" - Drone {d_id}")

    # 1. Select Leader Drone
    while True:
        try:
            leader_id = int(input("\nSelect Leader Drone ID: "))
            if leader_id in connected_drones:
                break
            else:
                print("❌ Invalid Drone ID.")
        except ValueError:
            print("❌ Please enter a valid number.")

    follower_ids = [d_id for d_id in connected_drones.keys() if d_id != leader_id]
    
    # 2. Set Offsets
    print("\n" + "="*40)
    print("📏 SET FOLLOWER OFFSETS (North, East, Down in meters)")
    print("   Relative to the Leader. Ex: 5, 0, 0 is 5m North.")
    print("="*40)
    
    offsets = {}
    for f_id in follower_ids:
        while True:
            try:
                print(f"\nOffsets for Follower {f_id}:")
                n = float(input("  North (m): "))
                e = float(input("  East (m): "))
                d = float(input("  Down (m) [Negative is UP]: "))
                offsets[f_id] = {'n': n, 'e': e, 'd': d}
                break
            except ValueError:
                print("❌ Please enter valid numbers.")

    # 3. Takeoff Altitude
    while True:
        try:
            takeoff_alt = float(input("\nEnter Takeoff Altitude for the Swarm (meters): "))
            break
        except ValueError:
            print("❌ Please enter a valid number.")

    # 4. Automated Takeoff Sequence
    print("\n" + "="*40)
    print("🛫 INITIATING AUTOMATED SWARM TAKEOFF")
    print("="*40)
    
    for d_id, drone in connected_drones.items():
        print(f"\n   -> Drone {d_id}: Switching to GUIDED mode...")
        cmd.set_mode(drone.connection, 4) # GUIDED
        time.sleep(0.5)
        
        print(f"   -> Drone {d_id}: Arming...")
        cmd.arm(drone.connection)
        time.sleep(1)
        
        print(f"   -> Drone {d_id}: Taking off to {takeoff_alt}m...")
        cmd.takeoff(drone.connection, altitude=takeoff_alt)
        time.sleep(0.5)

    print("\n⏳ Waiting for all drones to reach safe altitude...")
    # Wait for drones to reach altitude
    while True:
        all_ready = True
        for d_id in connected_drones.keys():
            state = state_manager.get(d_id)
            current_alt = state.get('alt', 0) if state else 0
            if not isinstance(current_alt, (int, float)) or current_alt < (takeoff_alt * 0.90):
                all_ready = False
                break
        
        if all_ready:
            break
            
        time.sleep(1)

    print("\n✅ Swarm airborne and ready! Operator has control of the Leader.")
    print("\n" + "="*40)
    print("🐝 SWARM ACTIVE - FOLLOWERS TRACKING LEADER")
    print("="*40)
    print("Press Ctrl+C to abort and RTL.")

    try:
        while True:
            leader_state = state_manager.get(leader_id)
            
            # Check if leader has valid local position data
            if not leader_state or 'ned_x' not in leader_state:
                print(f"⚠️ Waiting for Local Position data from Leader {leader_id}...")
                time.sleep(1)
                continue

            leader_n = leader_state['ned_x']
            leader_e = leader_state['ned_y']
            leader_d = leader_state['ned_z']
            leader_vn = leader_state.get('ned_vx', 0.0)
            leader_ve = leader_state.get('ned_vy', 0.0)
            leader_vd = leader_state.get('ned_vz', 0.0)
            leader_yaw = leader_state.get('yaw', 0.0)

            for f_id in follower_ids:
                follower = connected_drones[f_id]
                f_offset = offsets[f_id]
                
                target_n = leader_n + f_offset['n']
                target_e = leader_e + f_offset['e']
                target_d = leader_d + f_offset['d']
                
                cmd.set_nav_with_vel_yaw(follower.connection, target_n, target_e, target_d, leader_vn, leader_ve, leader_vd, leader_yaw)

            time.sleep(0.1) # 5 Hz update rate for swarm formation
            
    except KeyboardInterrupt:
        print("\n🛑 Swarm Mode Aborted! Issuing RTL to all drones...")
        for d_id, drone in connected_drones.items():
            cmd.rtl(drone.connection)
        
        print("Stopping listeners...")
        for listener in listeners:
            listener.stop()
