/**
 * ==============================================================================
 * electron/js/boot.js — Async Application Bootstrapper
 * ==============================================================================
 * This script is the entry point for the Electron renderer process. It handles:
 *  1. Asynchronously fetching and injecting HTML components (navbar, panels, map).
 *  2. Sequentially loading and executing application JavaScript files to 
 *     preserve dependency order (e.g., settings -> app -> terminal).
 * ==============================================================================
 */

// ------------------------------------------------------------------------------
// COMPONENT LOADER
// ------------------------------------------------------------------------------
async function loadComponents() {
  // Define components and their target container IDs
  const components = [
    { id: 'navbar-container', url: 'html/navbar.html' },
    { id: 'map-container', url: 'html/map_and_status.html' },
    { id: 'left-panel-container', url: 'html/left_panel.html' },
    { id: 'right-panel-container', url: 'html/right_panel.html' },
    { id: 'modals-container', url: 'html/modals.html' }
  ];

  // Fetch all HTML components in parallel
  const fetches = components.map(comp => fetch(comp.url).then(res => res.text()));
  const htmlContents = await Promise.all(fetches);

  // Inject HTML into containers
  components.forEach((comp, index) => {
    const container = document.getElementById(comp.id);
    if (container) {
      container.innerHTML = htmlContents[index];
    } else {
      console.error(`Container not found for ${comp.url}: ${comp.id}`);
    }
  });

  console.log('[Boot] HTML components loaded. Initializing scripts...');

  // ------------------------------------------------------------------------------
  // SCRIPT INJECTOR
  // ------------------------------------------------------------------------------
  // Application scripts must be loaded sequentially to preserve dependencies
  const scripts = [
    'assets/maplibre/maplibre-gl.js',
    'js/settings.js',
    'js/app.js',
    'js/attack-flow.js',
    'js/terminal.js'
  ];

  for (const src of scripts) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.body.appendChild(script);
    });
  }

  console.log('[Boot] All scripts loaded successfully.');
}

// Start the boot process
loadComponents().catch(err => {
  console.error('[Boot] Critical initialization error:', err);
});
