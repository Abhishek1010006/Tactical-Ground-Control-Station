# ==============================================================================
# api_server/map.py — Offline/Online Map Tile Server and Pack Management
# ==============================================================================
# This module handles everything related to serving map tiles to the Electron
# frontend's Leaflet map. It supports three tile sources:
#
#   1. LOCAL (Offline MBTiles) — Reads tiles from .mbtiles SQLite databases
#      stored in the electron/tiles/ directory. Multiple packs are aggregated.
#
#   2. ONLINE (Live Fetch) — If a tile is not found locally, it is fetched from
#      Google Satellite (or a custom URL set via GCS_ONLINE_TILE_URL env var),
#      served to the client, and cached in online_cache.mbtiles for future use.
#
#   3. OVERZOOM (Parent Fallback) — If neither local nor online tiles are
#      available, the server looks for a parent tile at a lower zoom level and
#      serves it as a fallback (the client handles upscaling).
#
# Additionally, it provides endpoints for:
#   - Listing, renaming, and deleting offline tile packs.
#   - Downloading new tile regions via a background thread.
#   - Checking online tile availability.
#   - Hot-reloading MBTiles databases after downloads complete.
#
# Endpoints registered:
#   GET    /tiles/metadata          — Aggregated metadata across all loaded packs.
#   GET    /tiles/debug             — Debug info (pack count + metadata).
#   GET    /tiles/online_status     — Check if online tile source is reachable.
#   POST   /tiles/reload            — Hot-reload all MBTiles databases.
#   GET    /tiles/<z>/<x>/<y>       — Serve a single map tile (local/online/overzoom).
#   GET    /download_map/status     — Check background download progress.
#   POST   /download_map            — Start a background tile download job.
#   GET    /tiles/packs             — List all installed tile packs with metadata.
#   DELETE /tiles/packs/<pack_id>   — Delete a tile pack file.
#   PATCH  /tiles/packs/<pack_id>   — Rename a tile pack.
# ==============================================================================

from flask import jsonify, request, send_file
import base64
import io
import math
import os
import re
import sqlite3
import subprocess
import sys
import threading
import urllib.request

from .shared import project_root


# =============================================================================
# SECTION: Module-Level State
# =============================================================================
# databases: list of loaded MBTiles connections with metadata.
# database_lock: RLock protecting concurrent access to the databases list.

databases = []
database_lock = threading.RLock()

# Online tile source configuration (can be overridden via environment variable)
ONLINE_TILE_URL = os.environ.get(
    "GCS_ONLINE_TILE_URL",
    "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
)
ONLINE_TILE_TIMEOUT = 5
ONLINE_CACHE_NAME = "online_cache"
PROTECTED_MBTILES = {"online_cache.mbtiles"}

# Background download job status tracker
map_download_job = {
    "status": "idle",
    "name": "",
    "bbox": "",
    "zoom": "",
    "message": "",
    "output_file": "",
}


# =============================================================================
# SECTION: Path Helpers
# =============================================================================

def tiles_dir():
    """Return the absolute path to the electron/tiles/ directory, creating it if needed."""
    path = os.path.join(project_root(), "electron", "tiles")
    os.makedirs(path, exist_ok=True)
    return path


def online_cache_path():
    """Return the path to the online tile cache MBTiles file."""
    return os.path.join(tiles_dir(), f"{ONLINE_CACHE_NAME}.mbtiles")


def safe_pack_basename(name):
    """Sanitize a user-provided pack name to a filesystem-safe string."""
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", (name or "").strip()).strip("._")
    return safe or "downloaded_map"


# =============================================================================
# SECTION: Tile Math Utilities
# =============================================================================

def tile_bounds_for_bbox(bounds, zoom):
    """Convert a geographic bounding box to tile coordinate ranges at a given zoom level."""
    min_lon, min_lat, max_lon, max_lat = bounds

    def deg2num(lat_deg, lon_deg):
        """Convert lat/lon to Web Mercator tile coordinates."""
        lat_rad = math.radians(max(min(lat_deg, 85.05112878), -85.05112878))
        n = 2 ** zoom
        x = int((lon_deg + 180.0) / 360.0 * n)
        y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
        return max(0, min(n - 1, x)), max(0, min(n - 1, y))

    x_min, y_max = deg2num(min_lat, min_lon)
    x_max, y_min = deg2num(max_lat, max_lon)
    return min(x_min, x_max), max(x_min, x_max), min(y_min, y_max), max(y_min, y_max)


def zoom_coverage(conn, bounds, minzoom, maxzoom):
    """Calculate tile coverage statistics for each zoom level in a database."""
    coverage = []
    usable_maxzoom = minzoom
    try:
        cursor = conn.cursor()
        for zoom in range(minzoom, maxzoom + 1):
            cursor.execute("SELECT COUNT(*) FROM tiles WHERE zoom_level=?", (zoom,))
            count = int(cursor.fetchone()[0] or 0)
            expected = 0
            ratio = 0.0
            if bounds:
                x_min, x_max, y_min, y_max = tile_bounds_for_bbox(bounds, zoom)
                expected = (x_max - x_min + 1) * (y_max - y_min + 1)
                ratio = count / expected if expected else 0.0
            complete = count > 0 and (not expected or ratio >= 0.95)
            if complete:
                usable_maxzoom = zoom
            coverage.append({
                "zoom": zoom,
                "tiles": count,
                "expected": expected,
                "coverage": round(ratio, 4) if expected else None,
                "complete": complete,
            })
    except Exception as exc:
        print(f"[MBTiles] Could not inspect zoom coverage: {exc}", flush=True)
    return usable_maxzoom, coverage


# =============================================================================
# SECTION: MBTiles Database Initialization
# =============================================================================

def init_mbtiles():
    """Scan the tiles directory and load all .mbtiles databases into memory."""
    global databases
    with database_lock:
        # Close existing connections
        for db in databases:
            try:
                db["conn"].close()
            except Exception:
                pass
        databases = []

        root = tiles_dir()
        print(f"[MBTiles] Scanning {root} for offline databases...", flush=True)
        if not os.path.exists(root):
            print(f"[MBTiles] Warning: tiles directory not found at {root}", flush=True)
            return

        # Walk the tiles directory and open every .mbtiles file
        for dirpath, _, files in os.walk(root):
            for file in files:
                if not file.endswith(".mbtiles"):
                    continue
                db_path = os.path.join(dirpath, file)
                try:
                    conn = sqlite3.connect(db_path, check_same_thread=False)
                    cursor = conn.cursor()
                    cursor.execute("SELECT name, value FROM metadata")
                    meta = {row[0]: row[1] for row in cursor.fetchall()}

                    # Parse bounds from metadata
                    bounds = None
                    bounds_string = meta.get("bounds")
                    if bounds_string:
                        try:
                            bounds = [float(value) for value in bounds_string.split(",")]
                        except Exception:
                            bounds = None

                    minzoom = int(meta.get("minzoom", 0))
                    maxzoom = int(meta.get("maxzoom", 18))
                    usable_maxzoom, coverage = zoom_coverage(conn, bounds, minzoom, maxzoom)

                    databases.append({
                        "conn": conn,
                        "meta": meta,
                        "file": file,
                        "path": db_path,
                        "usable_maxzoom": usable_maxzoom,
                        "coverage": coverage,
                    })
                    print(f"[MBTiles] Loaded: {file} (name: {meta.get('name', 'N/A')}, usable z{minzoom}-z{usable_maxzoom})", flush=True)
                except Exception as exc:
                    print(f"[MBTiles] Failed to load {file}: {exc}", flush=True)


# =============================================================================
# SECTION: Aggregated Metadata Across All Loaded Packs
# =============================================================================

def get_aggregated_metadata():
    """Merge metadata from all loaded MBTiles databases into a single summary."""
    if not databases:
        return {
            "minzoom": 0,
            "maxzoom": 22,
            "usable_maxzoom": 22,
            "bounds": [-180, -85, 180, 85],
            "center": [20.5937, 78.9629, 5],
            "format": "png",
            "name": "No MBTiles loaded",
            "sources": [],
        }

    minzoom = 22
    maxzoom = 0
    usable_maxzoom = 0
    union_bounds = None
    sources = []

    for db in databases:
        meta = db["meta"]
        mz = int(meta.get("minzoom", 0))
        mz_max = int(meta.get("maxzoom", 18))
        minzoom = min(minzoom, mz)
        maxzoom = max(maxzoom, mz_max)
        usable_maxzoom = max(usable_maxzoom, int(db.get("usable_maxzoom", mz_max)))

        # Parse and merge bounds
        bounds = None
        bounds_string = meta.get("bounds")
        if bounds_string:
            try:
                bounds = [float(value) for value in bounds_string.split(",")]
            except Exception:
                bounds = None
        if bounds and len(bounds) == 4:
            if not union_bounds:
                union_bounds = list(bounds)
            else:
                union_bounds[0] = min(union_bounds[0], bounds[0])
                union_bounds[1] = min(union_bounds[1], bounds[1])
                union_bounds[2] = max(union_bounds[2], bounds[2])
                union_bounds[3] = max(union_bounds[3], bounds[3])

        sources.append({
            "file": db["file"],
            "minzoom": mz,
            "maxzoom": mz_max,
            "usable_maxzoom": int(db.get("usable_maxzoom", mz_max)),
            "coverage": db.get("coverage", []),
            "bounds": bounds,
            "name": meta.get("name", db["file"]),
            "format": meta.get("format", "png"),
        })

    # Calculate map center (default to India if no bounds)
    center_lon = 78.9629
    center_lat = 20.5937
    center_zoom = minzoom
    if union_bounds:
        center_lon = (union_bounds[0] + union_bounds[2]) / 2.0
        center_lat = (union_bounds[1] + union_bounds[3]) / 2.0

    # Try to use the first database's explicit center metadata
    first_db = databases[0]
    center_string = first_db["meta"].get("center")
    if center_string:
        try:
            center_parts = [float(value) for value in center_string.split(",")]
            if len(center_parts) >= 2:
                center_lon = center_parts[0]
                center_lat = center_parts[1]
                if len(center_parts) >= 3:
                    center_zoom = int(center_parts[2])
        except Exception:
            pass

    return {
        "minzoom": minzoom,
        "maxzoom": maxzoom,
        "usable_maxzoom": usable_maxzoom,
        "bounds": union_bounds or [-180, -85, 180, 85],
        "center": [center_lat, center_lon, center_zoom],
        "format": first_db["meta"].get("format", "png"),
        "name": ", ".join(db["meta"].get("name", db["file"]) for db in databases),
        "sources": sources,
    }


# =============================================================================
# SECTION: Tile Response Builder
# =============================================================================

def tile_response(tile_data, cache_control="public, max-age=3600", overzoom_from=None, source="local"):
    """Build an HTTP response for a tile image with appropriate headers."""
    # Auto-detect image format from magic bytes
    mimetype = "image/png"
    if len(tile_data) > 2:
        if tile_data[0] == 0xFF and tile_data[1] == 0xD8:
            mimetype = "image/jpeg"
        elif tile_data[0] == 0x47 and tile_data[1] == 0x49:
            mimetype = "image/gif"
        elif tile_data[0] == 0x52 and tile_data[1] == 0x49:
            mimetype = "image/webp"

    response = send_file(io.BytesIO(tile_data), mimetype=mimetype)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Cache-Control"] = cache_control
    response.headers["X-Tile-Source"] = source
    if overzoom_from is not None:
        response.headers["X-Overzoom-From"] = str(overzoom_from)
    return response


# =============================================================================
# SECTION: Local Tile Queries
# =============================================================================

def query_local_tile(z, x, y):
    """Search all loaded MBTiles databases for a tile at the given coordinates."""
    tms_row = (2 ** z - 1) - y   # Convert XYZ (slippy map) to TMS row
    with database_lock:
        for db in databases:
            try:
                cursor = db["conn"].cursor()
                cursor.execute(
                    "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                    (z, x, tms_row),
                )
                row = cursor.fetchone()
                if row and row[0]:
                    return row[0], db
            except Exception as exc:
                print(f"Error querying tile z={z}, x={x}, y={y} from {db['file']}: {exc}", flush=True)
    return None, None


def query_parent_tile(z, x, y):
    """Walk up the zoom tree to find the nearest ancestor tile (for overzooming)."""
    for parent_z in range(z - 1, -1, -1):
        shift = z - parent_z
        parent_x = x >> shift
        parent_y = y >> shift
        tile_data, db = query_local_tile(parent_z, parent_x, parent_y)
        if tile_data:
            return tile_data, db, parent_z
    return None, None, None


# =============================================================================
# SECTION: Online Tile Fetching & Caching
# =============================================================================

def fetch_online_tile(z, x, y):
    """Fetch a tile from the online satellite source and cache it locally."""
    if not ONLINE_TILE_URL:
        return None
    try:
        url = ONLINE_TILE_URL.format(z=z, x=x, y=y)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with urllib.request.urlopen(req, timeout=ONLINE_TILE_TIMEOUT) as res:
            content_type = res.headers.get("Content-Type", "").lower()
            content = res.read()
            if res.status == 200 and content_type.startswith("image/") and len(content) > 256:
                store_online_tile(z, x, y, content, content_type)
                return content
    except Exception:
        pass
    return None


def store_online_tile(z, x, y, tile_data, content_type):
    """Cache a fetched online tile into the online_cache.mbtiles database."""
    try:
        conn = sqlite3.connect(online_cache_path(), timeout=10)
        cursor = conn.cursor()

        # Ensure tables exist
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

        # Determine format from content type
        fmt = "jpg" if "jpeg" in content_type or "jpg" in content_type else "png"
        metadata = [
            ("name", ONLINE_CACHE_NAME),
            ("type", "baselayer"),
            ("version", "1.0"),
            ("description", "Online tiles cached while browsing"),
            ("format", fmt),
            ("bounds", "-180,-85,180,85"),
            ("minzoom", "0"),
            ("maxzoom", str(z)),
        ]
        for key, value in metadata:
            if key == "maxzoom":
                # Keep the highest zoom level seen so far
                cursor.execute("SELECT value FROM metadata WHERE name='maxzoom'")
                row = cursor.fetchone()
                value = str(max(z, int(row[0]))) if row and str(row[0]).isdigit() else str(z)
            cursor.execute("INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)", (key, value))

        # Store the tile data (convert Y to TMS row)
        tms_row = (2 ** z - 1) - y
        cursor.execute(
            "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
            (z, x, tms_row, sqlite3.Binary(tile_data)),
        )
        conn.commit()
        conn.close()
    except Exception as exc:
        print(f"[OnlineCache] Could not cache tile z={z}, x={x}, y={y}: {exc}", flush=True)


# =============================================================================
# SECTION: Tile Pack Metadata Reader
# =============================================================================

def read_pack_meta(db_path):
    """Read metadata and tile count from a standalone MBTiles file."""
    meta = {}
    tile_count = 0
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT name, value FROM metadata")
        meta = {row[0]: row[1] for row in cursor.fetchall()}
        cursor.execute("SELECT COUNT(*) FROM tiles")
        tile_count = int(cursor.fetchone()[0] or 0)
        conn.close()
    except Exception as exc:
        print(f"[MBTiles] Could not read pack metadata for {db_path}: {exc}", flush=True)
    return meta, tile_count


def pack_entry(db_path):
    """Build a JSON-serializable summary dict for a tile pack file."""
    filename = os.path.basename(db_path)
    meta, tile_count = read_pack_meta(db_path)
    bounds = None
    bounds_string = meta.get("bounds")
    if bounds_string:
        try:
            bounds = [float(value) for value in bounds_string.split(",")]
        except Exception:
            bounds = None
    return {
        "id": filename,
        "filename": filename,
        "name": meta.get("name") or os.path.splitext(filename)[0],
        "path": db_path,
        "size_bytes": os.path.getsize(db_path) if os.path.isfile(db_path) else 0,
        "tile_count": tile_count,
        "minzoom": int(meta.get("minzoom", 0)) if str(meta.get("minzoom", "")).isdigit() else meta.get("minzoom"),
        "maxzoom": int(meta.get("maxzoom", 0)) if str(meta.get("maxzoom", "")).isdigit() else meta.get("maxzoom"),
        "bounds": bounds,
        "format": meta.get("format", "jpg"),
        "description": meta.get("description", ""),
        "protected": filename in PROTECTED_MBTILES,
    }


# =============================================================================
# SECTION: Flask Route Registration
# =============================================================================

def register_map_routes(app):
    """Register all map/tile related endpoints on the Flask app."""

    # --- Tile Metadata ---
    @app.route("/tiles/metadata")
    def tiles_metadata():
        """Return aggregated metadata across all loaded tile packs."""
        response = jsonify(get_aggregated_metadata())
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    # --- Tile Debug Info ---
    @app.route("/tiles/debug")
    def tiles_debug():
        """Return debug information about loaded tile databases."""
        response = jsonify({
            "mbtiles_files": len(databases),
            "metadata": get_aggregated_metadata(),
        })
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    # --- Online Tile Availability Check ---
    @app.route("/tiles/online_status")
    def tiles_online_status():
        """Probe the online tile source to check if it is reachable."""
        online = False
        if ONLINE_TILE_URL:
            try:
                probe_url = ONLINE_TILE_URL.format(z=0, x=0, y=0)
                req = urllib.request.Request(probe_url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
                with urllib.request.urlopen(req, timeout=ONLINE_TILE_TIMEOUT) as res:
                    online = res.status == 200 and res.headers.get("Content-Type", "").lower().startswith("image/")
            except Exception:
                online = False
        response = jsonify({"online": online, "maxzoom": 22 if online else get_aggregated_metadata().get("usable_maxzoom", 0)})
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    # --- Hot-Reload MBTiles Databases ---
    @app.route("/tiles/reload", methods=["POST"])
    def tiles_reload_route():
        """Re-scan the tiles directory and reload all MBTiles databases."""
        init_mbtiles()
        response = jsonify({"ok": True, "loaded": len(databases)})
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    # --- Serve a Single Map Tile ---
    @app.route("/tiles/<int:z>/<int:x>/<int:y>")
    def serve_tile(z, x, y):
        """Serve a tile from local MBTiles, online source, or parent overzoom."""
        max_coord = (2 ** z) - 1
        # 1x1 transparent PNG fallback
        fallback_1x1 = b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPg4OQBAAA6AB7XgWXrAAAAAElFTkSuQmCC"

        # Validate tile coordinates
        if x > max_coord or y > max_coord or z < 0 or z > 30 or x < 0 or y < 0:
            return tile_response(base64.b64decode(fallback_1x1), cache_control="no-cache", source="fallback")

        # Try local databases first
        tile_data, _ = query_local_tile(z, x, y)
        if tile_data:
            return tile_response(tile_data, source="local")

        # Try fetching from online source
        online_data = fetch_online_tile(z, x, y)
        if online_data:
            return tile_response(online_data, cache_control="public, max-age=86400", source="online")

        # Fallback to parent tile at lower zoom (overzoom)
        parent_data, _, parent_z = query_parent_tile(z, x, y)
        if parent_data:
            return tile_response(parent_data, source="local-overzoom", overzoom_from=parent_z)

        # No tile found anywhere — return transparent fallback
        return tile_response(base64.b64decode(fallback_1x1), cache_control="no-cache", source="fallback")

    # --- Background Map Download Status ---
    @app.route("/download_map/status", methods=["GET"])
    def download_map_status():
        """Return the current status of the background tile download job."""
        response = jsonify({**map_download_job, "storage_dir": tiles_dir()})
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    # --- Start Background Map Download ---
    @app.route("/download_map", methods=["POST"])
    def download_map():
        """Start a background tile download job for a specified region and zoom range."""
        global map_download_job
        data = request.json or {}
        bbox = data.get("bbox")
        zoom = data.get("zoom")
        name = safe_pack_basename(data.get("name", "downloaded_map"))
        if not bbox or not zoom:
            return jsonify({"error": "bbox and zoom are required"}), 400
        if map_download_job.get("status") == "running":
            return jsonify({"error": "A download is already in progress.", "download": map_download_job}), 409

        script_path = os.path.join(project_root(), "electron", "tools", "download_tiles.py")
        output_dir = tiles_dir()
        output_file = os.path.join(output_dir, f"{name}.mbtiles")
        map_download_job = {
            "status": "running",
            "name": name,
            "bbox": bbox,
            "zoom": zoom,
            "message": "Downloading tiles...",
            "output_file": output_file,
        }

        def run_downloader():
            """Background thread that executes the download_tiles.py script."""
            global map_download_job
            try:
                print(f"[MapDownloader] Executing: {sys.executable} {script_path} --bbox {bbox} --zoom {zoom} --output {output_dir} --name {name}", flush=True)
                result = subprocess.run([
                    sys.executable,
                    script_path,
                    "--bbox", bbox,
                    "--zoom", zoom,
                    "--output", output_dir,
                    "--name", name,
                ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                if result.returncode == 0:
                    print(f"[MapDownloader] Map download succeeded: {output_file}", flush=True)
                    map_download_job = {**map_download_job, "status": "done", "message": f"Saved to {output_file}", "output_file": output_file}
                    init_mbtiles()
                else:
                    err = (result.stderr or result.stdout or "unknown error").strip()
                    print(f"[MapDownloader] Downloader failed with exit code {result.returncode}.\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}", flush=True)
                    map_download_job = {**map_download_job, "status": "error", "message": err[:500] or f"Exit code {result.returncode}"}
            except Exception as exc:
                print(f"[MapDownloader] Exception running downloader: {exc}", flush=True)
                map_download_job = {**map_download_job, "status": "error", "message": str(exc)}

        threading.Thread(target=run_downloader, daemon=True).start()
        response = jsonify({
            "status": "started",
            "bbox": bbox,
            "zoom": zoom,
            "name": name,
            "storage_dir": output_dir,
            "output_file": output_file,
            "download": map_download_job,
        })
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    # --- List All Tile Packs ---
    @app.route("/tiles/packs", methods=["GET"])
    def list_tile_packs():
        """Return a list of all installed tile packs with metadata and download status."""
        packs = []
        root = tiles_dir()
        if os.path.isdir(root):
            for dirpath, _, files in os.walk(root):
                for file in sorted(files):
                    if file.endswith(".mbtiles"):
                        packs.append(pack_entry(os.path.join(dirpath, file)))
        packs.sort(key=lambda pack: pack["filename"].lower())
        meta = get_aggregated_metadata()
        response = jsonify({
            "storage_dir": root,
            "packs": packs,
            "download": dict(map_download_job),
            "map": {
                "online_tile_url": "configured online raster source",
                "tile_format": "256px raster via /tiles/{z}/{x}/{y}",
                "loaded_packs": len(packs),
                "usable_maxzoom": meta.get("usable_maxzoom"),
                "bounds": meta.get("bounds"),
            },
        })
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    # --- Delete a Tile Pack ---
    @app.route("/tiles/packs/<pack_id>", methods=["DELETE"])
    def delete_tile_pack(pack_id):
        """Delete a tile pack file from disk and reload databases."""
        # Validate the pack ID to prevent path traversal
        if not pack_id or ".." in pack_id or "/" in pack_id or "\\" in pack_id:
            return jsonify({"error": "invalid pack id"}), 400
        if not pack_id.endswith(".mbtiles"):
            pack_id = f"{pack_id}.mbtiles"
        if pack_id in PROTECTED_MBTILES:
            return jsonify({"error": "This pack is managed automatically and cannot be deleted."}), 403

        db_path = os.path.join(tiles_dir(), pack_id)
        if not os.path.isfile(db_path):
            return jsonify({"error": "pack not found"}), 404

        # Close the database connection before deleting the file
        for db in list(databases):
            if db.get("file") == pack_id:
                try:
                    db["conn"].close()
                except Exception:
                    pass
                databases.remove(db)

        try:
            os.remove(db_path)
        except OSError as exc:
            return jsonify({"error": str(exc)}), 500

        init_mbtiles()
        response = jsonify({"ok": True, "deleted": pack_id, "loaded": len(databases)})
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    # --- Rename a Tile Pack ---
    @app.route("/tiles/packs/<pack_id>", methods=["PATCH"])
    def rename_tile_pack(pack_id):
        """Rename a tile pack file and update its internal metadata."""
        data = request.json or {}
        new_name = safe_pack_basename(data.get("name", ""))
        if not new_name:
            return jsonify({"error": "name is required"}), 400

        # Validate the pack ID
        if not pack_id or ".." in pack_id or "/" in pack_id or "\\" in pack_id:
            return jsonify({"error": "invalid pack id"}), 400
        if not pack_id.endswith(".mbtiles"):
            pack_id = f"{pack_id}.mbtiles"
        if pack_id in PROTECTED_MBTILES:
            return jsonify({"error": "This pack cannot be renamed."}), 403

        old_path = os.path.join(tiles_dir(), pack_id)
        if not os.path.isfile(old_path):
            return jsonify({"error": "pack not found"}), 404

        new_filename = f"{new_name}.mbtiles"
        new_path = os.path.join(tiles_dir(), new_filename)
        if os.path.exists(new_path) and os.path.abspath(new_path) != os.path.abspath(old_path):
            return jsonify({"error": f"A pack named {new_filename} already exists."}), 409

        try:
            # Rename the file on disk
            if os.path.abspath(old_path) != os.path.abspath(new_path):
                os.rename(old_path, new_path)
            # Update the internal metadata name
            conn = sqlite3.connect(new_path)
            conn.execute("CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT, PRIMARY KEY (name))")
            conn.execute("INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)", ("name", new_name))
            conn.commit()
            conn.close()
        except OSError as exc:
            return jsonify({"error": str(exc)}), 500

        init_mbtiles()
        response = jsonify({"ok": True, "id": new_filename, "name": new_name})
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response
