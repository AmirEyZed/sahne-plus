// Captures poster-quality screenshots of the running Sahne Plus (http://127.0.0.1:7788) with a separate Electron window.
// Run: node_modules/.bin/electron scripts/capture-pages.js [outDir]
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'release', 'screenshots'));
const BASE = 'http://127.0.0.1:7788';
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.setPath('userData', path.join(app.getPath('temp'), 'sahne-plus-capture'));

async function shot(win, file) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  console.log('wrote', file, img.getSize().width + 'x' + img.getSize().height);
}
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    backgroundColor: '#141416',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
  });
  win.webContents.setFrameRate(10);
  try {
    await win.loadURL(BASE + '/');
    await sleep(1500);
    await win.webContents.executeJavaScript("goPage('home'); 'ok'");
    await sleep(1200);
    await shot(win, '01-home.png');
    await win.webContents.executeJavaScript("goPage('files'); 'ok'");
    await sleep(2500);
    await shot(win, '02-files.png');
    await win.webContents.executeJavaScript(
      "selectFile((CFG.files.find(f=>f.name==='titcanic')||CFG.files[0]).id); 'ok'"
    );
    await sleep(2000);
    await shot(win, '03-files-editor.png');
    await win.webContents.executeJavaScript("closeInspector(); goPage('look'); 'ok'");
    await sleep(1500);
    await win.webContents.executeJavaScript(
      "document.getElementById('pvName').value='Ali'; document.getElementById('pvAmount').value='10'; document.getElementById('btnPreview').click(); 'ok'"
    );
    await sleep(3500);
    await shot(win, '04-look.png');
    await win.webContents.executeJavaScript("goPage('settings'); 'ok'");
    await sleep(1200);
    await shot(win, '05-settings.png');
    await win.webContents.executeJavaScript("goPage('about'); 'ok'");
    await sleep(1500);
    await shot(win, '06-about.png');
    // overlay alone, transparent, with a preview alert
    const ov = new BrowserWindow({
      width: 1920,
      height: 1080,
      show: false,
      transparent: true,
      frame: false,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
    });
    ov.webContents.setFrameRate(10);
    await ov.loadURL(BASE + '/overlay?preview=1');
    await sleep(1500);
    await ov.webContents.executeJavaScript(
      "fetch('/api/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Ali',amount:10,message:'دمت گرم داداش، عالی بود 🔥'})}).then(()=>'sent')"
    );
    await sleep(2200);
    const img = await ov.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, '07-overlay-alert-transparent.png'), img.toPNG());
    console.log('wrote 07-overlay-alert-transparent.png', img.getSize().width + 'x' + img.getSize().height);
    ov.destroy();
  } catch (e) {
    console.error('capture failed:', e.message);
    process.exitCode = 1;
  }
  win.destroy();
  app.quit();
});
