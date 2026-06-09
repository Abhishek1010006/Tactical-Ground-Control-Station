import time
import Mavlink.Command as cmd

def start_attack_mode(drone_manager, state_manager):
    print("\n" + "="*40)
    print("🚀 INIT: AUTONOMOUS ATTACK SYSTEM")
    print("="*40)

    drones = drone_manager.drones
    if len(drones) < 2:
        print("❌ Error: At least 2 drones are required for attack mode.")
        return

    print("\nConnected Drones:")
    for d_id in drones.keys():
        print(f" - Drone {d_id}")

    # 1. Select Surveillance Drone
    while True:
        try:
            surv_id = int(input("\nSelect Surveillance Drone ID: "))
            if surv_id in drones:
                surv_drone = drones[surv_id]
                break
            else:
                print("❌ Invalid Drone ID.")
        except ValueError:
            print("❌ Please enter a valid number.")

    # 2. Assign Attack Drones
    attack_drones = [d_id for d_id in drones.keys() if d_id != surv_id]
    print(f"\n✅ Surveillance Drone: {surv_id}")
    print(f"✅ Available Attack Drones: {attack_drones}")

    # 3. Ask for Attack Altitude
    while True:
        try:
            attack_alt = float(input("\nEnter Attack Altitude (meters): "))
            break
        except ValueError:
            print("❌ Please enter a valid number.")

    # 4. Target Acquisition Loop
    print("\n" + "="*40)
    print("🎯 ATTACK SYSTEM READY")
    print("="*40)

    while True:
        action = input("\n> Type 'attack' to engage target, or 'exit' to quit: ").strip().lower()

        if action == 'exit':
            print("Exiting Attack Mode.")
            break
            
        elif action == 'attack':
            if not attack_drones:
                print("⚠️ No more attack drones available in reserve!")
                continue

            # Deploy the next drone in queue
            attacker_id = attack_drones.pop(0)
            attacker = drones[attacker_id]

            print(f"\n🚀 Deploying Drone {attacker_id} for attack...")

            # Get target coordinates from Surveillance Drone
            surv_state = state_manager.get(surv_id)
            if not surv_state or 'lat' not in surv_state or 'lon' not in surv_state:
                print("❌ Error: No GPS telemetry available for Surveillance Drone yet. Aborting deployment.")
                # Put it back in queue
                attack_drones.insert(0, attacker_id)
                continue

            target_lat = surv_state['lat']
            target_lon = surv_state['lon']

            print(f"📍 Target acquired at: {target_lat:.6f}, {target_lon:.6f}")

            # Auto-launch sequence
            print("   -> Switching to GUIDED mode...")
            cmd.set_mode(attacker.connection, 4) # GUIDED
            time.sleep(0.5) # wait for mode change
            
            print("   -> Arming...")
            cmd.arm(attacker.connection)
            time.sleep(1) # wait 1 second for arming to complete
            
            print(f"   -> Taking off to {attack_alt}m...")
            cmd.takeoff(attacker.connection, altitude=attack_alt)
            
            print("   -> Waiting to clear the ground...")
            # Wait for drone to reach a safe minimum altitude (e.g. 2 meters) to avoid obstacles
            attempts = 0
            while True:
                attacker_state = state_manager.get(attacker_id)
                current_alt = attacker_state.get('alt', 0) if attacker_state else 0
                
                if isinstance(current_alt, (int, float)):
                    if current_alt >= 2.0 or current_alt >= (attack_alt * 0.90):
                        break
                        
                attempts += 1
                if attempts % 4 == 0: # Every 2 seconds, retry takeoff
                    print("   -> Retrying takeoff command...")
                    cmd.takeoff(attacker.connection, altitude=attack_alt)
                    
                time.sleep(0.5)
            
            print("   -> Ground cleared! Proceeding to target while climbing.")

            # Send to target
            print("   -> Guiding to target coordinates...")
            cmd.goto_global(attacker.connection, target_lat, target_lon, attack_alt)

            # Wait for operator decision
            while True:
                decision = input(f"\n⚠️ Drone {attacker_id} deployed! Action ('drop' to release payload, 'n' to RTL, 'abort' to emergency RTL): ").strip().lower()

                if decision == 'drop':
                    cmd.drop_payload(attacker.connection)
                    time.sleep(1)
                    print(f"   -> Payload dropped. Drone {attacker_id} is returning home.")
                    cmd.rtl(attacker.connection)
                    break
                elif decision in ['n', 'abort']:
                    print(f"   -> Attack cancelled! Drone {attacker_id} is returning home.")
                    cmd.rtl(attacker.connection)
                    break
                else:
                    print("❌ Invalid command. Type 'drop', 'n', or 'abort'.")
                    
        else:
            print("❌ Unknown command.")
