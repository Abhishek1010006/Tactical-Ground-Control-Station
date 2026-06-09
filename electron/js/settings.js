/**
 * ==============================================================================
 * electron/js/settings.js — Map & Offline Tile Settings UI
 * ==============================================================================
 * Manages the settings modal and map/offline UI components. It handles:
 *  - Fleet tab switcher logic.
 *  - Displaying the live offline map pack list and online/offline status.
 *  - Renaming and deleting downloaded map packs via the Python API.
 *  - Tracking the status of active map pack downloads.
 * ==============================================================================
 */
const GCS_API = 'http://127.0.0.1:5000';

function friendlyApiError(error) {
  const message = String(error && error.message ? error.message : error || '');
  if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
    return 'Tile API is still starting. Online map display can continue, but map pack management needs the Python backend.';
  }
  return message || 'Tile API is not reachable yet.';
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(button => button.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(view => view.classList.remove('active'));
  document.getElementById('tab-' + name)?.classList.add('active');
  document.getElementById('view-' + name)?.classList.add('active');
}

function formatPackSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let u = 0;
  while (size >= 1024 && u < units.length - 1) {
    size /= 1024;
    u++;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[u]}`;
}

function formatBounds(bounds) {
  if (!bounds || bounds.length !== 4) return '—';
  return `${bounds[0].toFixed(2)}°, ${bounds[1].toFixed(2)}° → ${bounds[2].toFixed(2)}°, ${bounds[3].toFixed(2)}°`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------------------
// API FETCH HELPERS
// ------------------------------------------------------------------------------

async function fetchMapPacks() {
  const res = await fetch(`${GCS_API}/tiles/packs`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchTilesMetadata() {
  const res = await fetch(`${GCS_API}/tiles/metadata`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchOnlineStatus() {
  try {
    const res = await fetch(`${GCS_API}/tiles/online_status`);
    if (!res.ok) return { online: false };
    return res.json();
  } catch (_) {
    return { online: false };
  }
}

async function isTileApiReady() {
  try {
    const res = await fetch(`${GCS_API}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// ------------------------------------------------------------------------------
// UI RENDERING LOGIC
// ------------------------------------------------------------------------------

function renderDownloadStatus(download) {
  const el = document.getElementById('settings-download-status');
  if (!el) return;
  if (!download || download.status === 'idle') {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'block';
  const cls = download.status === 'error' ? 'error' : download.status === 'done' ? 'done' : 'running';
  el.className = `settings-download-status ${cls}`;
  const file = download.output_file ? `<div class="dl-status-file">${escapeHtml(download.output_file)}</div>` : '';
  el.innerHTML = `
    <strong>Download ${download.status.toUpperCase()}</strong>
    <div>${escapeHtml(download.name || '')} · bbox ${escapeHtml(download.bbox || '')} · z${escapeHtml(download.zoom || '')}</div>
    <div>${escapeHtml(download.message || '')}</div>
    ${file}
  `;
}

function renderPackList(packs) {
  const list = document.getElementById('settings-pack-list');
  if (!list) return;

  if (!packs.length) {
    list.innerHTML = '<div class="settings-pack-empty">No offline packs yet. Use <strong>DOWNLOAD NEW PACK</strong> to add satellite tiles for an area.</div>';
    return;
  }

  list.innerHTML = packs.map(pack => {
    const actions = pack.protected
      ? '<span class="pack-protected-tag">AUTO (browse cache)</span>'
      : `<button type="button" class="btn settings-mini-btn pack-rename-btn" data-id="${escapeHtml(pack.id)}">RENAME</button>
         <button type="button" class="btn settings-mini-btn pack-delete-btn" data-id="${escapeHtml(pack.id)}">DELETE</button>`;
    return `
      <div class="settings-pack-item" data-id="${escapeHtml(pack.id)}">
        <div class="pack-item-top">
          <span class="pack-name">${escapeHtml(pack.name)}</span>
          <span class="pack-size">${formatPackSize(pack.size_bytes)}</span>
        </div>
        <div class="pack-item-meta">${escapeHtml(pack.filename)} · ${pack.tile_count.toLocaleString()} tiles · z${pack.minzoom}–z${pack.maxzoom}</div>
        <div class="pack-item-bounds">${formatBounds(pack.bounds)}</div>
        <div class="pack-item-actions">${actions}</div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.pack-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deletePack(btn.dataset.id));
  });
  list.querySelectorAll('.pack-rename-btn').forEach(btn => {
    btn.addEventListener('click', () => renamePack(btn.dataset.id));
  });
}

// ------------------------------------------------------------------------------
// MODAL STATE REFRESH
// ------------------------------------------------------------------------------

async function refreshSettingsMapUI() {
  const pathEl = document.getElementById('settings-storage-path');
  const countEl = document.getElementById('settings-map-pack-count');
  const zoomEl = document.getElementById('settings-map-usable-zoom');
  const onlineEl = document.getElementById('settings-map-online');
  const list = document.getElementById('settings-pack-list');
  const downloadBtn = document.getElementById('btn-open-offline-downloader');

  if (onlineEl) onlineEl.textContent = 'CHECKING...';
  if (countEl) countEl.textContent = '—';
  if (zoomEl) zoomEl.textContent = '—';

  try {
    const ready = await isTileApiReady();
    if (!ready) throw new Error('Tile API is still starting');

    const [packData, meta, online] = await Promise.all([
      fetchMapPacks(),
      fetchTilesMetadata(),
      fetchOnlineStatus()
    ]);

    if (pathEl) pathEl.textContent = packData.storage_dir || '—';
    if (countEl) countEl.textContent = String(packData.packs?.length ?? 0);
    const usable = meta?.usable_maxzoom ?? meta?.maxzoom ?? '—';
    if (zoomEl) zoomEl.textContent = meta ? `z0–z${usable} (native in packs)` : '—';
    if (onlineEl) {
      onlineEl.textContent = online.online
        ? 'ONLINE — satellite + local packs'
        : (packData.packs?.length ? 'OFFLINE — local packs only' : 'OFFLINE — no packs loaded');
    }

    renderPackList(packData.packs || []);
    renderDownloadStatus(packData.download);
    if (downloadBtn) {
      downloadBtn.disabled = false;
      downloadBtn.title = '';
    }
  } catch (e) {
    const friendly = friendlyApiError(e);
    if (pathEl) pathEl.textContent = 'Waiting for local API at http://127.0.0.1:5000';
    if (onlineEl) onlineEl.textContent = 'API STARTING';
    if (countEl) countEl.textContent = '—';
    if (zoomEl) zoomEl.textContent = '—';
    if (list) {
      list.innerHTML = `
        <div class="settings-pack-empty">
          ${escapeHtml(friendly)}
          <br><br>
          Keep this panel open or press <strong>REFRESH</strong> after the backend terminal says ready.
        </div>
      `;
    }
    if (downloadBtn) {
      downloadBtn.disabled = true;
      downloadBtn.title = 'Map downloads need the local Python tile API.';
    }
  }
}

// ------------------------------------------------------------------------------
// PACK MANAGEMENT (DELETE & RENAME)
// ------------------------------------------------------------------------------

async function deletePack(packId) {
  const name = packId.replace(/\.mbtiles$/i, '');
  if (!confirm(`Delete offline map pack "${name}"?\n\nThis removes the .mbtiles file from disk. This cannot be undone.`)) return;

  try {
    const res = await fetch(`${GCS_API}/tiles/packs/${encodeURIComponent(packId)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (typeof window.showToast === 'function') {
      window.showToast('success', 'PACK DELETED', name);
    }
    await refreshSettingsMapUI();
    if (typeof window.reloadMapTiles === 'function') {
      await window.reloadMapTiles();
    }
  } catch (e) {
    if (typeof window.showToast === 'function') {
      window.showToast('error', 'DELETE FAILED', e.message);
    } else {
      alert(e.message);
    }
  }
}

async function renamePack(packId) {
  const current = packId.replace(/\.mbtiles$/i, '');
  const next = prompt('New pack name (letters, numbers, underscore, hyphen):', current);
  if (!next || next.trim() === current) return;

  try {
    const res = await fetch(`${GCS_API}/tiles/packs/${encodeURIComponent(packId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: next.trim() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (typeof window.showToast === 'function') {
      window.showToast('success', 'PACK RENAMED', data.name || next);
    }
    await refreshSettingsMapUI();
    if (typeof window.reloadMapTiles === 'function') {
      await window.reloadMapTiles();
    }
  } catch (e) {
    if (typeof window.showToast === 'function') {
      window.showToast('error', 'RENAME FAILED', e.message);
    } else {
      alert(e.message);
    }
  }
}

// ------------------------------------------------------------------------------
// MODAL EVENT BINDING & INITIALIZATION
// ------------------------------------------------------------------------------

function openSettingsModal() {
  document.getElementById('settings-modal').style.display = 'flex';
  refreshSettingsMapUI();
}

function openDownloaderModal() {
  document.getElementById('settings-modal').style.display = 'none';
  document.getElementById('offline-map-modal').style.display = 'flex';
  if (typeof window.configureMapDownloaderPath === 'function') {
    window.configureMapDownloaderPath();
  }
}

window.refreshSettingsMapUI = refreshSettingsMapUI;
window.openSettingsModal = openSettingsModal;
window.openDownloaderModal = openDownloaderModal;

document.getElementById('btn-settings')?.addEventListener('click', openSettingsModal);
document.getElementById('btn-close-settings')?.addEventListener('click', () => {
  document.getElementById('settings-modal').style.display = 'none';
});
document.getElementById('btn-refresh-packs')?.addEventListener('click', refreshSettingsMapUI);
document.getElementById('btn-open-offline-downloader')?.addEventListener('click', openDownloaderModal);

// Poll download status while settings is open
setInterval(() => {
  const modal = document.getElementById('settings-modal');
  if (!modal || modal.style.display === 'none') return;
  fetch(`${GCS_API}/download_map/status`)
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data) renderDownloadStatus(data); })
    .catch(() => {});
}, 3000);
