// Sahne Plus — Electron main process: hosts the alert server, the controller window, tray and autostart.
'use strict';
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  dialog,
  nativeImage,
  clipboard,
  safeStorage,
  session,
  Notification
} = require('electron');
const path = require('path');
const fs = require('fs');
const { createServer, typeOf, parsePacProxy } = require('../server/server');
const { createUpdater } = require('./updater');

const APP_NAME = 'Sahne Plus';
const VERSION = app.getVersion();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ICON_PNG = path.join(__dirname, '..', 'build', 'icon.png');
const TRAY_PNG = path.join(__dirname, '..', 'build', 'tray.png');
// data lives in Documents\Sahne Plus (visible to the user, survives uninstall). SAHNE_PLUS_DATA_DIR overrides it for development/testing.
const DATA_DIR = process.env.SAHNE_PLUS_DATA_DIR
  ? path.resolve(process.env.SAHNE_PLUS_DATA_DIR)
  : path.join(app.getPath('documents'), 'Sahne Plus');
const LEGACY_DIR = path.join(app.getPath('documents'), 'KickAlerts');
const LOG_FILE = path.join(DATA_DIR, 'sahne-plus.log');
const START_HIDDEN = process.argv.includes('--hidden');
const SECURITY_CONTACT = 'https://github.com/AmirEyZed/sahne-plus/security/advisories/new';

app.setName(APP_NAME);
// userData (Chromium profile + single-instance lock). A test instance with its own data dir must not collide with the installed app.
app.setPath(
  'userData',
  process.env.SAHNE_PLUS_DATA_DIR ? path.join(DATA_DIR, '.electron') : path.join(app.getPath('appData'), 'SahnePlus')
);
app.setAppUserModelId('com.amireyzed.sahneplus');

// app.quit() does not cancel the pending 'ready' event, so startup below must also check the lock (a second launch
// must only bring the existing window to the front, never start a second server or show a port error).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

let win = null,
  tray = null,
  server = null,
  quitting = false;

// ---------- file log (rotates at 5 MB; never receives the KickBot secret — the server redacts it) ----------
function fileLog(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch {}
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// ---------- secret store: Windows DPAPI through Electron safeStorage (current user + machine bound) ----------
const secretStore = {
  available: () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  encrypt: s => safeStorage.encryptString(String(s)).toString('base64'),
  decrypt: b64 => safeStorage.decryptString(Buffer.from(String(b64), 'base64'))
};

// ---------- no remote debugging in the packaged app ----------
// The EnableNodeCliInspectArguments fuse does not cover Chromium's own switches: `--remote-debugging-port` would let a
// local process script the controller window (and the preload bridge) over the DevTools protocol. The DevTools server
// starts after the main script ran, so removing the switches here is enough; if that ever fails, refuse to start.
// Unpackaged runs (`electron .`) keep the switches for test tooling.
const REMOTE_DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address'];
if (app.isPackaged) {
  const found = REMOTE_DEBUG_SWITCHES.filter(s => app.commandLine.hasSwitch(s));
  for (const s of found) app.commandLine.removeSwitch(s);
  if (found.length) {
    const left = REMOTE_DEBUG_SWITCHES.filter(s => app.commandLine.hasSwitch(s));
    fileLog(
      `[${new Date().toISOString()}] WARN ignored command-line switch ${found.map(s => '--' + s).join(', ')}` +
        (left.length ? ' — could not remove it, quitting' : '')
    );
    if (left.length) app.exit(1);
  }
}

// ---------- first run: import the legacy KickAlerts folder (copy, never move) ----------
function migrateLegacy() {
  const cfg = path.join(DATA_DIR, 'config.json');
  if (fs.existsSync(cfg)) return false;
  const legacyCfg = path.join(LEGACY_DIR, 'config.json');
  if (!fs.existsSync(legacyCfg)) return false;
  try {
    fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
    fs.copyFileSync(legacyCfg, cfg);
    const lm = path.join(LEGACY_DIR, 'media');
    if (fs.existsSync(lm))
      for (const f of fs.readdirSync(lm)) {
        const s = path.join(lm, f);
        if (fs.statSync(s).isFile() && typeOf(f)) fs.copyFileSync(s, path.join(DATA_DIR, 'media', f));
      }
    fileLog(`[${new Date().toISOString()}] INFO imported legacy KickAlerts data`);
    return true;
  } catch (e) {
    fileLog(`[${new Date().toISOString()}] WARN legacy import failed: ${e.message}`);
    return false;
  }
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    backgroundColor: '#141416',
    show: false,
    title: APP_NAME,
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged
    }
  });
  win.setMenuBarVisibility(false);
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(false)); // no camera/mic/notifications/geolocation/etc.
  ses.setPermissionCheckHandler(() => false);
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.loadURL(server.appUrl());
  win.once('ready-to-show', () => {
    if (!START_HIDDEN) win.show();
  });
  win.on('close', e => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(server.appUrl())) {
      e.preventDefault();
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- tray ----------
function createTray() {
  let img = nativeImage.createEmpty();
  try {
    if (fs.existsSync(TRAY_PNG)) img = nativeImage.createFromPath(TRAY_PNG);
    else if (fs.existsSync(ICON_PNG)) img = nativeImage.createFromPath(ICON_PNG).resize({ width: 16, height: 16 });
  } catch {}
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'باز کردن Sahne Plus', click: () => showWindow() },
      { label: 'کپی لینک Browser Source', click: () => clipboard.writeText(server.overlayUrl()) },
      { type: 'separator' },
      { label: 'خروج کامل', click: () => quitApp() }
    ])
  );
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

// ---------- autostart ----------
const TEST_INSTANCE = !!process.env.SAHNE_PLUS_DATA_DIR; // a test/dev instance must never register itself for login
function autostartGet() {
  if (TEST_INSTANCE) return false;
  try {
    return !!app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
  } catch {
    return false;
  }
}
function autostartSet(on) {
  if (TEST_INSTANCE) return false;
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'], name: 'SahnePlus' });
  } catch (e) {
    fileLog('autostart error ' + e.message);
  }
  return autostartGet();
}
function quitApp() {
  quitting = true;
  app.quit();
}

// ---------- IPC (every argument is validated; the renderer never passes paths, URLs or commands through unchecked) ----------
const fromMain = e => e.sender === (win && win.webContents); // only our own window may call
ipcMain.handle('win:minimize', e => {
  if (fromMain(e) && win) win.minimize();
});
ipcMain.handle('win:toggleMax', e => {
  if (!fromMain(e) || !win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('win:isMax', e => fromMain(e) && !!(win && win.isMaximized()));
ipcMain.handle('win:close', e => {
  if (fromMain(e) && win) win.hide();
});
ipcMain.handle('app:quit', e => {
  if (fromMain(e)) quitApp();
});
ipcMain.handle('app:info', e => {
  if (!fromMain(e)) return null;
  return {
    name: APP_NAME,
    version: VERSION,
    dataDir: DATA_DIR,
    mediaDir: server ? server.mediaDir : '',
    port: server ? server.port : 7788,
    overlayUrl: server ? server.overlayUrl() : '',
    logFile: LOG_FILE,
    autostart: autostartGet(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    secretStore: secretStore.available(),
    securityContact: SECURITY_CONTACT,
    packaged: app.isPackaged
  };
});
const EXTERNAL_ALLOW = [
  /^https:\/\/(www\.)?kick\.com\//i,
  /^https:\/\/(widgets\.)?kickbot\.(com|live)\//i,
  /^https:\/\/(www\.)?bonbast\.com\//i,
  /^https:\/\/(www\.)?baha24\.com\//i,
  /^https:\/\/github\.com\//i
];
ipcMain.handle('app:openExternal', (e, url) => {
  if (!fromMain(e)) return false;
  const u = String(url || '');
  if (!EXTERNAL_ALLOW.some(r => r.test(u))) return false;
  shell.openExternal(u);
  return true;
});
ipcMain.handle('app:openPath', (e, which) => {
  if (!fromMain(e)) return '';
  const map = { media: server && server.mediaDir, data: DATA_DIR, log: LOG_FILE };
  const target = map[String(which)];
  return target ? shell.openPath(target) : '';
});
ipcMain.handle('app:autostart', (e, on) => {
  if (!fromMain(e)) return false;
  if (typeof on === 'boolean') {
    const r = autostartSet(on);
    try {
      server.config.app.autostart = on;
      server.saveConfig();
    } catch {}
    return r;
  }
  return autostartGet();
});
ipcMain.handle('app:copy', (e, text) => {
  if (!fromMain(e)) return false;
  clipboard.writeText(String(text || '').slice(0, 2000));
  return true;
});
ipcMain.handle('files:pick', async e => {
  if (!fromMain(e)) return { added: [], skipped: [] };
  const r = await dialog.showOpenDialog(win, {
    title: 'افزودن فایل الرت',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Media',
        extensions: ['webm', 'mp4', 'mov', 'mkv', 'gif', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'ogg', 'm4a']
      }
    ]
  });
  if (r.canceled || !r.filePaths.length) return { added: [], skipped: [] };
  return server.importFiles(r.filePaths);
});
ipcMain.handle('files:import', (e, paths) => {
  if (!fromMain(e)) return { added: [], skipped: [] };
  const list = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p.length < 1024).slice(0, 100) : [];
  return server.importFiles(list);
});
ipcMain.handle('data:clear', async e => {
  if (!fromMain(e)) return false;
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['پاک کن و ری‌استارت', 'انصراف'],
    defaultId: 1,
    cancelId: 1,
    title: APP_NAME,
    message: 'همه‌ی داده‌های Sahne Plus پاک شود؟',
    detail: `تنظیمات، اتصال کیک‌بات و همه‌ی فایل‌های الرت داخل\n${DATA_DIR}\nحذف می‌شوند. فایل‌های اصلی شما در جاهای دیگر دست نمی‌خورند. این کار قابل بازگشت نیست.`
  });
  if (r.response !== 0) return false;
  try {
    server.clearData();
    for (const f of [LOG_FILE, LOG_FILE + '.1']) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  } catch (err) {
    fileLog(`[${new Date().toISOString()}] ERROR clear data ${err.message}`);
  }
  quitting = true;
  app.relaunch();
  app.quit();
  return true;
});
ipcMain.on('diag:preload', (e, info) => {
  if (fromMain(e))
    fileLog(
      `[${new Date().toISOString()}] INFO preload ready ${JSON.stringify({ sandboxed: !!(info && info.sandboxed), webUtils: !!(info && info.webUtils) })}`
    );
});
app.on('web-contents-created', (e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', ev => ev.preventDefault());
});

// ---------- updates: check GitHub Releases; install only after the user clicks (never silent, never automatic) ----------
// Only an installed Windows build replaces itself. A test instance can download + verify in dry-run mode
// (SAHNE_PLUS_UPDATE_DRYRUN=1) and pretend to be an older version (SAHNE_PLUS_UPDATE_TEST_VERSION) - it never installs.
const UPDATE_DRY_RUN = TEST_INSTANCE && process.env.SAHNE_PLUS_UPDATE_DRYRUN === '1';
const CAN_SELF_UPDATE = (app.isPackaged && process.platform === 'win32' && !TEST_INSTANCE) || UPDATE_DRY_RUN;
const UPDATE_VERSION = (TEST_INSTANCE && process.env.SAHNE_PLUS_UPDATE_TEST_VERSION) || VERSION;
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
let updater = null;
function sendUpdate(s) {
  if (win && !win.isDestroyed()) win.webContents.send('update:status', s);
}
function updateChecksEnabled() {
  return !(server && server.config.app && server.config.app.updateCheck === false);
}
function notifyUpdate(s) {
  // one Windows notification per new version; the banner inside the app stays until the update is installed
  try {
    const cfg = server.config.app;
    if (TEST_INSTANCE || cfg.updateNotifiedFor === s.latest || !Notification.isSupported()) return;
    cfg.updateNotifiedFor = s.latest;
    server.saveConfig();
    const n = new Notification({
      title: 'نسخه‌ی جدید Sahne Plus',
      body: 'نسخه‌ی ' + s.latest + ' آماده است. برای آپدیت کلیک کنید.',
      icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined
    });
    n.on('click', () => {
      showWindow();
      if (updater) sendUpdate(updater.get());
    });
    n.show();
  } catch (e) {
    fileLog(`[${new Date().toISOString()}] WARN update notification ${e.message}`);
  }
}
async function runUpdateCheck(manual) {
  if (!updater) return null;
  if (!manual && !updateChecksEnabled()) return updater.get();
  const s = await updater.check();
  if (s.status === 'available' && !manual) notifyUpdate(s);
  return s;
}
ipcMain.handle('update:get', e => (fromMain(e) && updater ? updater.get() : null));
ipcMain.handle('update:check', e => (fromMain(e) ? runUpdateCheck(true) : null));
ipcMain.handle('update:install', e => (fromMain(e) && updater ? updater.install(quitApp) : null));

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  if (!gotLock) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    dialog.showErrorBox(APP_NAME, 'پوشه‌ی داده قابل ساخت نیست: ' + DATA_DIR + '\n' + e.message);
    return quitApp();
  }
  const imported = migrateLegacy();
  server = createServer({
    dataDir: DATA_DIR,
    publicDir: PUBLIC_DIR,
    appVersion: VERSION,
    onLog: fileLog,
    openPath: p => shell.openPath(p),
    secretStore,
    meldSelfHeal: !process.env.SAHNE_PLUS_DATA_DIR,
    // Node ignores the Windows system proxy (VPN apps in "system proxy" mode); Chromium resolves it, PAC included
    systemProxy: async url => parsePacProxy(await session.defaultSession.resolveProxy(url))
  });
  if (server.config.app && server.config.app.autostart !== false && !autostartGet()) autostartSet(true);
  try {
    await server.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      const r = dialog.showMessageBoxSync({
        type: 'error',
        title: APP_NAME,
        buttons: ['تلاش دوباره', 'خروج'],
        defaultId: 0,
        message: `پورت ${server.port} در حال استفاده است`,
        detail:
          'برنامه‌ی دیگری (مثلاً KickAlerts قدیمی یا یک نسخه‌ی دیگر Sahne Plus) این پورت را گرفته. آن را ببندید و دوباره تلاش کنید. Sahne Plus هرگز روی پورت یا آدرس دیگری باز نمی‌شود.'
      });
      if (r === 0) app.relaunch();
      return quitApp();
    }
    dialog.showErrorBox(APP_NAME, 'سرور اجرا نشد: ' + e.message);
    return quitApp();
  }
  if (imported) server.log('info', 'تنظیمات و فایل‌های KickAlerts قدیمی وارد شد');
  createWindow();
  createTray();
  updater = createUpdater({
    version: UPDATE_VERSION,
    canInstall: CAN_SELF_UPDATE,
    dryRun: UPDATE_DRY_RUN,
    log: (level, msg, extra) => server.log(level, msg, extra),
    onChange: sendUpdate
  });
  setTimeout(() => runUpdateCheck(false), 30 * 1000);
  setInterval(() => runUpdateCheck(false), UPDATE_EVERY_MS);
});
app.on('window-all-closed', () => {
  /* keep running in the tray */
});
app.on('activate', () => showWindow());
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', async () => {
  try {
    if (server) await server.stop();
  } catch {}
});
process.on('uncaughtException', e =>
  fileLog(`[${new Date().toISOString()}] ERROR uncaught ${e && (e.stack || e.message)}`)
);
process.on('unhandledRejection', e =>
  fileLog(`[${new Date().toISOString()}] ERROR unhandled ${e && (e.stack || e.message || e)}`)
);
