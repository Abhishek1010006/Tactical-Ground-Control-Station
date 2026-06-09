/**
 * ==============================================================================
 * electron/preload.js — Secure Bridge to Main Process
 * ==============================================================================
 * Exposes a limited, secure API to the Renderer process (UI window) 
 * so it can communicate with the Main process without enabling full Node.js
 * integration, adhering to Electron security best practices.
 * ==============================================================================
 */
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('electronAPI', {
  onBackendReady: (cb) => ipcRenderer.on('backend-ready', cb),
  getVersion: () => process.versions.electron
})
