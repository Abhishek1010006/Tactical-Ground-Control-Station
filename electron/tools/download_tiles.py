# ==============================================================================
# electron/tools/download_tiles.py — Offline Map Tile Downloader
# ==============================================================================
# This script downloads satellite map tiles from Google Maps (or another source)
# for a specified bounding box and zoom level range, saving them directly into
# an MBTiles SQLite database.
#
# It is executed as a background process by the Flask API (api_server/map.py)
# when the user starts a download from the UI.
#
# Key features:
#   - Calculates required Web Mercator tile coordinates from GPS bounding boxes.
#   - Skips empty, placeholder, or previously downloaded tiles.
#   - Uses ThreadPoolExecutor for fast concurrent downloads.
#   - Pings the Flask API /tiles/reload endpoint when finished to hot-reload maps.
# ==============================================================================

import os
import argparse
import math
import requests
import sqlite3
from tqdm import tqdm
import concurrent.futures
import re


# =============================================================================
# SECTION: Tile Coordinate Math
# =============================================================================

def deg2num(lat_deg, lon_deg, zoom):
    """Convert GPS coordinates (lat, lon) to Slippy Map (Web Mercator) tile coordinates."""
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return (xtile, ytile)


# =============================================================================
# SECTION: Downloading & SQLite Storage
# =============================================================================

def download_and_store_tile(z, x, y, db_path):
    """Download a single tile and insert it into the MBTiles database."""
    url = f"https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    
    # MBTiles specification uses TMS (origin at bottom-left), while Google uses Slippy (origin top-left)
    tms_row = (2 ** z - 1) - y
    
    # 1. Check if tile already exists in database
    try:
        conn = sqlite3.connect(db_path, timeout=30)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT 1 FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? LIMIT 1",
            (z, x, tms_row)
        )
        exists = cursor.fetchone()
        conn.close()
        if exists:
            return True  # already exists
    except Exception as e:
        print(f"\n[DB Check Error] z={z}, x={x}, y={y}: {e}")
        
    try:
        r = requests.get(url, headers=headers, timeout=10)
        
        # 2. Verify HTTP Status
        if r.status_code != 200:
            print(f"[REJECTED] {url} - Status: {r.status_code}")
            return False
            
        # 3. Verify Content-Type
        content_type = r.headers.get('Content-Type', '').lower()
        if 'image/jpeg' not in content_type and 'image/png' not in content_type:
            print(f"[REJECTED] {url} - Invalid Content-Type: {content_type}")
            return False
            
        tile_data = r.content
        size_bytes = len(tile_data)
        
        # 4. Verify minimum size threshold
        # (Typical satellite tiles are > 10KB, but uniform ocean/desert can be ~1-2KB)
        if size_bytes < 1000:
            print(f"[REJECTED] {url} - Size too small (Blank/Empty): {size_bytes} bytes")
            return False
            
        # 5. Reject exact known placeholders
        # 6987 bytes = Esri "Map data not yet available" placeholder
        # 8066 bytes = Google Satellite missing map tile (blue square)
        if size_bytes in [6987, 8066]:
            print(f"[REJECTED] {url} - Known Placeholder Image ({size_bytes} bytes)")
            return False

        # 6. Write valid tile to SQLite
        conn = sqlite3.connect(db_path, timeout=30)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
            (z, x, tms_row, sqlite3.Binary(tile_data))
        )
        conn.commit()
        conn.close()
        
        print(f"[SAVED] {url} - {content_type} - {size_bytes} bytes")
        return True
        
    except Exception as e:
        print(f"[ERROR] {url} - Exception: {e}")
        return False


# =============================================================================
# SECTION: Main Script Entry Point
# =============================================================================

def main():
    """Parse CLI arguments, initialize the MBTiles database, and dispatch download threads."""
    parser = argparse.ArgumentParser(description="Download Esri Satellite tiles directly into offline MBTiles.")
    parser.add_argument("--bbox", required=True, help="Bounding box: min_lon,min_lat,max_lon,max_lat (e.g. '68,6,97,37')")
    parser.add_argument("--zoom", required=True, help="Zoom range: min-max (e.g. '3-12')")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--name", default="downloaded_map", help="Output pack name without extension")
    args = parser.parse_args()

    min_lon, min_lat, max_lon, max_lat = map(float, args.bbox.split(','))
    z_min, z_max = map(int, args.zoom.split('-'))

    os.makedirs(args.output, exist_ok=True)
    safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", args.name).strip("._") or "downloaded_map"
    db_path = os.path.join(args.output, f"{safe_name}.mbtiles")
    
    print(f"[MBTiles Downloader] Initializing database: {db_path}")
    
    # Initialize MBTiles database and tables
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS tiles (
            zoom_level INTEGER,
            tile_column INTEGER,
            tile_row INTEGER,
            tile_data BLOB,
            PRIMARY KEY (zoom_level, tile_column, tile_row)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS metadata (
            name TEXT,
            value TEXT,
            PRIMARY KEY (name)
        )
    """)
    
    # Insert or update standard MBTiles metadata
    metadata = [
        ("name", safe_name),
        ("type", "baselayer"),
        ("version", "1.0"),
        ("description", f"Offline satellite tiles downloaded for region lon=[{min_lon},{max_lon}] lat=[{min_lat},{max_lat}]"),
        ("format", "jpg"),
        ("bounds", f"{min_lon},{min_lat},{max_lon},{max_lat}"),
        ("minzoom", str(z_min)),
        ("maxzoom", str(z_max))
    ]
    for key, val in metadata:
        cursor.execute("INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)", (key, val))
        
    conn.commit()
    conn.close()

    # Generate a list of all required tile coordinates
    tasks = []
    for z in range(z_min, z_max + 1):
        x_min, y_max = deg2num(min_lat, min_lon, z)
        x_max, y_min = deg2num(max_lat, max_lon, z)
        
        # Clamp coordinates to valid Web Mercator ranges
        n = 2.0 ** z
        x_min = max(0, min(int(n) - 1, x_min))
        x_max = max(0, min(int(n) - 1, x_max))
        y_min = max(0, min(int(n) - 1, y_min))
        y_max = max(0, min(int(n) - 1, y_max))
        
        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                tasks.append((z, x, y))
                 
    print(f"Total tiles to download: {len(tasks)}")
    if len(tasks) > 100000:
        print("WARNING: Downloading more than 100,000 tiles. This might take a while.")

    success = 0
    # Use thread pool to download and insert concurrently
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(download_and_store_tile, z, x, y, db_path): (z, x, y) for z, x, y in tasks}
        
        for future in tqdm(concurrent.futures.as_completed(futures), total=len(futures)):
            if future.result():
                success += 1
                
    print(f"Successfully downloaded and stored {success}/{len(tasks)} tiles in MBTiles database.")
    
    # Hot-reload the Electron tile server
    try:
        r = requests.post("http://127.0.0.1:5000/tiles/reload", timeout=5)
        if r.status_code == 200:
            print("[Reload] Successfully hot-reloaded newly downloaded MBTiles in Electron!")
        else:
            print("[Reload] Electron reload endpoint returned code:", r.status_code)
    except Exception as e:
        print("[Reload] Could not trigger Electron map server hot-reload (Electron might not be running yet):", e)


if __name__ == "__main__":
    main()
