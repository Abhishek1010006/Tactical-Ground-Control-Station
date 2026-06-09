/**
 * ==============================================================================
 * electron/main.js — Main Process Entry Point
 * ==============================================================================
 * This is the core Electron backend file. It is responsible for:
 *  - Launching the SwarmGCS UI Window (Renderer).
 *  - Spawning the Python API server in the background (as a separate process).
 *  - Bridging logs from the Python API and the Renderer to the main console.
 *  - Handling graceful shutdowns to ensure the Python backend is terminated
 *    cleanly when the user closes the app.
 * ==============================================================================
 */
const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

let pyProcess = null;

function shouldLogRendererMessage(message) {
  const text = String(message || '');
  const noisy = ['[Map]', 'maplibre', 'Network error', 'Failed to fetch', 'AbortError', 'ERR_', '/tiles', 'tile'];
  if (noisy.some(item => text.includes(item))) return false;

  const useful = ['[Boot]', '[UI]', 'CONNECT', 'SWARM', 'ATTACK', 'RTL', 'DROP', 'UAV', 'DRONE', 'Target', 'Mode'];
  return useful.some(item => text.includes(item)) || text.startsWith('>>');
}

// ------------------------------------------------------------------------------
// TERMINAL / LOGGING BRIDGE
// ------------------------------------------------------------------------------
// Intercepts the Python subprocess output and forwards it to the console.
function attachPythonLogs(child) {
  if (!child) return;
  if (!child.stdout || !child.stderr) return;
  child.stdout.on('data', (d) => process.stdout.write(`[tile-server] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[tile-server] ${d}`));
}

// ------------------------------------------------------------------------------
// PYTHON BACKEND MANAGEMENT
// ------------------------------------------------------------------------------
function isBackendHealthy(timeoutMs = 600) {
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:5000/health', { timeout: timeoutMs }, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

// Attempts to start the api_server.py script directly so the app can capture logs
// and avoid a hidden cmd.exe failure leaving the renderer unable to fetch /connect.
async function startPythonBackend() {
  const backendCwd = path.join(__dirname, '..');
  if (await isBackendHealthy()) {
    console.log('Python backend already running on http://127.0.0.1:5000');
    return;
  }

  const attempts = process.platform === 'win32'
    ? [['python', ['-u', 'api_server.py']], ['py', ['-3', '-u', 'api_server.py']]]
    : [['python3', ['-u', 'api_server.py']], ['python', ['-u', 'api_server.py']]];
  for (const [cmd, args] of attempts) {
    console.log('Starting API server:', cmd, args.join(' '), 'in', backendCwd);
    pyProcess = spawn(cmd, args, {
      cwd: backendCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: process.env
    });
    attachPythonLogs(pyProcess);
    pyProcess.on('exit', (code, signal) => {
      console.log(`Python backend exited: code=${code} signal=${signal}`);
    });
    break;
  }
}

// ------------------------------------------------------------------------------
// ELECTRON BROWSER WINDOW
// ------------------------------------------------------------------------------
// Creates the primary Chromium window for the GCS Tactical UI.
function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    },
    backgroundColor: '#08090C',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#08090C',
      symbolColor: '#8A909E',
      height: 32
    }
  });

  // Keep the launcher terminal focused on app actions, not map tile noise.
  win.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    if (!shouldLogRendererMessage(message)) return;
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });

  win.on('close', (e) => {
    e.preventDefault();
    dialog.showMessageBox(win, {
      type: 'question',
      title: 'SwarmGCS — Confirm Exit',
      message: 'Shutdown SwarmGCS?',
      detail: 'All drone connections and the Python backend will be terminated.',
      buttons: ['Cancel', 'Shutdown'],
      defaultId: 1,
      cancelId: 0
    }).then(({ response }) => {
      if (response === 1) {
        win.destroy();
        app.quit();
      }
    });
  });

  win.loadFile('index.html');
}

// ------------------------------------------------------------------------------
// APP LIFECYCLE HOOKS
// ------------------------------------------------------------------------------

app.whenReady().then(async () => {
  await startPythonBackend();
  // Open immediately; the renderer uses online map tiles until the local API is ready.
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  try {
    if (pyProcess) {
      pyProcess.kill('SIGTERM');
    }
  } catch (_) {
    try { if (pyProcess) pyProcess.kill('SIGKILL'); } catch (_) {}
  }
});
