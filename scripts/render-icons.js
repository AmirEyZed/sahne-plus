// Renders the Sahne Plus icon SVGs to PNGs with Electron (offscreen). Run: node_modules/.bin/electron scripts/render-icons.js
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const OUT = path.join(__dirname, '..', 'build');
const SVG = fs.readFileSync(path.join(OUT, 'icon.svg'), 'utf8');
const TRAY_SVG = fs.readFileSync(path.join(OUT, 'tray.svg'), 'utf8');
const TMP = path.join(os.tmpdir(), 'sahne-plus-icon.html');

async function render(win, svg, size, file) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}svg{width:${size}px;height:${size}px;display:block}</style></head><body>${svg}</body></html>`;
  fs.writeFileSync(TMP, html);
  win.setContentSize(size, size);
  await win.loadFile(TMP);
  await new Promise(r => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  console.log('wrote', file, size + 'px');
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  });
  try {
    await render(win, SVG, 512, 'icon.png');
    await render(win, SVG, 256, 'icon-256.png');
    await render(win, TRAY_SVG, 32, 'tray.png');
    await render(win, TRAY_SVG, 16, 'tray-16.png');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  try {
    fs.unlinkSync(TMP);
  } catch {}
  win.destroy();
  app.quit();
});
