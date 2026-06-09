from pymavlink import mavutil
import time


# 🔧 Set mode (GUIDED, LAND, etc.)
"""
def set_mode(drone, mode):
    mode_mapping = drone.mode_mapping()

    if mode not in mode_mapping:
        print(f"❌ Mode {mode} not supported")
        return

    mode_id = mode_mapping[mode]

    drone.mav.set_mode_send(
        drone.target_system,
        mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
        mode_id
    )

    print(f"📡 Mode set to {mode}")
"""
def set_mode(drone, mode):
    drone.mav.set_mode_send(
        drone.target_system,
        mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
        mode
    )
    time.sleep(0.1)
    drone.mav.command_long_send(
        drone.target_system, 
        drone.target_component, 
        mavutil.mavlink.MAV_CMD_DO_SET_MODE, 
        0, 
        1, mode, 0, 0, 0, 0, 0)


# 🔓 Arm drone
def arm(drone):
    print("🔓 Arming drone...")

    drone.mav.command_long_send(
        drone.target_system,
        drone.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
        0,
        1, 0, 0, 0, 0, 0, 0
    )

    # wait for confirmation
    #drone.motors_armed_wait()
    #print("✅ Drone armed")


# 🔒 Disarm drone
def disarm(drone):
    print("🔒 Disarming drone...")

    drone.mav.command_long_send(
        drone.target_system,
        drone.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
        0,
        0, 0, 0, 0, 0, 0, 0
    )

    #drone.motors_disarmed_wait()
    #print("✅ Drone disarmed")


# 🚀 Takeoff
def takeoff(drone, altitude=5):
    print(f"🚀 Taking off to {altitude} meters")

    drone.mav.command_long_send(
        drone.target_system,
        drone.target_component,
        mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
        0,
        0, 0, 0, 0,
        0, 0, altitude
    )


# 🛬 Land
def land(drone):
    print("🛬 Landing drone")

    drone.mav.command_long_send(
        drone.target_system,
        drone.target_component,
        mavutil.mavlink.MAV_CMD_NAV_LAND,
        0,
        0, 0, 0, 0,
        0, 0, 0
    )

def set_nav(drone, x, y, z):
    drone.mav.set_position_target_local_ned_send(
    0,
    drone.target_system,
    drone.target_component,
    mavutil.mavlink.MAV_FRAME_LOCAL_NED,
    0b000111111000,
    x, y, z,
    0, 0, 0,
    0, 0, 0,
    0, 0
)

def set_nav_with_vel_yaw(drone, x, y, z, vx, vy, vz, yaw):
    drone.mav.set_position_target_local_ned_send(
        0,
        drone.target_system,
        drone.target_component,
        mavutil.mavlink.MAV_FRAME_LOCAL_NED,
        0b100111000000, # Enable Pos (0,1,2), Vel (3,4,5), Yaw (10). Disable Accel (6,7,8), Force (9), Yaw Rate (11)
        x, y, z,
        vx, vy, vz,
        0, 0, 0,
        yaw, 0
    )

def goto_global(drone, lat, lon, alt):
    print(f"🛰️ Navigating to {lat}, {lon} at {alt}m")
    drone.mav.set_position_target_global_int_send(
        0,  # time_boot_ms
        drone.target_system,
        drone.target_component,
        mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
        0b0000111111111000,  # type_mask
        int(lat * 1e7),
        int(lon * 1e7),
        alt,
        0, 0, 0, # vx, vy, vz
        0, 0, 0, # afx, afy, afz
        0, 0 # yaw, yaw_rate
    )

def drop_payload(drone, servo_channel=9, pwm=1900):
    print(f"💣 Dropping payload from Drone {drone.target_system} (Channel {servo_channel}, PWM {pwm})")
    drone.mav.command_long_send(
        drone.target_system,
        drone.target_component,
        mavutil.mavlink.MAV_CMD_DO_SET_SERVO,
        0, # confirmation
        servo_channel,
        pwm,
        0, 0, 0, 0, 0 # param3-7
    )

def rtl(drone):
    print(f"🏠 Drone {drone.target_system} Returning to Launch (RTL)")
    drone.mav.command_long_send(
        drone.target_system,
        drone.target_component,
        mavutil.mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH,
        0,
        0, 0, 0, 0, 0, 0, 0
    )
