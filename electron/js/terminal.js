/**
 * ==============================================================================
 * electron/js/terminal.js — In-App VS Code Style Terminal
 * ==============================================================================
 * This module provides an integrated console overlay for the UI. It handles:
 *  - Rendering the full-width terminal panel and status-bar toggle button.
 *  - Connecting to the Python backend's Server-Sent Events (SSE) stream
 *    (http://127.0.0.1:5000/terminal/stream) to show live backend logs.
 *  - Intercepting window.fetch to log UI→API calls and errors.
 *  - Intercepting JS errors and unhandled promise rejections.
 *  - Syncing the zoom button position when the terminal opens/closes.
 *  - Filtering out noisy map tile requests (/tiles/) from the log.
 * ==============================================================================
 */
(function () {

  // --------------------------------------------------------------------------
  // TERMINAL HTML TEMPLATE
  // --------------------------------------------------------------------------
  const TERMINAL_HTML = `
    <div id="gcs-terminal-panel" class="terminal-panel collapsed">
      <div class="terminal-resize-handle"></div>
      <div class="terminal-header">
        <div class="terminal-tabs">
          <div class="terminal-tab active">TERMINAL</div>
          <div class="terminal-sub-tabs">
            <span>main.py</span> &middot;
            <span>connect</span> &middot;
            <span>swarm</span> &middot;
            <span>attack</span> &middot;
            <span>commands</span>
          </div>
        </div>
        <div class="terminal-actions">
          <button class="term-text-btn" id="btn-term-clear" title="Clear Terminal">Clear</button>
          <button class="term-icon-btn" id="btn-term-close" title="Close Panel">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="terminal-output" id="gcs-terminal-output"></div>
    </div>
  `;

  // --------------------------------------------------------------------------
  // TOGGLE BUTTON HTML (injected into the bottom status bar)
  // --------------------------------------------------------------------------
  const TERMINAL_BTN_HTML = `
    <button id="btn-toggle-terminal" class="btn terminal-toggle-btn" title="Toggle Terminal (Ctrl+\`)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:4px;vertical-align:middle;">
        <polyline points="4 17 10 11 4 5"></polyline>
        <line x1="12" y1="19" x2="20" y2="19"></line>
      </svg>
      TERMINAL
      <span id="terminal-error-count" class="term-error-badge" style="display:none;">0</span>
    </button>
  `;

  // --------------------------------------------------------------------------
  // INJECT TERMINAL DOM
  // --------------------------------------------------------------------------
  document.body.insertAdjacentHTML('beforeend', TERMINAL_HTML);

  const statusBar = document.querySelector('.bottom-status-strip');
  if (statusBar) {
    statusBar.insertAdjacentHTML('afterbegin', TERMINAL_BTN_HTML);
  }

  // --------------------------------------------------------------------------
  // TERMINAL STATE
  // --------------------------------------------------------------------------
  let sse = null;
  let autoScroll = true;
  let isDragging = false;
  let startY = 0;
  let startHeight = 0;

  // Map and polling calls are intentionally hidden from this mission terminal.
  const MAP_URL_PATTERNS = [
    '/tiles/',
    '/tiles',
    '/download_map',
    '/terminal/',
    'mt0.google',
    'mt1.google',
    'mt2.google',
    'mt3.google',
    'google.com/vt',
    'tile.openstreetmap',
    'openstreetmap.org'
  ];
  const QUIET_API_PATTERNS = ['/sync', '/state', '/mission', '/health', '/roles'];

  function isMapRequest(url) {
    const s = String(url || '');
    return MAP_URL_PATTERNS.some(p => s.includes(p));
  }

  function isQuietRequest(url) {
    const s = String(url || '');
    return QUIET_API_PATTERNS.some(p => s.includes(p));
  }

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return String(input || '');
  }

  function requestMethod(input, options) {
    return String((options && options.method) || (input && input.method) || 'GET').toUpperCase();
  }

  // --------------------------------------------------------------------------
  // DOM REFERENCES
  // --------------------------------------------------------------------------
  const panel      = document.getElementById('gcs-terminal-panel');
  const output     = document.getElementById('gcs-terminal-output');
  const toggleBtn  = document.getElementById('btn-toggle-terminal');
  const closeBtn   = document.getElementById('btn-term-close');
  const clearBtn   = document.getElementById('btn-term-clear');
  const errorBadge = document.getElementById('terminal-error-count');
  const handle     = document.querySelector('.terminal-resize-handle');
  const zoomCtrls  = document.querySelector('.zoom-controls');
  const mapLegend  = document.getElementById('map-legend');
  let errorCount = 0;

  function resetErrorBadge() {
    errorCount = 0;
    if (errorBadge) {
      errorBadge.textContent = '0';
      errorBadge.style.display = 'none';
    }
  }

  function incrementErrorBadge() {
    const isOpen = panel && !panel.classList.contains('collapsed');
    if (isOpen) return;
    errorCount += 1;
    if (errorBadge) {
      errorBadge.textContent = String(errorCount);
      errorBadge.style.display = 'inline-flex';
    }
  }

  // --------------------------------------------------------------------------
  // ZOOM BUTTON SYNC
  // --------------------------------------------------------------------------
  // Keep map controls above the terminal when it is open.
  function syncZoomPosition() {
    const isOpen = !panel.classList.contains('collapsed');
    if (isOpen) {
      const termH = panel.offsetHeight || 250;
      const liftedBottom = (termH + 56) + 'px';
      if (zoomCtrls) {
        zoomCtrls.style.bottom = liftedBottom;
        zoomCtrls.classList.remove('terminal-hidden');
      }
      if (mapLegend) {
        mapLegend.style.bottom = liftedBottom;
        mapLegend.classList.add('terminal-open');
      }
    } else {
      if (zoomCtrls) {
        zoomCtrls.style.bottom = '60px';
        zoomCtrls.classList.add('terminal-hidden');
      }
      if (mapLegend) {
        mapLegend.style.bottom = '60px';
        mapLegend.classList.remove('terminal-open');
      }
    }
  }

  // --------------------------------------------------------------------------
  // TOGGLE LOGIC
  // --------------------------------------------------------------------------
  const toggleTerminal = () => {
    const isCollapsed = panel.classList.contains('collapsed');
    if (isCollapsed) {
      panel.classList.remove('collapsed');
      if (toggleBtn) toggleBtn.classList.add('active');
      resetErrorBadge();
      if (autoScroll) output.scrollTop = output.scrollHeight;
    } else {
      panel.classList.add('collapsed');
      if (toggleBtn) toggleBtn.classList.remove('active');
    }
    syncZoomPosition();
  };

  if (toggleBtn) toggleBtn.addEventListener('click', toggleTerminal);
  if (closeBtn)  closeBtn.addEventListener('click', () => {
    panel.classList.add('collapsed');
    if (toggleBtn) toggleBtn.classList.remove('active');
    syncZoomPosition();
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') toggleTerminal();
  });

  // --------------------------------------------------------------------------
  // RESIZING
  // --------------------------------------------------------------------------
  if (handle) {
    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startY = e.clientY;
      startHeight = panel.offsetHeight;
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });
  }

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dy = startY - e.clientY;
    let newHeight = Math.max(120, Math.min(startHeight + dy, window.innerHeight * 0.8));
    panel.style.height = `${newHeight}px`;
    syncZoomPosition();
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
    }
  });

  // --------------------------------------------------------------------------
  // SCROLLING
  // --------------------------------------------------------------------------
  output.addEventListener('scroll', () => {
    autoScroll = (output.scrollHeight - output.scrollTop) <= (output.clientHeight + 10);
  });

  // --------------------------------------------------------------------------
  // CLEAR BUTTON
  // --------------------------------------------------------------------------
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      output.innerHTML = '';
      resetErrorBadge();
      try {
        await window._origFetch('http://127.0.0.1:5000/terminal/clear', { method: 'POST' });
      } catch (_) {}
    });
  }

  // --------------------------------------------------------------------------
  // LOG RENDERING
  // --------------------------------------------------------------------------
  function escapeHTML(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function appendLog(text, source, level) {
    if (!text || !text.trim()) return;

    const line = document.createElement('div');
    line.className = 'term-line';

    const txt = String(text);
    let cls = 'term-text';

    // Colour coding
    if (level === 'error' || txt.includes('[ERROR]') || txt.includes('Error') || txt.includes('FAIL'))
      cls += ' term-err';
    else if (level === 'warn' || txt.includes('[WARN]') || txt.includes('WARNING'))
      cls += ' term-warn';
    else if (txt.includes('ready') || txt.includes('OK') || txt.includes('success') || txt.includes('CONNECTED') || txt.includes('ARMED'))
      cls += ' term-ok';
    else if (txt.startsWith('>>') || txt.startsWith('>>'))
      cls += ' term-ui';
    else if (txt.startsWith('[MBTile') || txt.startsWith('[tile') || txt.startsWith('SwarmGCS'))
      cls += ' term-server';

    if (cls.includes('term-err')) incrementErrorBadge();

    const srcTag = source ? `<span class="term-source">[${escapeHTML(source)}]</span> ` : '';
    line.innerHTML = `${srcTag}<span class="${cls}">${escapeHTML(txt)}</span>`;

    output.appendChild(line);

    // Cap DOM lines at 1000 for performance
    while (output.children.length > 1000) {
      output.removeChild(output.firstChild);
    }

    if (autoScroll) output.scrollTop = output.scrollHeight;
  }

  // --------------------------------------------------------------------------
  // GLOBAL TERMINAL API (used by app.js and attack-flow.js)
  // --------------------------------------------------------------------------
  window.gcsTerminal = {
    println: (msg, source) => appendLog(msg, source || 'ui', 'info'),
    error:   (msg, source) => appendLog(msg, source || 'ui', 'error'),
    warn:    (msg, source) => appendLog(msg, source || 'ui', 'warn'),
    info:    (msg, source) => appendLog(msg, source || 'ui', 'info'),
    clear:   ()            => { output.innerHTML = ''; }
  };

  // --------------------------------------------------------------------------
  // SSE STREAMING FROM PYTHON BACKEND
  // --------------------------------------------------------------------------
  function connectSSE() {
    if (sse) { try { sse.close(); } catch (_) {} }

    sse = new EventSource('http://127.0.0.1:5000/terminal/stream');

    sse.onopen = () => {
      appendLog('--- Terminal stream connected ---', 'sys', 'ok');
    };

    sse.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const line = data.line || '';
        // Raw server/tile chatter stays in the external backend terminal.
        if (isBackendNoise(line)) return;
        appendLog(line, 'server', 'info');
      } catch (_) {}
    };

    sse.onerror = () => {
      try { sse.close(); } catch (_) {}
      sse = null;
      // Retry quietly after 3 seconds
      setTimeout(connectSSE, 3000);
    };
  }

  // Delay first SSE connect by 1.5s to give the backend time to start
  setTimeout(connectSSE, 1500);

  function isBackendNoise(line) {
    const text = String(line || '');
    if (!text.trim()) return true;
    const noisy = [
      '/tiles',
      '/download_map',
      '/terminal/',
      '127.0.0.1',
      '[MBTiles]',
      'Serving Flask',
      'Debug mode',
      'WARNING:',
      'Running on http',
      'Press CTRL+C',
      'Connection reset or closed by peer on TCP socket',
      'GET /',
      'POST /',
      'API server running'
    ];
    if (noisy.some(item => text.includes(item))) return true;

    const useful = ['CONNECT', 'MAVLink', 'UAV', 'DRONE', 'Telemetry', 'ATTACK', 'RTL', 'DROP', 'ARM', 'MODE', 'Target', 'main.py'];
    return !useful.some(item => text.toLowerCase().includes(item.toLowerCase()));
  }

  function isBenignMapError(text) {
    const s = String(text || '');
    return s.includes('aborted') || s.includes('AbortError') || s.includes('Failed to fetch') || s.includes('NetworkError');
  }

  // --------------------------------------------------------------------------
  // JS ERROR INTERCEPTORS
  // --------------------------------------------------------------------------
  window.addEventListener('error', (e) => {
    if (isBenignMapError(e.message)) return;
    window.gcsTerminal.error(`${e.message} (${e.filename ? e.filename.split('/').pop() : '?'}:${e.lineno})`, 'js');
  });

  window.addEventListener('unhandledrejection', (e) => {
    if (isBenignMapError(e.reason)) return;
    window.gcsTerminal.error(`Unhandled rejection: ${e.reason}`, 'js');
  });

  // --------------------------------------------------------------------------
  // FETCH INTERCEPTOR — log API calls, filter map tile noise
  // --------------------------------------------------------------------------
  // Save original fetch before overriding
  window._origFetch = window.fetch.bind(window);

  window.fetch = async function (...args) {
    const input = args[0];
    const options = args[1] || {};
    const url = requestUrl(input);
    const method = requestMethod(input, options);

    // Silently pass through map tiles, polling, and normal reads.
    if (isMapRequest(url) || isQuietRequest(url) || method === 'GET') {
      return window._origFetch.apply(this, args);
    }
    const shortUrl = url.replace('http://127.0.0.1:5000', '');

    // Log only deliberate command requests.
    appendLog(`>> ${method} ${shortUrl}`, 'fetch', 'info');

    try {
      const response = await window._origFetch.apply(this, args);
      if (!response.ok) {
        window.gcsTerminal.error(`HTTP ${response.status} ${method} ${shortUrl}`, 'fetch');
      }
      return response;
    } catch (err) {
      if (err && (err.name === 'AbortError' || isBenignMapError(err.message))) throw err;
      window.gcsTerminal.error(`Network error: ${method} ${shortUrl} — ${err.message}`, 'fetch');
      throw err;
    }
  };

  // --------------------------------------------------------------------------
  // INIT: sync zoom position and show terminal open by default on load
  // --------------------------------------------------------------------------
  syncZoomPosition();

})();
