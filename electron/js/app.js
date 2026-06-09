let map;
let tileLayer;
let droneMarkers = {};
let targetMarkers = {};  // keyed by target.id — { marker, circle }
let dropMarkers   = {};  // keyed by "droneId_targetId" — en-route drop locations
let _targetIdSeq = 0;   // auto-increment for local target IDs
let altHistory = {}; // { drone_id: [alt, alt, ...] } MAX 60
let appState = {
  drones: {},
  roles: { surveillance: null, attack: [] },
  targets: [],       // Multi-target array: [{id, lat, lon, alt, source, assignedDroneId, status, time}]
  dispatched: [],    // Legacy compat — kept for mission poll sync
  markMode: false
};
let autoFollow = false;

const droneUIStabilizer = {
  history: {},
  stabilize(state) {
    if (!state) return state;
    const stabilizedState = {};
    Object.keys(state).forEach(id => {
      const drone = state[id];
      if (!drone) return;
      if (!this.history[id]) {
        this.history[id] = {
          mode: { val: drone.mode, count: 1, stableVal: drone.mode },
          armed: { val: !!drone.armed, count: 1, stableVal: !!drone.armed },
          baseMode: { val: drone.base_mode, count: 1, stableVal: drone.base_mode }
        };
      }
      const hist = this.history[id];
      const stabilizedDrone = { ...drone };

      // 1. Mode
      const rawMode = drone.mode;
      if (hist.mode.val === rawMode) {
        hist.mode.count++;
      } else {
        hist.mode.val = rawMode;
        hist.mode.count = 1;
      }
      if (hist.mode.count >= 2) {
        hist.mode.stableVal = rawMode;
      }
      stabilizedDrone.mode = hist.mode.stableVal !== undefined ? hist.mode.stableVal : rawMode;

      // 2. Armed
      const rawArmed = !!drone.armed;
      if (hist.armed.val === rawArmed) {
        hist.armed.count++;
      } else {
        hist.armed.val = rawArmed;
        hist.armed.count = 1;
      }
      if (hist.armed.count >= 2) {
        hist.armed.stableVal = rawArmed;
      }
      stabilizedDrone.armed = hist.armed.stableVal !== undefined ? hist.armed.stableVal : rawArmed;

      // 3. Base Mode
      const rawBaseMode = drone.base_mode;
      if (hist.baseMode.val === rawBaseMode) {
        hist.baseMode.count++;
      } else {
        hist.baseMode.val = rawBaseMode;
        hist.baseMode.count = 1;
      }
      if (hist.baseMode.count >= 2) {
        hist.baseMode.stableVal = rawBaseMode;
      }
      stabilizedDrone.base_mode = hist.baseMode.stableVal !== undefined ? hist.baseMode.stableVal : rawBaseMode;

      stabilizedState[id] = stabilizedDrone;
    });
    return stabilizedState;
  }
};


function hasConnectedDrones() {
  return Object.keys(appState.drones || {}).length > 0;
}

window.dlConnected = false;

function requireFleetLinked(actionName) {
  if (!window.dlConnected) {
    if (window.gcsTerminal) {
      window.gcsTerminal.error('Not connected — click CONNECT first.', actionName);
    }
    return false;
  }
  if (!hasConnectedDrones()) {
    if (window.gcsTerminal) {
      window.gcsTerminal.error('No drones connected.', actionName);
    }
    return false;
  }
  return true;
}

window.requireFleetLinked = requireFleetLinked;

// Global button click ripple animation (covers .btn and .overlay-btn)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn, .overlay-btn');
  if (!btn || btn.disabled) return;
  btn.classList.remove('btn-clicked');
  void btn.offsetWidth; // force reflow to restart animation
  btn.classList.add('btn-clicked');
  btn.addEventListener('animationend', () => btn.classList.remove('btn-clicked'), { once: true });
});
/**
 * ==============================================================================
 * electron/js/app.js — Core GCS UI & Map Renderer
 * ==============================================================================
 * This is the primary frontend controller for SwarmGCS Tactical. It handles:
 *  - Rendering the Leaflet/MapLibre map and drone markers.
 *  - Polling the Python backend (/sync) for fleet telemetry and mission state.
 *  - Managing the global appState and rendering the left-hand fleet panels.
 *  - Handling the main UI action buttons (Connect, Arm, Disarm, Takeoff, RTL).
 *  - Coordinating the dynamic map overlays, modals, and toast notifications.
 * ==============================================================================
 */
const BASE_URL = 'http://127.0.0.1:5000';
// Used only while the local Python tile API is still starting.
const ONLINE_FALLBACK_TILES = ['https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'];
const ATTACK_ARRIVAL_RADIUS_M = 15;
let droneTargetStates = {};

window.clearDroneTargetArrival = function (targetId) {
  delete droneTargetStates[targetId];
};

// Place an amber drop-point marker at the drone's actual drop position
window.placeDropMarker = function (droneId, targetId, lat, lon) {
  if (typeof map === 'undefined' || !map) return;
  const key = `${droneId}_${targetId}`;
  // Remove any prior marker for this drone+target combo
  if (dropMarkers[key] && dropMarkers[key].marker) {
    dropMarkers[key].marker.remove();
  }
  const el = document.createElement('div');
  el.className = 'drop-icon';
  el.style.zIndex = '2'; // above target (1), below drone (10)
  el.innerHTML = `<div class="drop-badge"><span class="drop-badge-label">↓T${targetId}</span></div>`;

  const popup = new maplibregl.Popup({ offset: 15 }).setHTML(
    `<b>💥 DROP POINT</b><br>UAV #${droneId} → Target T${targetId}<br>LAT: ${lat.toFixed(6)}<br>LON: ${lon.toFixed(6)}<br><small>Payload released en-route</small>`
  );

  const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([lon, lat])
    .setPopup(popup)
    .addTo(map);

  dropMarkers[key] = { marker };
};

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const modalQueue = [];
let isModalOpen = false;

function processModalQueue() {
  if (isModalOpen || modalQueue.length === 0) return;
  const task = modalQueue.shift();

  isModalOpen = true;
  document.getElementById('modal-title').innerText = task.title;
  document.getElementById('modal-body').innerHTML = task.body;

  const footer = document.querySelector('.modal-footer');
  if (!footer) return;

  if (task.buttons && task.buttons.length > 0) {
    // Render custom multi-button layout
    footer.innerHTML = task.buttons.map((btn, idx) => {
      const cls = btn.class || 'btn modal-btn';
      return `<button id="modal-btn-custom-${idx}" class="${cls}">${btn.text}</button>`;
    }).join('');

    const close = () => {
      document.getElementById('center-modal-overlay').style.display = 'none';
      isModalOpen = false;
      processModalQueue();
    };

    task.buttons.forEach((btn, idx) => {
      const el = document.getElementById(`modal-btn-custom-${idx}`);
      if (el) {
        el.onclick = () => {
          if (btn.onClick) btn.onClick();
          close();
        };
      }
    });
  } else {
    // Render default two-button layout
    footer.innerHTML = `
      <button id="modal-btn-cancel" class="btn modal-btn cancel">ABORT</button>
      <button id="modal-btn-confirm" class="btn modal-btn confirm">PROCEED</button>
    `;

    const btnConfirm = document.getElementById('modal-btn-confirm');
    const btnCancel = document.getElementById('modal-btn-cancel');

    btnConfirm.innerText = task.confirmText || 'PROCEED';
    btnCancel.innerText = task.cancelText || 'ABORT';

    const overlay = document.getElementById('center-modal-overlay');
    overlay.style.display = 'flex';

    const close = () => {
      overlay.style.display = 'none';
      isModalOpen = false;
      btnConfirm.onclick = null;
      btnCancel.onclick = null;
      processModalQueue();
    };

    btnConfirm.onclick = () => {
      if (task.onConfirm) task.onConfirm();
      close();
    };

    btnCancel.onclick = () => {
      if (task.onCancel) task.onCancel();
      close();
    };
  }

  const overlay = document.getElementById('center-modal-overlay');
  overlay.style.display = 'flex';
}

function showCenterModal(title, body, confirmText, cancelText, onConfirm, onCancel) {
  modalQueue.push({ title, body, confirmText, cancelText, onConfirm, onCancel });
  alertBeep();
  processModalQueue();
}

function showCustomCenterModal(title, body, buttons) {
  modalQueue.push({ title, body, buttons });
  alertBeep();
  processModalQueue();
}

/** Confirmation modal for SWARM, ATTACK, LAUNCH ATTACK, and altitude set only. */
function confirmGcsAction(title, body, onConfirm, onCancel) {
  showCenterModal(
    title || 'CONFIRM ACTION',
    body || 'Proceed with this action?',
    'PROCEED',
    'CANCEL',
    onConfirm,
    onCancel || null
  );
}

window.confirmGcsAction = confirmGcsAction;

/** main.py step 4 — mode menu after drones are linked */
function showOperatingModeModal() {
  showCustomCenterModal(
    'SELECT OPERATING MODE',
    'Drones connected. Choose mode (same as <code>main.py</code>):<br><br>' +
    '<b>1.</b> Swarming — <code>swarm_controller</code><br>' +
    '<b>2.</b> Autonomous Attack — <code>parallel_attack_system</code>',
    [
      {
        text: '1 · SWARMING',
        class: 'btn modal-btn confirm',
        onClick: () => window.selectOperatingMode('swarm')
      },
      {
        text: '2 · AUTONOMOUS ATTACK',
        class: 'btn modal-btn confirm-amber',
        onClick: () => window.selectOperatingMode('attack')
      },
      {
        text: 'LATER',
        class: 'btn modal-btn btn-ghost',
        onClick: () => {
          if (window.gcsTerminal) {
            window.gcsTerminal.println('[UI] Mode selection postponed — use SWARM / ATTACK in navbar.', 'ui');
          }
        }
      }
    ]
  );
}

window.selectOperatingMode = async function selectOperatingMode(mode) {
  const isAttack = mode === 'attack';
  const button = document.getElementById(isAttack ? 'nav-btn-attack' : 'nav-btn-swarm');
  const name = isAttack ? 'ATTACK' : 'SWARM';

  if (!(await requireApiReadyForAction(name))) return;
  if (window.requireFleetLinked && !window.requireFleetLinked(name)) return;

  if (window.gcsTerminal) {
    window.gcsTerminal.println(
      `>> main.py mode ${isAttack ? '2' : '1'}: ${isAttack ? 'Autonomous Attack' : 'Swarming'}`,
      'sys'
    );
  }

  if (window.attackFlowApplyMode && button) {
    await window.attackFlowApplyMode(button, mode, name);
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Mode failed');
    document.querySelectorAll('.nav-center .btn-nav').forEach(b => b.classList.remove('active'));
    if (button) button.classList.add('active');
    showToast('success', `${name} MODE`, isAttack
      ? 'Parallel attack system — select surveillance UAV'
      : 'Swarm mode active');
  } catch (e) {
    if (window.gcsTerminal) window.gcsTerminal.error(e.message, name);
    showToast('error', 'MODE FAILED', e.message);
  }
};

function attachConfirm(btn, confirmText, actionFn) {
  let originalText = btn.innerText;
  btn.onclick = () => {
    if (btn.disabled) return;
    if (btn.dataset.pending === 'true') {
      btn.dataset.pending = 'false';
      btn.innerText = originalText;
      btn.classList.remove('confirm-mode');
      actionFn();
    } else {
      btn.dataset.pending = 'true';
      originalText = btn.innerText;
      btn.innerText = confirmText;
      btn.classList.add('confirm-mode');
      setTimeout(() => {
        if (btn.dataset.pending === 'true') {
          btn.dataset.pending = 'false';
          btn.innerText = originalText;
          btn.classList.remove('confirm-mode');
        }
      }, 3000);
    }
  };
}

function alertBeep() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  [0, 0.3, 0.6].forEach(t => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime + t);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
    osc.start(ctx.currentTime + t);
    osc.stop(ctx.currentTime + t + 0.2);
  });
}

function showToast(type, title, subtitle = '') {
  const container = document.getElementById('toast-container');
  const safeTitle = String(title || '').trim();
  const safeSubtitle = String(subtitle || '').trim();
  if (!safeTitle && !safeSubtitle) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="t-header">
      <div class="t-title">${safeTitle || 'NOTICE'}</div>
      <button class="t-close">✕</button>
    </div>
    ${safeSubtitle ? `<div class="t-sub">${safeSubtitle}</div>` : ''}
    ${type !== 'critical' ? `<div class="t-prog"></div>` : ''}
  `;
  container.prepend(toast);

  const closeBtn = toast.querySelector('.t-close');
  closeBtn.onclick = () => {
    toast.classList.add('toast-fadeout');
    setTimeout(() => toast.remove(), 200);
  };

  const timeoutMs = type === 'critical' ? 7000 : 4000;
  setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.add('toast-fadeout');
      setTimeout(() => toast.remove(), 200);
    }
  }, timeoutMs);
}

// ═══════════════════════════════════════════════════════════════
// TACTICAL MAP SYSTEM — Professional MBTiles offline renderer
// ═══════════════════════════════════════════════════════════════

// Tile statistics tracker
const mapStats = {
  loaded: 0, failed: 0, cacheHits: 0, visible: new Set(),
  minzoom: 0, maxzoom: 22
};

// Global dataset meta storage (map tiles)
let activeDatasetMeta = null;

function updateDebugOverlay() {
  const el = document.getElementById('map-debug-overlay');
  if (!el || el.style.display === 'none' || !map) return;

  const zoomEl = document.getElementById('dbg-zoom');
  const latEl = document.getElementById('dbg-lat');
  const lonEl = document.getElementById('dbg-lon');
  if (!zoomEl || !latEl || !lonEl) return;

  const center = map.getCenter();
  zoomEl.textContent = map.getZoom().toFixed(2);
  latEl.textContent = center.lat.toFixed(5);
  lonEl.textContent = center.lng.toFixed(5);
}
setInterval(updateDebugOverlay, 500);

// ─── Map Helpers ─────────────────────────────────────────────
function fitAll() {
  if (!map) return;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  let hasCoords = false;
  
  // Drones
  Object.keys(appState.drones).forEach(id => {
    const d = appState.drones[id];
    if (d && d.lat && d.lon) {
      if (d.lat < minLat) minLat = d.lat;
      if (d.lat > maxLat) maxLat = d.lat;
      if (d.lon < minLng) minLng = d.lon;
      if (d.lon > maxLng) maxLng = d.lon;
      hasCoords = true;
    }
  });

  // Targets
  appState.targets.forEach(t => {
    if (t.lat < minLat) minLat = t.lat;
    if (t.lat > maxLat) maxLat = t.lat;
    if (t.lon < minLng) minLng = t.lon;
    if (t.lon > maxLng) maxLng = t.lon;
    hasCoords = true;
  });

  if (hasCoords) {
    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
      padding: 50,
      maxZoom: 15
    });
  }
}

function updateTargetCirclesSource() {
  if (!map || !map.getSource('target-circles')) return;

  const features = appState.targets.map(tgt => {
    const points = [];
    const km = 0.1; // 100m = 0.1km
    const lat = tgt.lat;
    const lon = tgt.lon;
    
    // Simple circle approximation (64 points)
    for (let i = 0; i < 64; i++) {
      const angle = (i / 64) * Math.PI * 2;
      const dx = km * Math.cos(angle);
      const dy = km * Math.sin(angle);
      
      const dLat = dy / 111.32;
      const dLon = dx / (111.32 * Math.cos(lat * Math.PI / 180));
      
      points.push([lon + dLon, lat + dLat]);
    }
    points.push(points[0]); // close polygon

    return {
      type: 'Feature',
      properties: { id: tgt.id },
      geometry: {
        type: 'Polygon',
        coordinates: [points]
      }
    };
  });

  map.getSource('target-circles').setData({
    type: 'FeatureCollection',
    features: features
  });
}

// ─── Map initialisation ──────────────────────────────────────
function normalizeLng(lng) {
  const value = Number(lng);
  if (!Number.isFinite(value)) return 78.9629;
  let normalized = ((((value + 180) % 360) + 360) % 360) - 180;
  if (normalized <= -180) normalized = -179.999;
  if (normalized >= 180) normalized = 179.999;
  return normalized;
}

function clampLat(lat) {
  const value = Number(lat);
  if (!Number.isFinite(value)) return 20.5937;
  return Math.max(-85, Math.min(85, value));
}

function isWorldBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 4
    && bounds[0] <= -179 && bounds[2] >= 179
    && bounds[1] <= -84 && bounds[3] >= 84;
}

function effectiveLocalBounds(meta) {
  const sources = Array.isArray(meta?.sources) ? meta.sources : [];
  const boundedSources = sources.filter(source =>
    source.file !== 'online_cache.mbtiles'
    && Array.isArray(source.bounds)
    && source.bounds.length === 4
    && !isWorldBounds(source.bounds)
  );
  if (!boundedSources.length) return null;

  return boundedSources.reduce((bounds, source) => {
    const b = source.bounds.map(Number);
    if (!bounds) return [b[0], b[1], b[2], b[3]];
    return [
      Math.min(bounds[0], b[0]),
      Math.min(bounds[1], b[1]),
      Math.max(bounds[2], b[2]),
      Math.max(bounds[3], b[3])
    ];
  }, null);
}

async function waitForBackendApi(maxAttempts = 2) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(600) });
      if (res.ok) return true;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

let mapTileConfig = null;

async function requireApiReadyForAction(actionName) {
  const ready = await waitForBackendApi(5);
  if (ready) return true;

  const message = 'Backend API is still starting. Try again after CONNECT/health shows OK.';
  if (window.gcsTerminal) window.gcsTerminal.error(message, actionName);
  showToast('error', 'BACKEND NOT READY', message);
  return false;
}
window.requireApiReadyForAction = requireApiReadyForAction;

function createOnlineFallbackTileConfig() {
  return {
    fallbackOnline: true,
    meta: {
      minzoom: 0,
      maxzoom: 22,
      usable_maxzoom: 22,
      bounds: [-180, -85, 180, 85],
      center: [20.5937, 78.9629, 5],
      name: 'Online fallback',
      sources: []
    },
    onlineTilesAvailable: true,
    useDirectOnline: true,
    minZoom: 0,
    nativeMaxZoom: 22,
    maxZoom: 22,
    sourceMaxZoom: 22,
    initLat: 20.5937,
    initLon: 78.9629,
    initZoom: 5
  };
}

function tileUrlsForConfig(cfg, cacheBust) {
  if (cfg && (cfg.fallbackOnline || cfg.useDirectOnline)) return ONLINE_FALLBACK_TILES;
  return [`${BASE_URL}/tiles/{z}/{x}/{y}?cb=${cacheBust}`];
}

function updateMapTileLabels(cfg) {
  const tileStatus = document.getElementById('map-tile-status');
  const sourceLabel = document.getElementById('map-source-label');
  if (!cfg) return;

  if (cfg.fallbackOnline) {
    if (tileStatus) tileStatus.innerText = 'TILES: ONLINE FALLBACK';
    if (sourceLabel) sourceLabel.innerText = 'ONLINE MAP - local API starting';
    return;
  }

  if (cfg.useDirectOnline) {
    if (tileStatus) tileStatus.innerText = 'TILES: ONLINE SATELLITE';
    if (sourceLabel) sourceLabel.innerText = `ONLINE DIRECT - z${cfg.minZoom}-${cfg.maxZoom}`;
    return;
  }

  const hasLocalPacks = cfg.meta.sources && cfg.meta.sources.length > 0;
  if (tileStatus) {
    tileStatus.innerText = cfg.onlineTilesAvailable
      ? 'TILES: ONLINE + LOCAL DB'
      : (hasLocalPacks ? `TILES: MBTILES (${cfg.meta.sources.length})` : 'TILES: OFFLINE');
  }
  if (sourceLabel) {
    sourceLabel.innerText = cfg.onlineTilesAvailable
      ? `ONLINE + DB - z${cfg.minZoom}-${cfg.maxZoom}`
      : `OFFLINE DB - z${cfg.minZoom}-${cfg.nativeMaxZoom}`;
  }
}

async function fetchMapTileConfig() {
  let meta = {
    minzoom: 0,
    maxzoom: 22,
    bounds: [-180, -85, 180, 85],
    center: [20.5937, 78.9629, 5],
    name: 'OFFLINE',
    format: 'png',
    sources: []
  };
  let onlineTilesAvailable = false;

  try {
    const r = await fetch(`${BASE_URL}/tiles/metadata`);
    if (r.ok) {
      meta = await r.json();
      activeDatasetMeta = meta;
    }
  } catch (e) {
    console.warn('[Map] metadata fetch failed:', e.message);
  }

  try {
    const onlineRes = await fetch(`${BASE_URL}/tiles/online_status`);
    if (onlineRes.ok) {
      const onlineStatus = await onlineRes.json();
      onlineTilesAvailable = !!onlineStatus.online;
    }
  } catch (_) {}

  const minZoom = parseInt(meta.minzoom, 10) || 0;
  const nativeMaxZoom = parseInt(meta.usable_maxzoom ?? meta.maxzoom, 10) || 12;
  const maxZoom = 22;
  const sourceMaxZoom = onlineTilesAvailable ? maxZoom : nativeMaxZoom;

  const localBounds = effectiveLocalBounds(meta);
  let initLat = 20.5937;
  let initLon = 78.9629;
  let initZoom = 5;
  if (meta.center && meta.center.length >= 2) {
    const cLat = clampLat(meta.center[0]);
    const cLon = normalizeLng(meta.center[1]);
    if ((Math.abs(cLat) > 0.5 || Math.abs(cLon) > 0.5) && Math.abs(cLon) < 179.9) {
      initLat = cLat;
      initLon = cLon;
      if (meta.center.length >= 3 && meta.center[2]) initZoom = Number(meta.center[2]) || 5;
    }
  }

  if (localBounds && (!onlineTilesAvailable || Math.abs(initLon) >= 179.9 || isWorldBounds(meta.bounds))) {
    initLon = normalizeLng((localBounds[0] + localBounds[2]) / 2);
    initLat = clampLat((localBounds[1] + localBounds[3]) / 2);
    initZoom = Math.max(initZoom, 5);
  }

  return {
    meta,
    onlineTilesAvailable,
    useDirectOnline: onlineTilesAvailable,
    minZoom,
    nativeMaxZoom,
    maxZoom,
    sourceMaxZoom,
    initLat,
    initLon,
    initZoom,
    localBounds
  };
}

function applyTileConfigToMap(cfg) {
  if (!map || !cfg) return;
  const bust = Date.now().toString(36);
  if (map.getLayer('detail-tiles-layer')) map.removeLayer('detail-tiles-layer');
  if (map.getSource('detail-tiles')) map.removeSource('detail-tiles');

  map.addSource('detail-tiles', {
    type: 'raster',
    tiles: tileUrlsForConfig(cfg, bust),
    tileSize: 256,
    minzoom: cfg.minZoom,
    maxzoom: cfg.sourceMaxZoom
  });
  map.addLayer({
    id: 'detail-tiles-layer',
    type: 'raster',
    source: 'detail-tiles',
    minzoom: cfg.minZoom,
    maxzoom: cfg.maxZoom + 1
  });

  const tileStatus = document.getElementById('map-tile-status');
  const sourceLabel = document.getElementById('map-source-label');
  if (tileStatus) {
    tileStatus.innerText = cfg.onlineTilesAvailable
      ? 'TILES: ONLINE + LOCAL DB'
      : (cfg.meta.sources && cfg.meta.sources.length > 0
        ? `TILES: MBTILES (${cfg.meta.sources.length})`
        : 'TILES: OFFLINE');
  }
  if (sourceLabel) {
    sourceLabel.innerText = cfg.onlineTilesAvailable
      ? `ONLINE + DB · z${cfg.minZoom}-${cfg.maxZoom}`
      : `OFFLINE DB · z${cfg.minZoom}-${cfg.nativeMaxZoom}`;
  }
  updateMapTileLabels(cfg);
  if (cfg.onlineTilesAvailable || !cfg.localBounds) {
    map.setMaxBounds(null);
  } else {
    map.setMaxBounds([
      [cfg.localBounds[0], cfg.localBounds[1]],
      [cfg.localBounds[2], cfg.localBounds[3]]
    ]);
    const center = map.getCenter();
    const lng = normalizeLng(center.lng);
    const lat = clampLat(center.lat);
    if (
      lng < cfg.localBounds[0] || lng > cfg.localBounds[2]
      || lat < cfg.localBounds[1] || lat > cfg.localBounds[3]
    ) {
      map.jumpTo({
        center: [
          normalizeLng((cfg.localBounds[0] + cfg.localBounds[2]) / 2),
          clampLat((cfg.localBounds[1] + cfg.localBounds[3]) / 2)
        ],
        zoom: Math.min(Math.max(map.getZoom(), 5), cfg.maxZoom)
      });
    }
  }
  map.resize();
}

async function reloadMapTiles() {
  try {
    await fetch(`${BASE_URL}/tiles/reload`, { method: 'POST' });
  } catch (e) {
    console.warn('[Map] reload failed:', e.message);
  }
  mapTileConfig = await fetchMapTileConfig();
  if (map && mapTileConfig) {
    applyTileConfigToMap(mapTileConfig);
  }
  if (typeof window.refreshSettingsMapUI === 'function') {
    window.refreshSettingsMapUI();
  }
}
window.reloadMapTiles = reloadMapTiles;

async function initMap() {
  const backendUp = await waitForBackendApi();
  if (!backendUp) {
    console.warn('[Map] Tile server not ready yet — will retry.');
  }

  if (!backendUp && navigator.onLine) {
    mapTileConfig = createOnlineFallbackTileConfig();
  } else {
    mapTileConfig = await fetchMapTileConfig();
  }
  
  const { meta, onlineTilesAvailable, minZoom, nativeMaxZoom, maxZoom, sourceMaxZoom, initLat, initLon, initZoom, localBounds } = mapTileConfig;

  mapStats.minzoom = minZoom;
  mapStats.maxzoom = sourceMaxZoom;

  console.log(`[Map] Native zoom limit: ${nativeMaxZoom}, Source max zoom: ${sourceMaxZoom}, center: ${initLat}, ${initLon}`);

  const CACHE_BUST = Math.random().toString(36).slice(2, 8);

  // 2. Create map — restrict to data coverage bounds
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        'detail-tiles': {
          type: 'raster',
          tiles: tileUrlsForConfig(mapTileConfig, CACHE_BUST),
          tileSize: 256,
          minzoom: minZoom,
          maxzoom: sourceMaxZoom
        }
      },
      layers: [
        {
          id: 'background-layer',
          type: 'background',
          paint: {
            'background-color': '#08090C'
          }
        },
        {
          id: 'detail-tiles-layer',
          type: 'raster',
          source: 'detail-tiles',
          minzoom: minZoom,
          maxzoom: maxZoom + 1
        }
      ]
    },
    center: [initLon, initLat],
    zoom: initZoom,
    minZoom: 3,
    maxZoom: maxZoom,
    dragRotate: false,
    touchZoomRotate: false,
    renderWorldCopies: false,
    attributionControl: false
  });

  if (!onlineTilesAvailable && localBounds) {
    map.setMaxBounds([
      [localBounds[0], localBounds[1]],
      [localBounds[2], localBounds[3]]
    ]);
  }

  // ── ResizeObserver — keeps map filling the viewport ────────
  const mapEl = document.getElementById('map');
  const resizeObserver = new ResizeObserver(() => {
    map.resize();
  });
  resizeObserver.observe(mapEl);
  window.addEventListener('resize', () => map.resize());

  // ── Spinner tracking on detail layer ───────────────────────
  map.on('dataloading', () => {
    const sp = document.getElementById('map-loading-spinner');
    if (sp) sp.style.display = 'block';
  });

  map.on('idle', () => {
    const sp = document.getElementById('map-loading-spinner');
    if (sp) sp.style.display = 'none';
    document.getElementById('map-tile-status').innerText = onlineTilesAvailable
      ? 'TILES: ONLINE + LOCAL DB'
      : 'TILES: DOWNLOADED OFFLINE DB';
    document.getElementById('map-source-label').innerText = onlineTilesAvailable
      ? `ONLINE + DB · z${minZoom}-${maxZoom}`
      : `OFFLINE DB · z${minZoom}-${nativeMaxZoom}`;
  });

  // 6. Map event listeners
  map.on('mousemove', (e) => {
    document.getElementById('map-cursor').innerText =
      `${e.lngLat.lat.toFixed(6)}°N ${e.lngLat.lng.toFixed(6)}°E`;
  });

  map.on('zoomend', () => {
    const z = map.getZoom();
    document.getElementById('map-zoom').innerText = `Z:${z.toFixed(1)}`;
    console.log(`[Map] Zoom: ${z}`);
    updateDebugOverlay();
  });

  map.on('moveend', () => {
    updateDebugOverlay();
  });

  map.on('click', (e) => {
    if (appState.markMode) {
      addTarget(e.lngLat.lat, e.lngLat.lng, 0, 'MANUAL');
      showToast('success', `T${appState.targets.length} MARKED`, `${e.lngLat.lat.toFixed(5)}N, ${e.lngLat.lng.toFixed(5)}E`);
    }
  });

  document.getElementById('map-zoom').innerText = `Z:${map.getZoom().toFixed(1)}`;

  // 7. Show source info in status bar
  document.getElementById('map-tile-status').innerText =
    onlineTilesAvailable ? 'TILES: ONLINE + LOCAL CACHE' :
      meta.sources && meta.sources.length > 0 ? `TILES: MBTILES (${meta.sources.length})` : 'TILES: OFFLINE';

  // 8. Toggle debug overlay
  const dbgToggle = document.getElementById('btn-toggle-debug');
  const dbgOverlay = document.getElementById('map-debug-overlay');
  if (dbgToggle && dbgOverlay) {
    dbgToggle.onclick = () => {
      const hidden = dbgOverlay.style.display === 'none' || !dbgOverlay.style.display;
      dbgOverlay.style.display = hidden ? 'block' : 'none';
      dbgToggle.classList.toggle('active', hidden);
      updateDebugOverlay();
    };
  }

  // 9. Tactical Crosshair — toggle + live center coordinate readout
  const xhairEl = document.getElementById('map-crosshair');
  const xhairCoords = document.getElementById('xhair-coords');
  const xhairBtn = document.getElementById('btn-toggle-xhair');
  let xhairVisible = true;

  function updateXhairCoords() {
    if (!xhairVisible || !xhairCoords) return;
    const center = map.getCenter();
    const lat = center.lat.toFixed(6);
    const lon = center.lng.toFixed(6);
    const latDir = center.lat >= 0 ? 'N' : 'S';
    const lonDir = center.lng >= 0 ? 'E' : 'W';
    xhairCoords.innerText = `${Math.abs(lat)}°${latDir}  ${Math.abs(lon)}°${lonDir}`;
  }

  if (xhairBtn && xhairEl) {
    xhairBtn.onclick = () => {
      xhairVisible = !xhairVisible;
      xhairEl.style.display = xhairVisible ? '' : 'none';
      xhairBtn.classList.toggle('active', xhairVisible);
    };
  }

  // Update crosshair coords on every map move/zoom
  map.on('move', updateXhairCoords);
  map.on('zoom', updateXhairCoords);
  updateXhairCoords(); // Initial update

  map.on('load', () => {
    map.resize();
    setTimeout(() => map.resize(), 200);
    setTimeout(() => map.resize(), 400);
    map.addSource('target-circles', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
      id: 'target-circles-fill',
      type: 'fill',
      source: 'target-circles',
      paint: {
        'fill-color': '#C0392B',
        'fill-opacity': 0.04
      }
    });

    map.addLayer({
      id: 'target-circles-stroke',
      type: 'line',
      source: 'target-circles',
      paint: {
        'line-color': '#C0392B',
        'line-width': 1,
        'line-dasharray': [5, 4]
      }
    });

    updateTargetCirclesSource();
  });

  if (!backendUp) {
    const retryMap = setInterval(async () => {
      try {
        const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1000) });
        if (!res.ok) return;
        mapTileConfig = await fetchMapTileConfig();
        applyTileConfigToMap(mapTileConfig);
        clearInterval(retryMap);
        console.log('[Map] Tiles connected after backend came online.');
      } catch (_) {}
    }, 2000);
    setTimeout(() => clearInterval(retryMap), 120000);
  }
}

// Clock — local system time with timezone abbreviation
setInterval(() => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  // Get timezone abbreviation (e.g. IST, EST, PST)
  const tzAbbr = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
  document.getElementById('clock').innerText = `${hh}:${mm}:${ss} ${tzAbbr}`;
}, 1000);
// Immediate update so there's no 1s blank delay on load
(function () {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const tzAbbr = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
  document.getElementById('clock').innerText = `${hh}:${mm}:${ss} ${tzAbbr}`;
})();

// Connections
const navBtnConn = document.getElementById('nav-btn-conn');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');

// Datalink panel elements
const dlDot = document.getElementById('dl-dot');
const dlStateLabel = document.getElementById('dl-state-label');
const dlDroneCount = document.getElementById('dl-drone-count');
const dlLatency = document.getElementById('dl-latency');
const dlBackend = document.getElementById('dl-backend');
const dlUptime = document.getElementById('dl-uptime');

// DataLink telemetry tracking
const gcsStartTime = Date.now();
let dlConnected = false;
let dlLatencyMs = 0;

function setDlState(state) { // 'offline' | 'scanning' | 'online'
  dlDot.className = `dl-dot ${state}`;
  dlStateLabel.className = `dl-state-label ${state}`;
  dlStateLabel.innerText = state === 'online' ? 'LINKED' : state === 'scanning' ? 'SCANNING' : 'OFFLINE';
}

// Format uptime HH:MM:SS
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// Datalink panel live update loop
setInterval(() => {
  // Uptime
  dlUptime.innerText = formatUptime(Date.now() - gcsStartTime);

  // Drone count
  const count = Object.keys(appState.drones).length;
  dlDroneCount.innerText = dlConnected ? count : '—';
  dlDroneCount.className = `dl-val ${count > 0 ? 'dl-val-ok' : ''}`;

  // Latency display
  if (dlConnected) {
    dlLatency.innerText = `${dlLatencyMs} ms`;
    dlLatency.className = `dl-val ${dlLatencyMs < 80 ? 'dl-val-ok' : dlLatencyMs < 200 ? 'dl-val-warn' : 'dl-val-err'}`;
  } else {
    dlLatency.innerText = '— ms';
    dlLatency.className = 'dl-val';
  }

}, 500);

// Check tile server health every 3 seconds
setInterval(async () => {
  try {
    const t0 = Date.now();
    const h = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    await h.json();
    const latency = Date.now() - t0;
    dlBackend.innerText = `OK · ${latency}ms`;
    dlBackend.className = 'dl-val dl-val-ok';
  } catch (_) {
    if (dlConnected) {
      dlBackend.innerText = 'UNREACHABLE';
      dlBackend.className = 'dl-val dl-val-err';
    } else {
      dlBackend.innerText = 'STARTING…';
      dlBackend.className = 'dl-val dl-val-warn';
    }
  }
}, 3000);

async function performDisconnect() {
  if (window.gcsTerminal) {
    window.gcsTerminal.println('>> DISCONNECT - closing MAVLink links...', 'ui');
  }
  navBtnConn.disabled = true;
  try {
    const res = await fetch(`${BASE_URL}/disconnect`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Disconnect failed');

    if (stateInterval) clearInterval(stateInterval);
    if (missionInterval) clearInterval(missionInterval);
    stateInterval = null;
    missionInterval = null;

    Object.values(droneMarkers).forEach(marker => {
      try { marker.remove(); } catch (_) {}
    });
    Object.values(targetMarkers).forEach(item => {
      try { item.marker?.remove(); } catch (_) {}
      try { item.circle?.remove(); } catch (_) {}
    });
    droneMarkers = {};
    targetMarkers = {};
    appState.drones = {};
    appState.roles = { surveillance: null, attack: [] };
    appState.targets = [];
    appState.dispatched = [];
    droneTargetStates = {};

    navBtnConn.className = 'btn btn-connect';
    navBtnConn.innerText = 'CONNECT';
    connDot.style.background = 'var(--text-muted)';
    connDot.classList.remove('pulsing');
    connText.innerText = 'LINK OFF';
    connText.style.color = 'var(--text-secondary)';
    dlConnected = false;
    window.dlConnected = false;
    setDlState('offline');
    updateRoleUI();
    if (typeof window.attackFlowSyncFromMission === 'function') {
      window.attackFlowSyncFromMission([]);
    }
    showToast('info', 'DATALINK DISCONNECTED', 'MAVLink links closed');
  } catch (e) {
    if (window.gcsTerminal) window.gcsTerminal.error(e.message, 'DISCONNECT');
    showToast('error', 'DISCONNECT FAILED', e.message);
  } finally {
    navBtnConn.disabled = false;
  }
}

navBtnConn.addEventListener('click', async () => {
  if (window.dlConnected) {
    confirmGcsAction(
      'CONFIRM DISCONNECT',
      'Disconnect MAVLink telemetry and clear active UI assignments?',
      performDisconnect
    );
    return;
  }

  if (window.gcsTerminal) {
    window.gcsTerminal.println('>> CONNECT — starting main.py (TCP link + telemetry)...', 'ui');
  }
  navBtnConn.disabled = true;
  navBtnConn.innerText = 'SCANNING...';
  connDot.style.background = 'var(--amber)';
  connDot.classList.add('pulsing');
  connText.innerText = 'SEARCHING...';
  connText.style.color = 'var(--amber)';
  setDlState('scanning');

  try {
    const apiReady = await waitForBackendApi(20);
    if (!apiReady) {
      throw new Error('Backend API is not ready on http://127.0.0.1:5000 yet.');
    }

    const healthRes = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    const health = await healthRes.json().catch(() => ({}));
    if (health.connected && Number(health.drone_count) > 0) {
      dlLatencyMs = 0;
      navBtnConn.className = 'btn btn-nav-conn connected';
      navBtnConn.innerText = 'CONNECTED';
      navBtnConn.disabled = false;
      connDot.style.background = 'var(--green)';
      connDot.classList.remove('pulsing');
      connText.innerText = `LINK OK - ${health.drone_count} UAV`;
      connText.style.color = 'var(--text-green)';
      dlConnected = true;
      window.dlConnected = true;
      setDlState('online');
      showToast('success', 'DATALINK RESTORED', `FOUND ${health.drone_count} UNITS`);
      if (window.gcsTerminal) {
        window.gcsTerminal.println(`>> CONNECT OK - existing backend link has ${health.drone_count} UAV(s).`, 'ok');
      }
      startPolling();
      showOperatingModeModal();
      return;
    }

    const t0 = Date.now();
    const res = await fetch(`${BASE_URL}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'tcp' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Link failed');
    dlLatencyMs = Date.now() - t0;

    navBtnConn.className = 'btn btn-nav-conn connected';
    navBtnConn.innerText = 'CONNECTED';
    navBtnConn.disabled = false;

    connDot.style.background = 'var(--green)';
    connDot.classList.remove('pulsing');
    connText.innerText = `LINK OK · ${data.connected.length} UAV`;
    connText.style.color = 'var(--text-green)';

    dlConnected = true;
    window.dlConnected = true;
    setDlState('online');
    showToast('success', 'DATALINK ESTABLISHED', `FOUND ${data.connected.length} UNITS`);
    if (window.gcsTerminal) {
      window.gcsTerminal.println(`>> CONNECT OK — ${data.connected.length} UAV(s).`, 'ok');
    }
    startPolling();
    showOperatingModeModal();
  } catch (e) {
    window.dlConnected = false;
    if (window.gcsTerminal) {
      window.gcsTerminal.error(e.message || 'Link failed', 'CONNECT');
    }
    navBtnConn.disabled = false;
    navBtnConn.className = 'btn btn-nav-conn error';
    navBtnConn.innerText = 'RETRY';
    connDot.style.background = 'var(--red)';
    connDot.classList.remove('pulsing');
    connText.innerText = 'LINK FAIL';
    connText.style.color = 'var(--text-red)';
    dlConnected = false;
    window.dlConnected = false;
    setDlState('offline');
    showToast('error', 'LINK FAILURE', e.message);
  }
});


function syncTargetsFromServer(backendTargets) {
  if (!backendTargets) return;
  if (backendTargets.length === 0 && appState.targets.some(t =>
    t.assignedDroneId && ['pending', 'deploying', 'enroute', 'dispatched', 'arrived'].includes(String(t.status || '').toLowerCase())
  )) {
    return;
  }

  // 1. Remove target markers that are no longer in backendTargets
  const backendIds = new Set(backendTargets.map(t => t.id));
  Object.keys(targetMarkers).forEach(id => {
    const numericId = parseInt(id);
    if (!backendIds.has(numericId)) {
      if (targetMarkers[id].marker) targetMarkers[id].marker.remove();
      delete targetMarkers[id];
    }
  });

  // 2. Add or update remaining targets
  appState.targets = backendTargets.map(tgt => {
    const id = tgt.id;
    const lat = tgt.lat;
    const lon = tgt.lon;
    const alt = tgt.alt;
    const assignedDroneId = tgt.assigned_drone;
    const status = tgt.status;

    // Create MapLibre elements if they don't exist
    if (!targetMarkers[id]) {
      const el = document.createElement('div');
      el.className = 'tgt-icon';
      el.style.zIndex = '1';   // targets below drone markers
      el.innerHTML = `<div class="tgt-badge"><span class="tgt-badge-label">T${id}</span></div>`;
      
      const popup = new maplibregl.Popup({ offset: 15 }).setHTML(
        `<b>TARGET T${id}</b><br>LAT: ${lat.toFixed(6)}<br>LON: ${lon.toFixed(6)}<br>ALT: ${alt}m<br>STATUS: ${status.toUpperCase()}`
      );

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([lon, lat])
        .setPopup(popup)
        .addTo(map);

      targetMarkers[id] = { marker };
    } else {
      // Update popup content
      const marker = targetMarkers[id].marker;
      if (marker && marker.getPopup()) {
        marker.getPopup().setHTML(`<b>TARGET T${id}</b><br>LAT: ${lat.toFixed(6)}<br>LON: ${lon.toFixed(6)}<br>ALT: ${alt}m<br>ASSIGNED: UAV #${assignedDroneId || 'NONE'}<br>STATUS: ${status.toUpperCase()}`);
      }
    }

    // Return mapped target matching frontend structure
    return {
      id,
      lat,
      lon,
      alt,
      source: 'SERVER',
      assignedDroneId,
      status,
      time: tgt.time
    };
  });

  // Render target circles and update UI
  updateTargetCirclesSource();
  renderMissionList();
}

let stateInterval, missionInterval;
function startPolling() {
  if (stateInterval) clearInterval(stateInterval);
  if (missionInterval) clearInterval(missionInterval);

  stateInterval = setInterval(async () => {
    try {
      const t0 = Date.now();
      const resp = await fetch(`${BASE_URL}/state`);
      const text = await resp.text();
      const state = JSON.parse(text);

      dlLatencyMs = Date.now() - t0;

      const stabilizedState = droneUIStabilizer.stabilize(state);
      appState.drones = stabilizedState;
      updateDroneCards(stabilizedState);
      updateMapMarkers(stabilizedState);
      updateNavbar(stabilizedState);
      updateNavbar(stabilizedState);

      // Right attack cards are rendered by js/attack-flow.js.

      // Check for target arrivals across all active missions
      appState.targets.forEach(tgt => {
        if (tgt.status === 'enroute' && tgt.assignedDroneId) {
          const d = state[tgt.assignedDroneId];
          if (!d) return;
          if (![d.lat, d.lon, tgt.lat, tgt.lon].every(Number.isFinite)) return;
          const dist = getDistance(d.lat, d.lon, tgt.lat, tgt.lon);
          if (dist <= ATTACK_ARRIVAL_RADIUS_M && !droneTargetStates[tgt.id]) {
            droneTargetStates[tgt.id] = 'arrived';
            
            showCustomCenterModal(
              `🎯 TARGET REACHED: UAV #${tgt.assignedDroneId}`,
              `UAV #${tgt.assignedDroneId} has reached target <b>T${tgt.id}</b>.<br><br>Select action:`,
              [
                {
                  text: '💥 DROP & RTH',
                  class: 'btn modal-btn confirm',
                  onClick: () => {
                    sendCommand('drop', tgt.assignedDroneId);
                    tgt.status = 'completed';
                    droneTargetStates[tgt.id] = 'completed';
                    if (typeof window.attackFlowSyncFromMission === 'function') {
                      window.attackFlowSyncFromMission(appState.targets);
                    }
                    showToast('success', `UAV #${tgt.assignedDroneId} ATTACK`, `Payload dropped — returning home`);
                  }
                },
                {
                  text: '🏠 RTL',
                  class: 'btn modal-btn confirm-amber',
                  onClick: () => {
                    sendCommand('rtl', tgt.assignedDroneId);
                    tgt.status = 'recalled';
                    droneTargetStates[tgt.id] = 'recalled';
                    if (typeof window.attackFlowSyncFromMission === 'function') {
                      window.attackFlowSyncFromMission(appState.targets);
                    }
                    showToast('info', `UAV #${tgt.assignedDroneId} RTB`, `Returning to Launch`);
                  }
                }
              ]
            );
          }
        }
      });
    } catch (e) { console.error('State poll err', e); }
  }, 500);

  missionInterval = setInterval(async () => {
    try {
      const mission = await fetch(`${BASE_URL}/mission`).then(r => r.json());

      // Sync roles
      appState.roles.surveillance = mission.surveillance_id;
      appState.roles.attack = mission.attack_ids || [];
      updateRoleUI();

      // Sync targets from server!
      syncTargetsFromServer(mission.targets);

      if (typeof window.attackFlowSyncFromMission === 'function') {
        window.attackFlowSyncFromMission(mission.targets);
      }

      // Sync attack altitude in input if not focused (to keep it synced)
      const altInput = document.getElementById('attack-alt-input');
      if (altInput && document.activeElement !== altInput) {
        altInput.value = mission.attack_alt;
      }

    } catch (e) { console.error('Mission poll err', e); }
  }, 1000);
}

function updateNavbar(state) {
  const ids = Object.keys(state);
  if (connText.innerText.includes('LINK OK')) {
    connText.innerText = `LINK OK · ${ids.length} UAV`;
  }
  document.getElementById('fleet-count').innerText = ids.length;

  let armedCount = 0;
  ids.forEach(id => {
    if (droneIsArmed(state[id])) armedCount++;
  });

  const armEl = document.getElementById('sys-armed');
  armEl.innerText = `SYS ARMED: ${armedCount}`;
  armEl.className = armedCount > 0 ? 'sys-armed active' : 'sys-armed muted';

  // Maintain surveillance dropdown
  const survSelect = document.getElementById('role-surv-select');
  if (survSelect.options.length - 1 !== ids.length) {
    const cur = survSelect.value;
    survSelect.innerHTML = '<option value="">— SELECT SURVEILLANCE UAV —</option>';
    ids.forEach(id => {
      survSelect.innerHTML += `<option value="${id}">UAV #${id}</option>`;
    });
    if (cur && ids.includes(cur)) survSelect.value = cur;
  }

  const dispSelect = document.getElementById('dispatch-select');
  if (dispSelect && dispSelect.options.length - 1 !== appState.roles.attack.length) {
    const cur = dispSelect.value;
    dispSelect.innerHTML = '<option value="">SELECT UAV</option>';
    appState.roles.attack.forEach(id => {
      dispSelect.innerHTML += `<option value="${id}">UAV #${id} | ${state[id]?.battery || 0}%</option>`;
    });
    if (cur && appState.roles.attack.includes(parseInt(cur))) dispSelect.value = cur;
  }
}

let pendingSurveillanceId = null;

function setSurveillanceConfirmVisible(visible, nextId = null) {
  const row = document.getElementById('surv-change-confirm');
  const text = document.getElementById('surv-change-text');
  if (!row || !text) return;
  row.hidden = !visible;
  if (visible) {
    const current = appState.roles.surveillance ? `#${appState.roles.surveillance}` : 'NONE';
    const next = nextId ? `#${nextId}` : 'NONE';
    text.innerText = `CHANGE SURV ${current} -> ${next}?`;
  }
}

async function commitSurveillanceChange(survId) {
  if (survId && !requireFleetLinked('SURVEILLANCE SELECT')) return false;
  const attackIds = Object.keys(appState.drones).map(Number).filter(id => id !== survId);
  try {
    await fetch(`${BASE_URL}/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surveillance_id: survId, attack_ids: attackIds })
    });
    appState.roles.surveillance = survId;
    appState.roles.attack = attackIds;
    updateRoleUI();
    showToast('success', 'ROLES AUTO-ASSIGNED', survId ? `SURV: #${survId} - ATK: ${attackIds.length} UNITS` : 'ALL ROLES CLEARED');
    if (window.gcsTerminal && survId) {
      window.gcsTerminal.println(`>> Surveillance drone selected: #${survId} (parallel_attack_system)`, 'ui');
    }
    return true;
  } catch (err) {
    if (window.gcsTerminal) window.gcsTerminal.error('Role assignment failed', 'ROLES');
    showToast('error', 'ROLE ASSIGN FAILED');
    return false;
  }
}

document.getElementById('role-surv-select').addEventListener('change', async (e) => {
  const survId = e.target.value ? parseInt(e.target.value) : null;
  const currentId = appState.roles.surveillance ? parseInt(appState.roles.surveillance) : null;
  if (currentId && survId !== currentId) {
    pendingSurveillanceId = survId;
    setSurveillanceConfirmVisible(true, survId);
    return;
  }
  pendingSurveillanceId = null;
  setSurveillanceConfirmVisible(false);
  if (survId && !requireFleetLinked('SURVEILLANCE SELECT')) {
    e.target.value = '';
    return;
  }
  if (window.gcsTerminal && survId) {
    window.gcsTerminal.println(`>> Surveillance drone selected: #${survId} (parallel_attack_system)`, 'ui');
  }
  const attackIds = Object.keys(appState.drones).map(Number).filter(id => id !== survId);

  try {
    await fetch(`${BASE_URL}/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surveillance_id: survId, attack_ids: attackIds })
    });
    appState.roles.surveillance = survId;
    appState.roles.attack = attackIds;
    updateRoleUI();
    showToast('success', 'ROLES AUTO-ASSIGNED', survId ? `SURV: #${survId} · ATK: ${attackIds.length} UNITS` : 'ALL ROLES CLEARED');
  } catch (err) {
    if (window.gcsTerminal) window.gcsTerminal.error('Role assignment failed', 'ROLES');
    showToast('error', 'ROLE ASSIGN FAILED');
  }
});

document.getElementById('btn-confirm-surv-change')?.addEventListener('click', async () => {
  const success = await commitSurveillanceChange(pendingSurveillanceId);
  if (success) {
    pendingSurveillanceId = null;
    setSurveillanceConfirmVisible(false);
  }
});

document.getElementById('btn-cancel-surv-change')?.addEventListener('click', () => {
  const select = document.getElementById('role-surv-select');
  pendingSurveillanceId = null;
  setSurveillanceConfirmVisible(false);
  if (select) select.value = appState.roles.surveillance || '';
});

function updateRoleUI() {
  const chips = document.getElementById('role-atk-chips');
  if (chips) {
    if (appState.roles.attack.length > 0 && appState.roles.surveillance) {
      chips.innerHTML = appState.roles.attack.map(id => `<div class="chip">#${id}</div>`).join('');
    } else {
      chips.innerHTML = `<div class="empty-chip-msg">SELECT SURVEILLANCE TO AUTO-ASSIGN</div>`;
    }
  }

  const msSurv = document.getElementById('ms-surv');
  if (msSurv) {
    msSurv.innerText = appState.roles.surveillance ? `#${appState.roles.surveillance}` : '—';
  }
  const msAtk = document.getElementById('ms-atk');
  if (msAtk) {
    msAtk.innerText = appState.roles.attack.length;
  }
}

let criticalNotified = {}; // track to avoid infinite beeps

function getModeString(modeInt) {
  const map = { 0: 'STABILIZE', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 9: 'LAND', 13: 'SPORT', 16: 'POSHOLD' };
  return map[modeInt] || `MODE_${modeInt}`;
}

function droneBaseMode(d) {
  return Number(d?.base_mode ?? d?.armed ?? 0);
}

function droneIsArmed(d) {
  return (droneBaseMode(d) & 128) !== 0;
}

function updateDroneCards(state) {
  const container = document.getElementById('fleet-list');
  const now = Date.now() / 1000;

  Object.keys(state).forEach(id => {
    const d = state[id];
    let card = container.querySelector(`.drone-card[data-id="${id}"]`);

    const isStale = (now - d.last_update) > 3;
    const isArmed = droneIsArmed(d);
    const isSurv = appState.roles.surveillance == id;
    const isAtk = appState.roles.attack.includes(parseInt(id));

    if (isStale && !criticalNotified[id + '_stale']) {
      criticalNotified[id + '_stale'] = true;
      console.warn(`UAV #${id} telemetry stale`);
    } else if (!isStale) {
      criticalNotified[id + '_stale'] = false;
    }

    if (d.battery <= 20 && !criticalNotified[id + '_batt']) {
      criticalNotified[id + '_batt'] = true;
      alertBeep();
      showToast('critical', `UAV #${id} LOW BATTERY`);
    } else if (d.battery > 20) {
      criticalNotified[id + '_batt'] = false;
    }

    if (!altHistory[id]) altHistory[id] = [];
    altHistory[id].push(d.alt || 0);
    if (altHistory[id].length > 60) altHistory[id].shift();

    if (!card) {
      card = document.createElement('div');
      card.className = 'drone-card';
      card.dataset.id = id;
      card.innerHTML = `
        <div class="card-header-row">
          <div style="display:flex;align-items:center;">
            <div class="role-badge badge-type">UAV</div>
            <div class="drone-id">#${id}</div>
          </div>
          <div class="status-badge badge-status">SAFE</div>
        </div>
        <div class="batt-row">
          <div class="lbl">BATT</div>
          <div class="batt-bar-bg"><div class="batt-fill bar-fill"></div></div>
          <div class="batt-pct pct-val">0%</div>
        </div>
        <div class="mode-row">
          <div class="lbl">MODE</div>
          <div class="mode-val mode-text">UNKNOWN</div>
        </div>
        <button class="telem-toggle">▸ TELEMETRY</button>
        <div class="telem-exp">
          <div class="telem-grid">
            <div class="t-cell"><span class="t-lbl">LAT</span><span class="t-val lat">0</span></div>
            <div class="t-cell"><span class="t-lbl">LON</span><span class="t-val lon">0</span></div>
            <div class="t-cell"><span class="t-lbl">ALT</span><span class="t-val alt">0</span></div>
            <div class="t-cell"><span class="t-lbl">YAW</span><span class="t-val yaw">0</span></div>
            <div class="t-cell"><span class="t-lbl">ROLL</span><span class="t-val roll">0</span></div>
            <div class="t-cell"><span class="t-lbl">PTCH</span><span class="t-val ptch">0</span></div>
            <div class="t-cell"><span class="t-lbl">BATT</span><span class="t-val batt">0</span></div>
            <div class="t-cell"><span class="t-lbl">UPD</span><span class="t-val upd">0s</span></div>
          </div>
          <div class="alt-spark-container">
            <canvas class="alt-sparkline" width="200" height="28"></canvas>
            <div class="last-upd upd-text">0s ago</div>
          </div>
        </div>
      `;
      container.appendChild(card);

      const tog = card.querySelector('.telem-toggle');
      const exp = card.querySelector('.telem-exp');
      tog.onclick = () => {
        const isOpen = exp.classList.toggle('open');
        tog.innerText = isOpen ? '▾ TELEMETRY' : '▸ TELEMETRY';
      };
    }

    // Update card styling
    card.className = 'drone-card ' + (isStale ? 'lost' : (isSurv ? 'role-surv' : (isAtk ? 'role-atk' : '')));

    const bType = card.querySelector('.badge-type');
    if (isSurv) { bType.className = 'role-badge badge-type surv'; bType.innerText = 'SURV'; }
    else if (isAtk) { bType.className = 'role-badge badge-type atk'; bType.innerText = 'ATK'; }
    else { bType.className = 'role-badge badge-type uav'; bType.innerText = 'UAV'; }

    const bStat = card.querySelector('.badge-status');
    if (isStale) { bStat.className = 'status-badge badge-status lost'; bStat.innerText = 'LOST'; }
    else if (isArmed) { bStat.className = 'status-badge badge-status armed'; bStat.innerText = 'ARMED'; }
    else { bStat.className = 'status-badge badge-status safe'; bStat.innerText = 'SAFE'; }

    let bc = d.battery > 50 ? 'var(--green)' : (d.battery > 20 ? 'var(--yellow)' : 'var(--red)');
    card.querySelector('.bar-fill').style.width = d.battery + '%';
    card.querySelector('.bar-fill').style.background = bc;
    card.querySelector('.pct-val').innerText = d.battery + '%';
    card.querySelector('.pct-val').style.color = bc;

    card.querySelector('.mode-text').innerText = getModeString(d.mode);

    // Per-card buttons removed — attack drones are auto-managed

    // Telemetry update
    if (card.querySelector('.telem-exp').classList.contains('open')) {
      card.querySelector('.lat').innerText = d.lat.toFixed(5);
      card.querySelector('.lon').innerText = d.lon.toFixed(5);
      card.querySelector('.alt').innerText = d.alt.toFixed(1) + 'm';
      card.querySelector('.yaw').innerText = (d.yaw * 180 / Math.PI).toFixed(0) + '°';
      card.querySelector('.roll').innerText = (d.roll * 180 / Math.PI).toFixed(0) + '°';
      card.querySelector('.ptch').innerText = (d.pitch * 180 / Math.PI).toFixed(0) + '°';
      card.querySelector('.batt').innerText = d.battery + '%';
      card.querySelector('.batt').style.color = bc;
      const sec = Math.max(0, Math.floor(now - d.last_update));
      card.querySelector('.upd').innerText = sec + 's';
      card.querySelector('.upd').style.color = sec > 3 ? 'var(--red-bright)' : 'var(--text-primary)';
      card.querySelector('.upd-text').innerText = `LAST UPDATE: ${sec}s ago`;

      drawSparkline(card.querySelector('.alt-sparkline'), altHistory[id]);
    }
  });
}

function drawSparkline(canvas, data) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!data || data.length === 0) return;

  const max = Math.max(...data, 10);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = canvas.width / 60;

  ctx.beginPath();
  ctx.strokeStyle = '#E8820C';
  ctx.lineWidth = 1;

  data.forEach((val, i) => {
    const x = canvas.width - ((data.length - 1 - i) * step);
    const y = canvas.height - ((val - min) / range * canvas.height);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // End dot
  const lastVal = data[data.length - 1];
  const endY = canvas.height - ((lastVal - min) / range * canvas.height);
  ctx.beginPath();
  ctx.arc(canvas.width, endY, 2, 0, 2 * Math.PI);
  ctx.fillStyle = '#E8820C';
  ctx.fill();
}

/** Per-drone MAVLink actions → POST /command (arm, disarm, takeoff, land, rtl, drop, goto). */
async function sendCommand(action, drone_id, extra = {}) {
  try {
    const res = await fetch(`${BASE_URL}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, drone_id, ...extra })
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error);
    }
  } catch (e) {
    if (window.gcsTerminal) window.gcsTerminal.error(e.message, `CMD ${action}`);
    showToast('error', 'CMD FAILED', e.message);
  }
}

function updateMapMarkers(state) {
  let toCenter = false;
  Object.keys(state).forEach(id => {
    const d = state[id];
    if (!d.lat || !d.lon) return;

    let isSurv = appState.roles.surveillance == id;
    let url = isSurv ? 'assets/icons/drone-surv.svg' : 'assets/icons/drone-atk.svg';
    let size = isSurv ? [32, 32] : [28, 28];
    let bRole = isSurv ? 'SURV' : 'ATK';
    let yDeg = d.yaw * 180 / Math.PI;
    const isArmed = droneIsArmed(d);

    let popupHTML = `
      <div style="font-weight:600;margin-bottom:6px;">[${bRole}] UAV #${id}</div>
      <div style="height:1px;background:#333;margin-bottom:6px;"></div>
      <table style="width:100%;font-size:11px;">
        <tr><td style="color:var(--text-muted)">MODE</td><td>${getModeString(d.mode)}</td></tr>
        <tr><td style="color:var(--text-muted)">STATUS</td><td style="color:${isArmed ? 'var(--red-bright)' : 'var(--text-primary)'}">${isArmed ? 'ARMED' : 'SAFE'}</td></tr>
        <tr><td style="color:var(--text-muted)">BATT</td><td>${d.battery}%</td></tr>
        <tr><td style="color:var(--text-muted)">ALT</td><td>${d.alt.toFixed(1)}m</td></tr>
      </table>
    `;

    if (!droneMarkers[id]) {
      const el = document.createElement('div');
      el.className = 'custom-drone-icon';
      el.style.width = size[0] + 'px';
      el.style.height = size[1] + 'px';
      el.style.position = 'relative';
      el.style.overflow = 'visible';
      el.style.zIndex = '10';  // drones always above target markers
      el.innerHTML = `
        <img src="${url}" id="dimg-${id}" style="width:100%;height:100%;display:block;transform:rotate(${yDeg}deg);">
        <span class="drone-label" id="dlabel-${id}" style="color:${isSurv ? 'var(--drone-surv)' : 'var(--drone-atk)'}; position: absolute; left: ${size[0] + 4}px; top: 50%; transform: translateY(-50%); white-space: nowrap; font-size: 11px; font-weight: bold; font-family: monospace; text-shadow: 1px 1px 0px #000, -1px -1px 0px #000, 1px -1px 0px #000, -1px 1px 0px #000; pointer-events: none;">#${id}</span>
      `;

      const popup = new maplibregl.Popup({ offset: 20 }).setHTML(popupHTML);

      const m = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([d.lon, d.lat])
        .setPopup(popup)
        .addTo(map);

      droneMarkers[id] = m;
      toCenter = true;
    } else {
      const m = droneMarkers[id];
      m.setLngLat([d.lon, d.lat]);
      const img = document.getElementById(`dimg-${id}`);
      if (img) {
        if (img.src.indexOf(url) === -1) img.src = url;
        img.style.transform = `rotate(${yDeg}deg)`;
      }
      const label = document.getElementById(`dlabel-${id}`);
      if (label) {
        label.style.color = isSurv ? 'var(--drone-surv)' : 'var(--drone-atk)';
      }
      if (m.getPopup() && m.getPopup().isOpen()) {
        m.getPopup().setHTML(popupHTML);
      }
    }
  });

  if (toCenter && Object.keys(droneMarkers).length === 1) {
    document.getElementById('btn-ctr-all').click();
  }

  if (autoFollow) {
    fitAll();
  }
}

// Map Controls
document.getElementById('btn-ctr-all').onclick = () => {
  fitAll();
};

document.getElementById('btn-follow-mode').onclick = () => {
  autoFollow = !autoFollow;
  const btn = document.getElementById('btn-follow-mode');
  if (autoFollow) {
    btn.innerText = '⌖ FOLLOW: ON';
    btn.classList.add('active');
    fitAll();
  } else {
    btn.innerText = '⌖ FOLLOW: OFF';
    btn.classList.remove('active');
  }
};

document.getElementById('btn-recenter').onclick = () => {
  fitAll();
};

// Tactical Zoom Controls
document.getElementById('btn-zoom-in').onclick = () => map.zoomIn();
document.getElementById('btn-zoom-out').onclick = () => map.zoomOut();

const mapCont = document.getElementById('map') || document.getElementById('map-container');
appState.markMode = false;

// ─── MULTI-TARGET SYSTEM ──────────────────────────────────────────

// Add a new target to the map (local, no backend call needed for marking)
function addTarget(lat, lon, alt, source) {
  _targetIdSeq++;
  const id = _targetIdSeq;
  const tgt = { id, lat, lon, alt: alt || 0, source, assignedDroneId: null, status: 'pending', time: Date.now() / 1000 };
  appState.targets.push(tgt);

  // Create numbered map marker
  const el = document.createElement('div');
  el.className = 'tgt-icon';
  el.style.zIndex = '1';   // targets below drone markers
  el.innerHTML = `<div class="tgt-badge"><span class="tgt-badge-label">T${id}</span></div>`;
  
  const popup = new maplibregl.Popup({ offset: 15 }).setHTML(
    `<b>TARGET T${id}</b><br>LAT: ${lat.toFixed(6)}<br>LON: ${lon.toFixed(6)}<br>ALT: ${alt}m<br><small>Click map to add more targets</small>`
  );

  const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([lon, lat])
    .setPopup(popup)
    .addTo(map);

  targetMarkers[id] = { marker };
  updateTargetCirclesSource();
  renderMissionList();
}

// Remove a single target from map and array
function removeTarget(id) {
  if (targetMarkers[id]) {
    if (targetMarkers[id].marker) targetMarkers[id].marker.remove();
    delete targetMarkers[id];
  }
  appState.targets = appState.targets.filter(t => t.id !== id);
  updateTargetCirclesSource();
  renderMissionList();
}

// Clear ALL targets
function clearAllTargets() {
  Object.keys(targetMarkers).forEach(id => {
    if (targetMarkers[id].marker) targetMarkers[id].marker.remove();
  });
  targetMarkers = {};
  appState.targets = [];
  updateTargetCirclesSource();
  renderMissionList();
  showToast('info', 'ALL MISSIONS CLEARED');
}

// Dispatch a specific drone to a specific target
async function dispatchToTarget(targetId) {
  if (!requireFleetLinked(`DISPATCH T${targetId}`)) return;
  const tgt = appState.targets.find(t => t.id === targetId);
  if (!tgt) return;
  if (!tgt.assignedDroneId) {
    if (window.gcsTerminal) window.gcsTerminal.warn(`Assign a drone to T${targetId} first.`);
    showToast('warn', 'NO DRONE ASSIGNED', `Assign a drone to T${targetId} first.`);
    return;
  }
  try {
    // Send target to backend first, then dispatch
    const res = await fetch(`${BASE_URL}/target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: tgt.lat,
        lon: tgt.lon,
        alt: tgt.alt,
        drone_id: parseInt(tgt.assignedDroneId, 10)
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Target dispatch failed');
    }
    tgt.status = 'dispatched';
    showToast('warn', `UAV #${tgt.assignedDroneId} DISPATCHED`, `ENGAGING T${targetId}`);
    renderMissionList();
  } catch (e) {
    if (window.gcsTerminal) window.gcsTerminal.error(e.message, `DISPATCH T${targetId}`);
    showToast('error', 'DISPATCH ERROR', e.message);
  }
}

// Render the full mission list into the Mission tab
function renderMissionList() {
  const list = document.getElementById('ms-target-list');
  const clearAllBtn = document.getElementById('btn-clear-all-missions');
  const countBadge = document.getElementById('ms-tgt-count');
  if (!list) return;

  if (countBadge) countBadge.innerText = appState.targets.length;

  if (appState.targets.length === 0) {
    list.innerHTML = `<div class="ms-empty-msg">No targets marked.<br><span>Use MARK mode on the map to add targets.</span></div>`;
    if (clearAllBtn) clearAllBtn.style.display = 'none';
    return;
  }

  if (clearAllBtn) clearAllBtn.style.display = 'block';

  const attackIds = appState.roles.attack;
  list.innerHTML = appState.targets.map(tgt => {
    const statusClass = tgt.status === 'dispatched' ? 'ms-tgt-dispatched' : tgt.status === 'recalled' ? 'ms-tgt-recalled' : 'ms-tgt-pending';
    const statusLabel = tgt.status === 'dispatched' ? '▶ ENGAGED' : tgt.status === 'recalled' ? '↩ RECALLED' : '● PENDING';
    const droneOptions = attackIds.map(id =>
      `<option value="${id}" ${tgt.assignedDroneId == id ? 'selected' : ''}>#${id}</option>`
    ).join('');
    const canDispatch = tgt.assignedDroneId !== null && noDronesAvailable() === false;
    return `
      <div class="ms-tgt-card" id="ms-tgt-${tgt.id}">
        <div class="ms-tgt-header">
          <span class="ms-tgt-id">T${tgt.id}</span>
          <span class="ms-tgt-coords">${tgt.lat.toFixed(4)}N, ${tgt.lon.toFixed(4)}E</span>
          <span class="ms-tgt-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="ms-tgt-controls">
          <select class="qgc-select ms-drone-sel" onchange="assignDroneToTarget(${tgt.id}, this.value)">
            <option value="">ASSIGN UAV</option>
            ${droneOptions}
          </select>
          <button class="btn ms-tgt-dispatch" onclick="dispatchToTarget(${tgt.id})" ${tgt.status === 'dispatched' ? 'disabled' : ''}>GO</button>
          <button class="btn ms-tgt-remove" onclick="confirmRemoveTarget(${tgt.id})">✕</button>
        </div>
      </div>
    `;
  }).join('');
}

// Assign a drone to a target
window.assignDroneToTarget = function (targetId, droneId) {
  const tgt = appState.targets.find(t => t.id === targetId);
  if (tgt) { tgt.assignedDroneId = droneId || null; renderMissionList(); }
};

// Confirm remove with inline toggle (no big modal)
window.confirmRemoveTarget = function (id) {
  const btn = document.querySelector(`#ms-tgt-${id} .ms-tgt-remove`);
  if (!btn) return;
  if (btn.dataset.pending === 'true') {
    removeTarget(id);
  } else {
    btn.dataset.pending = 'true';
    btn.innerText = '?';
    btn.style.color = 'var(--red-bright)';
    setTimeout(() => { if (btn.dataset.pending === 'true') { btn.dataset.pending = 'false'; btn.innerText = '✕'; btn.style.color = ''; } }, 2500);
  }
};

window.clearAllMissionsConfirm = function () {
  const btn = document.getElementById('btn-clear-all-missions');
  if (!btn) return;
  if (btn.dataset.pending === 'true') {
    clearAllTargets();
    btn.dataset.pending = 'false';
    btn.innerText = '✕ CLEAR ALL MISSIONS';
    btn.style.color = '';
  } else {
    btn.dataset.pending = 'true';
    btn.innerText = 'SURE? CLICK AGAIN TO ABORT ALL';
    btn.style.color = 'var(--red-bright)';
    setTimeout(() => {
      if (btn.dataset.pending === 'true') {
        btn.dataset.pending = 'false';
        btn.innerText = '✕ CLEAR ALL MISSIONS';
        btn.style.color = '';
      }
    }, 3000);
  }
};

// Legacy compat — keep updateTargetUI as a no-op (mission poll still calls it)
function updateTargetUI() { renderMissionList(); }

// Legacy global dispatches removed in favor of per-target dispatch

window.recallDrone = (btn, id) => {
  if (btn.dataset.pending === 'true') {
    btn.dataset.pending = 'false';
    btn.innerText = 'RECALL';
    btn.classList.remove('confirm-mode');
    sendCommand('recall', parseInt(id)).then(() => {
      showToast('info', 'UNIT RECALLED', `UAV #${id} RTB`);
    });
  } else {
    btn.dataset.pending = 'true';
    btn.innerText = 'CONFIRM?';
    btn.classList.add('confirm-mode');
    setTimeout(() => {
      if (btn.dataset.pending === 'true') {
        btn.dataset.pending = 'false';
        btn.innerText = 'RECALL';
        btn.classList.remove('confirm-mode');
      }
    }, 3000);
  }
};

// Old single-target clear logic removed

const noDronesAvailable = () => Object.keys(appState.drones).length === 0;

// Panel collapse toggle logic
const leftPanel = document.getElementById('left-panel-wrap');
const rightPanel = document.getElementById('right-panel-wrap');
const mapLegend = document.getElementById('map-legend');
const mapDebugOverlay = document.getElementById('map-debug-overlay');
const zoomControls = document.querySelector('.zoom-controls');
const btnUnhideLeft = document.getElementById('btn-unhide-left');
const btnUnhideRight = document.getElementById('btn-unhide-right');

document.getElementById('btn-collapse-left')?.addEventListener('click', () => {
  leftPanel.classList.add('collapsed');
  mapLegend.classList.add('panel-collapsed');
  btnUnhideLeft.style.display = 'flex';
});
btnUnhideLeft?.addEventListener('click', () => {
  leftPanel.classList.remove('collapsed');
  mapLegend.classList.remove('panel-collapsed');
  btnUnhideLeft.style.display = 'none';
});

document.getElementById('btn-collapse-right')?.addEventListener('click', () => {
  rightPanel.classList.add('collapsed');
  mapDebugOverlay.classList.add('panel-collapsed');
  zoomControls.classList.add('panel-collapsed');
  btnUnhideRight.style.display = 'flex';
});
btnUnhideRight?.addEventListener('click', () => {
  rightPanel.classList.remove('collapsed');
  mapDebugOverlay.classList.remove('panel-collapsed');
  zoomControls.classList.remove('panel-collapsed');
  btnUnhideRight.style.display = 'none';
});


// Attack Altitude configuration setter
document.getElementById('btn-set-alt')?.addEventListener('click', () => {
  const altInput = document.getElementById('attack-alt-input');
  if (!altInput) return;
  const alt = parseFloat(altInput.value) || 10;

  confirmGcsAction(
    'CONFIRM ACTION',
    `Set attack altitude to <b>${alt} m</b> for all future deployments?`,
    async () => {
      try {
        if (!(await requireApiReadyForAction('ATTACK ALT'))) return;
        const res = await fetch(`${BASE_URL}/attack_alt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ altitude: alt })
        });
        if (res.ok) {
          if (window.gcsTerminal) window.gcsTerminal.println(`>> Attack altitude set to ${alt}m`, 'ok');
          showToast('success', 'ATTACK ALTITUDE SET', `Target altitude: ${alt}m`);
        } else {
          let detail = 'Backend rejected the altitude update.';
          try {
            const data = await res.json();
            detail = data.error || data.message || detail;
          } catch (_) {}
          if (window.gcsTerminal) window.gcsTerminal.error(detail, 'ATTACK ALT');
          showToast('error', 'FAILED TO SET ALTITUDE', detail);
        }
      } catch (e) {
        const detail = e && e.message === 'Failed to fetch'
          ? 'Backend API is unreachable. Start the Python backend or wait for it to finish starting.'
          : e.message;
        if (window.gcsTerminal) window.gcsTerminal.error(detail, 'ATTACK ALT');
        showToast('error', 'API ERROR', detail);
      }
    }
  );
});

initMap();

const MAP_PACK_PRESETS = {
  world: {
    name: 'world_z0_z8',
    bbox: [-180, -85, 180, 85],
    zoom: [0, 8]
  },
  indiaNearby: {
    name: 'india_nearby_z0_z19',
    bbox: [55, -5, 105, 42],
    zoom: [0, 19]
  }
};

function tileXY(lat, lon, zoom) {
  const latRad = lat * Math.PI / 180;
  const n = Math.pow(2, zoom);
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return [
    Math.max(0, Math.min(n - 1, x)),
    Math.max(0, Math.min(n - 1, y))
  ];
}

function estimateTileCount(minLon, minLat, maxLon, maxLat, minZoom, maxZoom) {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const [xMinA, yMaxA] = tileXY(minLat, minLon, z);
    const [xMaxA, yMinA] = tileXY(maxLat, maxLon, z);
    total += (Math.abs(xMaxA - xMinA) + 1) * (Math.abs(yMaxA - yMinA) + 1);
  }
  return total;
}

function formatLargeNumber(value) {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatStorage(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function setDownloadFields({ name, bbox, zoom }) {
  document.getElementById('dl-pack-name').value = name;
  document.getElementById('dl-min-lon').value = bbox[0];
  document.getElementById('dl-min-lat').value = bbox[1];
  document.getElementById('dl-max-lon').value = bbox[2];
  document.getElementById('dl-max-lat').value = bbox[3];
  document.getElementById('dl-min-zoom').value = zoom[0];
  document.getElementById('dl-max-zoom').value = zoom[1];
  updateDownloadEstimate();
}

function readDownloadFields() {
  const minLon = parseFloat(document.getElementById('dl-min-lon').value);
  const minLat = parseFloat(document.getElementById('dl-min-lat').value);
  const maxLon = parseFloat(document.getElementById('dl-max-lon').value);
  const maxLat = parseFloat(document.getElementById('dl-max-lat').value);
  const minZoom = parseInt(document.getElementById('dl-min-zoom').value, 10);
  const maxZoom = parseInt(document.getElementById('dl-max-zoom').value, 10);
  const name = document.getElementById('dl-pack-name').value.trim() || 'custom_map_pack';
  return { minLon, minLat, maxLon, maxLat, minZoom, maxZoom, name };
}

function updateDownloadEstimate() {
  const estimate = document.getElementById('dl-estimate');
  if (!estimate) return;
  const { minLon, minLat, maxLon, maxLat, minZoom, maxZoom } = readDownloadFields();
  if (![minLon, minLat, maxLon, maxLat, minZoom, maxZoom].every(Number.isFinite) || minZoom > maxZoom) {
    estimate.className = 'map-estimate-box danger';
    estimate.innerHTML = '<strong>Invalid bounds or zoom range.</strong>';
    return;
  }

  const tiles = estimateTileCount(minLon, minLat, maxLon, maxLat, minZoom, maxZoom);
  const lowStorage = formatStorage(tiles * 12 * 1024);
  const highStorage = formatStorage(tiles * 60 * 1024);
  let risk = 'READY';
  let cls = 'map-estimate-box';
  if (tiles > 1000000) {
    risk = 'LARGE PACK';
    cls += ' warn';
  }
  if (tiles > 100000000) {
    risk = 'EXTREME PACK - use smaller AOI';
    cls += ' danger';
  }
  estimate.className = cls;
  estimate.innerHTML = `
    <div><strong>${formatLargeNumber(tiles)}</strong> tiles estimated</div>
    <div>Storage estimate: <strong>${lowStorage} - ${highStorage}</strong></div>
    <div class="estimate-risk">Status: ${risk}</div>
  `;
}

async function configureMapDownloaderPath() {
  const note = document.getElementById('dl-storage-note');
  if (!note) return;
  try {
    const res = await fetch(`${BASE_URL}/tiles/packs`);
    if (res.ok) {
      const data = await res.json();
      note.innerHTML = `Files are saved to:<br><code>${data.storage_dir}</code><br>as <code>pack_name.mbtiles</code>. Existing tiles in the same pack are skipped.`;
    }
  } catch (_) {
    note.textContent = 'Tile server not reachable — start the app backend first.';
  }
}
window.configureMapDownloaderPath = configureMapDownloaderPath;

function configureMapManagerUI() {
  const modal = document.querySelector('#offline-map-modal .modal-box');
  const body = document.querySelector('#offline-map-modal .modal-body');
  if (!modal || !body || body.dataset.enhanced === 'true') return;

  modal.classList.add('map-manager-modal');
  body.dataset.enhanced = 'true';
  body.innerHTML = `
    <div class="map-policy-grid">
      <div class="map-policy-card"><span class="policy-k">SOURCE</span><span class="policy-v">Google satellite tiles (256px) stored as MBTiles on disk</span></div>
      <div class="map-policy-card"><span class="policy-k">ONLINE</span><span class="policy-v">When internet works, map can reach z22 and caches browsed tiles</span></div>
      <div class="map-policy-card"><span class="policy-k">OFFLINE</span><span class="policy-v">Uses downloaded .mbtiles packs from electron/tiles/</span></div>
      <div class="map-policy-card"><span class="policy-k">FALLBACK</span><span class="policy-v">Missing high-zoom tiles overzoom from the best local level</span></div>
    </div>
    <div class="section-label" style="margin:16px 0 10px;">REGION PRESETS</div>
    <div class="map-preset-row">
      <button type="button" id="preset-world" class="btn map-preset-btn">WORLD z0-z8</button>
      <button type="button" id="preset-india-nearby" class="btn map-preset-btn">INDIA NEARBY z0-z19</button>
      <button type="button" id="preset-mission-aoi" class="btn map-preset-btn">CURRENT VIEW z20-z22</button>
    </div>
    <div class="section-label" style="margin:16px 0 10px;">BOUNDING BOX (lon/lat)</div>
    <button type="button" id="btn-dl-use-view" class="btn" style="width:100%; margin-bottom:12px; background:rgba(255,255,255,0.04); border:1px dashed rgba(255,255,255,0.2); color:var(--text-primary); font-size:11px;">SET TO CURRENT MAP VIEW</button>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px;">
      <div><span class="dl-field-label">MIN LON (west)</span><input type="text" id="dl-min-lon" class="dl-inp" value="55"></div>
      <div><span class="dl-field-label">MIN LAT (south)</span><input type="text" id="dl-min-lat" class="dl-inp" value="-5"></div>
      <div><span class="dl-field-label">MAX LON (east)</span><input type="text" id="dl-max-lon" class="dl-inp" value="105"></div>
      <div><span class="dl-field-label">MAX LAT (north)</span><input type="text" id="dl-max-lat" class="dl-inp" value="42"></div>
    </div>
    <div class="section-label" style="margin-bottom:10px;">ZOOM RANGE</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
      <div><span class="dl-field-label">MIN ZOOM</span><input type="number" id="dl-min-zoom" class="dl-inp" value="0" min="0" max="22"></div>
      <div><span class="dl-field-label">MAX ZOOM</span><input type="number" id="dl-max-zoom" class="dl-inp" value="19" min="0" max="22"></div>
    </div>
    <div style="margin-top:14px;">
      <span class="dl-field-label">PACK NAME (filename without .mbtiles)</span>
      <input type="text" id="dl-pack-name" class="dl-inp" value="india_nearby_z0_z19">
    </div>
    <div id="dl-estimate" class="map-estimate-box">Estimate updates after changing bounds or zoom.</div>
    <div id="dl-storage-note" class="dl-storage-note">Loading storage path…</div>
    <div id="dl-info" style="margin-top:8px; font-size:10px; color:var(--text-secondary);">Download runs in the background. Check progress in Settings → Installed map packs.</div>
  `;
  configureMapDownloaderPath();

  document.getElementById('preset-world').onclick = () => setDownloadFields(MAP_PACK_PRESETS.world);
  document.getElementById('preset-india-nearby').onclick = () => setDownloadFields(MAP_PACK_PRESETS.indiaNearby);
  document.getElementById('preset-mission-aoi').onclick = () => {
    const bounds = map.getBounds();
    setDownloadFields({
      name: 'mission_aoi_z20_z22',
      bbox: [
        bounds.getWest().toFixed(5),
        bounds.getSouth().toFixed(5),
        bounds.getEast().toFixed(5),
        bounds.getNorth().toFixed(5)
      ],
      zoom: [20, 22]
    });
  };

  ['dl-min-lon', 'dl-min-lat', 'dl-max-lon', 'dl-max-lat', 'dl-min-zoom', 'dl-max-zoom']
    .forEach(id => document.getElementById(id).addEventListener('input', updateDownloadEstimate));
  updateDownloadEstimate();
}

function enhanceSettingsMapSection() {
  const button = document.getElementById('btn-open-offline-downloader');
  if (!button || document.getElementById('settings-map-policy')) return;
  const section = button.closest('div');
  if (!section || !section.parentElement) return;
  const policy = document.createElement('div');
  policy.id = 'settings-map-policy';
  policy.className = 'settings-map-card';
  policy.innerHTML = `
    <div class="settings-map-row"><span>Automatic online mode</span><b>World map up to z22 when internet is reachable</b></div>
    <div class="settings-map-row"><span>Offline world base</span><b>z0-z8</b></div>
    <div class="settings-map-row"><span>India nearby offline</span><b>z0-z19</b></div>
    <div class="settings-map-row"><span>Mission AOI offline</span><b>z20-z22 for selected local areas</b></div>
    <div class="settings-map-row"><span>Missing high zoom</span><b>Overzoom best available local tile</b></div>
  `;
  section.parentElement.insertBefore(policy, section);
  section.style.marginTop = '12px';
}

configureMapManagerUI();

document.getElementById('btn-close-dl').onclick = () => {
  document.getElementById('offline-map-modal').style.display = 'none';
};

document.getElementById('btn-dl-use-view').onclick = () => {
  const bounds = map.getBounds();
  document.getElementById('dl-min-lon').value = bounds.getWest().toFixed(5);
  document.getElementById('dl-min-lat').value = bounds.getSouth().toFixed(5);
  document.getElementById('dl-max-lon').value = bounds.getEast().toFixed(5);
  document.getElementById('dl-max-lat').value = bounds.getNorth().toFixed(5);

  const currentZoom = map.getZoom();
  document.getElementById('dl-min-zoom').value = Math.max(3, currentZoom);
  document.getElementById('dl-max-zoom').value = Math.min(22, currentZoom + 3);
  document.getElementById('dl-pack-name').value = 'custom_view_pack';
  updateDownloadEstimate();

  showToast('info', 'BOUNDS UPDATED', 'Set to current camera view.');
};

document.getElementById('btn-start-dl').onclick = async () => {
  const btn = document.getElementById('btn-start-dl');
  const fields = readDownloadFields();
  const tileCount = estimateTileCount(fields.minLon, fields.minLat, fields.maxLon, fields.maxLat, fields.minZoom, fields.maxZoom);
  if (tileCount > 100000000) {
    showToast('error', 'PACK TOO LARGE', 'Use CURRENT VIEW AOI for z20-z22 downloads.');
    updateDownloadEstimate();
    return;
  }
  if (tileCount > 1000000 && btn.dataset.confirmLarge !== 'true') {
    btn.dataset.confirmLarge = 'true';
    btn.innerText = 'CONFIRM LARGE PACK';
    showToast('warn', 'LARGE DOWNLOAD', `${formatLargeNumber(tileCount)} tiles estimated. Click again to start.`);
    setTimeout(() => {
      if (btn.dataset.confirmLarge === 'true') {
        btn.dataset.confirmLarge = 'false';
        btn.innerText = 'START DOWNLOAD';
      }
    }, 5000);
    return;
  }
  btn.dataset.confirmLarge = 'false';
  btn.innerText = 'DOWNLOADING...';
  btn.disabled = true;

  const bbox = `${document.getElementById('dl-min-lon').value},${document.getElementById('dl-min-lat').value},${document.getElementById('dl-max-lon').value},${document.getElementById('dl-max-lat').value}`;
  const zoom = `${document.getElementById('dl-min-zoom').value}-${document.getElementById('dl-max-zoom').value}`;
  const name = document.getElementById('dl-pack-name').value.trim() || 'custom_map_pack';

  try {
    const res = await fetch(`${BASE_URL}/download_map`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox, zoom, name })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const dest = data.output_file || data.storage_dir || 'electron/tiles';
    showToast('success', 'DOWNLOAD STARTED', `Saving to ${dest}`);
    if (typeof window.refreshSettingsMapUI === 'function') {
      window.refreshSettingsMapUI();
    }

    const poll = setInterval(async () => {
      try {
        const st = await fetch(`${BASE_URL}/download_map/status`);
        if (!st.ok) return;
        const job = await st.json();
        if (job.status === 'running') return;
        clearInterval(poll);
        btn.innerText = 'START DOWNLOAD';
        btn.disabled = false;
        if (job.status === 'done') {
          showToast('success', 'DOWNLOAD COMPLETE', job.output_file || name);
          await reloadMapTiles();
        } else if (job.status === 'error') {
          showToast('error', 'DOWNLOAD FAILED', job.message || 'Unknown error');
        }
        if (typeof window.refreshSettingsMapUI === 'function') {
          window.refreshSettingsMapUI();
        }
      } catch (_) {}
    }, 4000);
  } catch (e) {
    showToast('error', 'DOWNLOAD FAILED', e.message);
    btn.innerText = 'START DOWNLOAD';
    btn.disabled = false;
  }

  setTimeout(() => {
    if (btn.disabled) {
      document.getElementById('offline-map-modal').style.display = 'none';
      if (typeof window.openSettingsModal === 'function') {
        window.openSettingsModal();
      }
    }
  }, 1500);
};

// Update the right panel live mission overview
function updateMissionOverview() {
  const container = document.getElementById('right-mission-overview');
  if (!container) return;

  const activeMissions = appState.targets.filter(t => t.assignedDroneId);

  if (activeMissions.length === 0) {
    container.innerHTML = `<div class="ms-empty-msg">NO ACTIVE ASSIGNMENTS</div>`;
    return;
  }

  let html = '';
  activeMissions.forEach(tgt => {
    const drone = appState.drones[tgt.assignedDroneId];

    let distStr = '—';
    let batStr = '—';
    let batClass = 'rm-bat';

    if (drone) {
      const dist = getDistance(drone.lat, drone.lon, tgt.lat, tgt.lon);
      distStr = dist < 1000 ? `${dist.toFixed(0)}m` : `${(dist / 1000).toFixed(2)}km`;

      batStr = `${drone.battery}%`;
      if (drone.battery < 20) batClass += ' crit';
      else if (drone.battery < 40) batClass += ' low';
    }

    const isActive = ['dispatched', 'enroute', 'deploying', 'arrived'].includes(tgt.status);
    const statClass = isActive ? 'engaged' : '';
    const statLabel = tgt.status.toUpperCase();

    html += `
      <div class="rm-card">
        <div class="rm-header">
          <span class="rm-title">TARGET T${tgt.id}</span>
          <span class="rm-status ${statClass}">${statLabel}</span>
        </div>
        <div class="rm-row">
          <span>UAV ASSIGNED</span>
          <span class="rm-val">#${tgt.assignedDroneId}</span>
        </div>
        <div class="rm-row">
          <span>BATTERY</span>
          <span class="${batClass}">${batStr}</span>
        </div>
        <div class="rm-row">
          <span>DISTANCE TO TGT</span>
          <span class="rm-val">${distStr}</span>
        </div>
        <div class="rm-row">
          <span>COORDINATES</span>
          <span class="rm-val">${tgt.lat.toFixed(4)}N, ${tgt.lon.toFixed(4)}E</span>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}
