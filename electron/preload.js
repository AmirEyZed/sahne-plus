// Sahne Plus — preload: the only bridge between the controller page and the desktop shell (sandboxed, context-isolated).
// Nothing here exposes Node, the filesystem, shell commands or raw IPC to the page.
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
try {
  ipcRenderer.send('diag:preload', {
    sandboxed: !!process.sandboxed,
    webUtils: !!(webUtils && typeof webUtils.getPathForFile === 'function')
  });
} catch {}

contextBridge.exposeInMainWorld('sahne', {
  desktop: true,
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMax: () => ipcRenderer.invoke('win:toggleMax'),
    isMax: () => ipcRenderer.invoke('win:isMax'),
    close: () => ipcRenderer.invoke('win:close'),
    onState: cb => {
      ipcRenderer.on('win:state', (e, s) => cb({ maximized: !!(s && s.maximized) }));
    }
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    quit: () => ipcRenderer.invoke('app:quit'),
    openExternal: url => ipcRenderer.invoke('app:openExternal', String(url)),
    openPath: which => ipcRenderer.invoke('app:openPath', String(which)), // 'media' | 'data' | 'log' only
    autostart: on => ipcRenderer.invoke('app:autostart', typeof on === 'boolean' ? on : undefined),
    copy: text => ipcRenderer.invoke('app:copy', String(text)),
    clearData: () => ipcRenderer.invoke('data:clear')
  },
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: cb => {
      ipcRenderer.on('update:status', (e, s) => cb(s && typeof s === 'object' ? { ...s } : null));
    }
  },
  files: {
    pick: () => ipcRenderer.invoke('files:pick'),
    importDropped: fileList => {
      const paths = [];
      for (const f of fileList) {
        try {
          const p = webUtils.getPathForFile(f);
          if (p) paths.push(p);
        } catch {}
      }
      return ipcRenderer.invoke('files:import', paths);
    }
  }
});
