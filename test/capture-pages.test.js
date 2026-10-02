// Exercise the screenshot script with Electron and file writes stubbed: no window, service or screenshot is needed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const scriptDir = path.join(__dirname, '..', 'scripts');
const source = fs.readFileSync(path.join(scriptDir, 'capture-pages.js'), 'utf8');

async function capture(args) {
  const result = { urls: [], writes: [], errors: [], windows: 0, exitCode: null, quit: false };
  let ready;
  const exit = new Error('app.exit');
  const app = {
    getPath: () => os.tmpdir(),
    setPath() {},
    whenReady: () => ({ then: fn => (ready = fn()) }),
    quit: () => (result.quit = true),
    exit: code => {
      result.exitCode = code;
      throw exit;
    }
  };
  class BrowserWindow {
    constructor() {
      result.windows++;
      this.webContents = {
        setFrameRate() {},
        executeJavaScript: async () => {},
        capturePage: async () => ({ toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 1600, height: 1000 }) })
      };
    }
    async loadURL(url) {
      result.urls.push(url);
    }
    destroy() {}
  }
  const sandbox = {
    require: name => {
      if (name === 'electron') return { app, BrowserWindow };
      if (name === 'fs') return { mkdirSync() {}, writeFileSync: file => result.writes.push(file) };
      if (name === 'path') return path;
      throw new Error(`Unexpected module: ${name}`);
    },
    __dirname: scriptDir,
    process: { argv: ['electron', 'capture-pages.js', ...args], exitCode: 0 },
    console: { log() {}, error: (...values) => result.errors.push(values.join(' ')) },
    setTimeout: fn => fn()
  };
  try {
    vm.runInNewContext(source, sandbox, { filename: 'capture-pages.js' });
    await ready;
  } catch (error) {
    if (error !== exit) throw error;
  }
  return result;
}

test('screenshots: default and custom ports target the same loopback instance for both windows', async () => {
  for (const [args, port, outDir] of [
    [[], 7788, path.join(scriptDir, '..', 'release', 'screenshots')],
    [['custom output'], 7788, 'custom output'],
    [['custom output', '7799'], 7799, 'custom output'],
    [['custom output', '1024'], 1024, 'custom output'],
    [['custom output', '65535'], 65535, 'custom output']
  ]) {
    const result = await capture(args);
    assert.deepEqual(result.urls, [`http://127.0.0.1:${port}/`, `http://127.0.0.1:${port}/overlay?preview=1`]);
    assert.equal(result.writes.length, 7);
    assert.ok(result.writes.every(file => path.dirname(file) === path.resolve(outDir)));
    assert.deepEqual(result.errors, []);
    assert.equal(result.quit, true);
  }
});

test('screenshots: invalid ports exit before creating windows, loading URLs or writing screenshots', async () => {
  for (const port of ['', '0', '1023', '65536', '-1', '7799.5', '7799/path', 'http://example.invalid', '1e4']) {
    const result = await capture(['custom output', port]);
    assert.equal(result.exitCode, 1, port);
    assert.equal(result.windows, 0, port);
    assert.deepEqual(result.urls, [], port);
    assert.deepEqual(result.writes, [], port);
    assert.match(result.errors[0], /Invalid screenshot port/);
  }
});
