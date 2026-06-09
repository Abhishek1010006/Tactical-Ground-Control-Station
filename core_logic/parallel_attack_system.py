import time
import threading
import Mavlink.Command as cmd

def _deploy_drone_thread(attacker_id, attacker, attack_alt, target_lat, target_lon, state_manager):
    print(f"\n[Drone {attacker_id}] 🚀 Deploying for attack...")
    
    print(f"[Drone {attacker_id}] -> Switching to GUIDED mode...")
    cmd.set_mode(attacker.connection, 4) # GUIDED
    time.sleep(0.5) # wait for mode change
    
    print(f"[Drone {attacker_id}] -> Arming...")
    cmd.arm(attacker.connection)
    time.sleep(1) # wait 1 second for arming to complete
    
    print(f"[Drone {attacker_id}] -> Taking off to {attack_alt}m...")
    cmd.takeoff(attacker.connection, altitude=attack_alt)
    
    print(f"[Drone {attacker_id}] -> Waiting to clear the ground...")
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
            cmd.takeoff(attacker.connection, altitude=attack_alt)
            
        time.sleep(0.5)
    
    print(f"[Drone {attacker_id}] -> Ground cleared! Proceeding to target while climbing.")

    # Send to target
    print(f"[Drone {attacker_id}] -> Guiding to target coordinates: {target_lat:.6f}, {target_lon:.6f}")
    cmd.goto_global(attacker.connection, target_lat, target_lon, attack_alt)
    print(f"\n⚠️  [Drone {attacker_id}] Deployed and en route! Use 'drop {attacker_id}' or 'rtl {attacker_id}' when ready.\n> ", end="", flush=True)

def start_parallel_attack_mode(drone_manager, state_manager):
    print("\n" + "="*40)
    print("🚀 INIT: PARALLEL AUTONOMOUS ATTACK SYSTEM")
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
    print("🎯 PARALLEL ATTACK SYSTEM READY")
    print("="*40)

    active_attackers = []

    while True:
        action_input = input("\n> Enter command ('attack', 'drop <id>', 'rtl <id>', 'exit'): ").strip().lower()
        parts = action_input.split()
        
        if not parts:
            continue
            
        action = parts[0]

        if action == 'exit':
            print("Exiting Attack Mode.")
            break
            
        elif action == 'attack':
            if not attack_drones:
                print("⚠️  No more attack drones available in reserve!")
                continue

            # Deploy the next drone in queue
            attacker_id = attack_drones.pop(0)
            attacker = drones[attacker_id]

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
            
            active_attackers.append(attacker_id)
            
            # Start background thread for deployment
            t = threading.Thread(
                target=_deploy_drone_thread, 
                args=(attacker_id, attacker, attack_alt, target_lat, target_lon, state_manager)
            )
            t.daemon = True
            t.start()

        elif action == 'drop':
            if len(parts) < 2:
                print("❌ Please specify drone ID: 'drop <id>'")
                continue
            try:
                d_id = int(parts[1])
                if d_id in active_attackers:
                    cmd.drop_payload(drones[d_id].connection)
                    time.sleep(1)
                    print(f"[Drone {d_id}] -> Payload dropped. Returning home.")
                    cmd.rtl(drones[d_id].connection)
                    active_attackers.remove(d_id)
                    attack_drones.append(d_id) # Optional: add back to reserve
                else:
                    print(f"❌ Drone {d_id} is not an active attacker. Active: {active_attackers}")
            except ValueError:
                print("❌ Invalid drone ID.")

        elif action == 'rtl' or action == 'abort':
            if len(parts) < 2:
                print("❌ Please specify drone ID: 'rtl <id>'")
                continue
            try:
                d_id = int(parts[1])
                if d_id in active_attackers:
                    print(f"[Drone {d_id}] -> Attack cancelled! Returning home.")
                    cmd.rtl(drones[d_id].connection)
                    active_attackers.remove(d_id)
                    attack_drones.append(d_id) # Optional: add back to reserve
                else:
                    print(f"❌ Drone {d_id} is not an active attacker. Active: {active_attackers}")
            except ValueError:
                print("❌ Invalid drone ID.")
                
        else:
            print("❌ Unknown command. Available commands: 'attack', 'drop <id>', 'rtl <id>', 'exit'")
