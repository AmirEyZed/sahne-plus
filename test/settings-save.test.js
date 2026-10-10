// Offline regressions for persisted settings and the controller's save feedback.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const vm = require('vm');
const { createServer } = require('../server/server');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-save-'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      port,
      mode: 'companion',
      appearance: { textSize: 30 },
      rate: { auto: false, manual: 100000, proxy: '' },
      kick: { enabled: false },
      app: { autostart: false, updateCheck: false },
      files: [{ id: '1234567890', file: 'sample.png', name: 'Sample', minToman: 1000 }]
    })
  );
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    testHooks: { offline: true }
  });
  await srv.start();
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = (method, route, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: route, method, headers: { 'Content-Type': 'application/json' } },
        res => {
          let raw = '';
          res.on('data', chunk => (raw += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }
      );
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  return { srv, dir, configPath, request, port };
}

for (const failure of ['write', 'rename']) {
  test(`settings ${failure} failure preserves disk/live state, prevents effects and permits retry`, async t => {
    const { srv, configPath, request, port } = await fixture(t);
    let networkCalls = 0;
    t.mock.method(https, 'request', () => {
      networkCalls++;
      throw new Error('offline transport');
    });
    const before = JSON.parse(JSON.stringify((await request('GET', '/api/config')).body.config));
    const diskBefore = fs.readFileSync(configPath, 'utf8');
    let block = true,
      failures = 0;
    const name = failure === 'write' ? 'writeFileSync' : 'renameSync';
    const original = fs[name];
    t.mock.method(fs, name, function (...args) {
      if (block && args[0] === configPath + '.tmp') {
        failures++;
        throw Object.assign(new Error('synthetic disk failure'), { code: failure === 'write' ? 'ENOSPC' : 'EBUSY' });
      }
      return original.apply(this, args);
    });
    // Subscribe to the actual preview SSE stream: failed edits must not reach it.
    let stream = '';
    const preview = http.get({ host: '127.0.0.1', port, path: '/events?role=preview' });
    t.after(() => preview.destroy());
    await new Promise((resolve, reject) => {
      preview.on('error', reject);
      preview.on('response', res => {
        res.on('data', chunk => {
          stream += chunk;
          if (stream.includes('"type":"config"')) resolve();
        });
      });
    });
    const configEvents = () => (stream.match(/"type":"config"/g) || []).length;
    const body = {
      mode: 'standalone',
      showAlertWithoutMedia: false,
      appearance: { textSize: 45 },
      app: { updateCheck: true },
      kick: { enabled: true },
      rate: { auto: true, manual: 120000 },
      files: [
        { id: '1234567890', name: 'Edited' },
        { id: '1234567890', volume: 20 }
      ]
    };
    const cases = [
      ['POST', '/api/config', body],
      ['PATCH', '/api/file', { id: '1234567890', name: 'Edited', minToman: 2000 }],
      ['POST', '/api/reset-settings', {}]
    ];
    for (const [method, route, payload] of cases) {
      const response = await request(method, route, payload);
      assert.equal(response.status, 500, route);
      assert.equal(response.body.ok, false);
      assert.equal(response.body.code, 'settings_save_failed');
      assert.match(response.body.error, /ذخیره نشد/);
      assert.ok(!JSON.stringify(response.body).includes(configPath), 'no filesystem paths in the response');
      assert.deepEqual((await request('GET', '/api/config')).body.config, before, route + ' preserves active settings');
      assert.equal(fs.readFileSync(configPath, 'utf8'), diskBefore, route + ' preserves the saved bytes');
      assert.equal(configEvents(), 1, 'no failed appearance broadcast');
      assert.equal(networkCalls, 0, 'no rate refresh before commit');
    }
    assert.equal(failures, 3, 'each handler attempts exactly one save');
    block = false;
    // Successful retry stages the same batch (including repeated ids) and keeps normalization.
    body.rate.auto = false;
    body.kick.enabled = false;
    const retry = await request('POST', '/api/config', body);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.ok, true);
    assert.equal(srv.config.appearance.textSize, 45);
    assert.equal(srv.config.files[0].name, 'Edited');
    assert.equal(srv.config.files[0].volume, 20);
    assert.equal(srv.config.app.updateCheck, true);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).appearance.textSize, 45);
    const fileRetry = await request('PATCH', '/api/file', { id: '1234567890', minToman: 2000 });
    assert.equal(fileRetry.body.ok, true);
    assert.equal(fileRetry.body.file.minToman, 2000);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).files[0].minToman, 2000);
    const reset = await request('POST', '/api/reset-settings', {});
    assert.equal(reset.body.ok, true);
    assert.equal(srv.config.mode, 'standalone');
    assert.equal(srv.config.files[0].minToman, 2000, 'reset preserves files');
    assert.equal(srv.config.app.updateCheck, true, 'reset preserves app options');
  });
}

test('an initial save failure does not crash before logging is initialized', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sahne-save-start-'));
  fs.mkdirSync(path.join(dir, 'config.json.tmp'));
  const srv = createServer({
    dataDir: dir,
    publicDir: path.join(__dirname, '..', 'public'),
    testHooks: { offline: true }
  });
  t.after(async () => {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(srv.saveConfig(), false);
  fs.rmdirSync(path.join(dir, 'config.json.tmp'));
  assert.equal(srv.saveConfig(), true);
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
});

// Run the actual controller with a minimal DOM. No real browser or provider transport is used.
function controller() {
  const nodes = new Map(),
    timers = new Map(),
    feedback = [],
    requests = [];
  let reloads = 0,
    timerId = 0,
    behavior = 'disk',
    desktopResult = false;
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        value: '',
        checked: false,
        textContent: '',
        type: 'text',
        dataset: {},
        validity: { badInput: false },
        classes: new Set(),
        listeners: {},
        setAttribute() {},
        setCustomValidity() {},
        classList: {
          add: value => nodes.get(selector).classes.add(value),
          remove: value => nodes.get(selector).classes.delete(value),
          toggle() {}
        },
        addEventListener: (type, fn) => (nodes.get(selector).listeners[type] = fn)
      });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll: () => [], body: { classList: { add() {} } } },
    window: {
      sahne: {
        desktop: true,
        app: {
          autostart: async () => {
            if (behavior === 'disk') throw new Error('disk');
            return desktopResult;
          }
        }
      },
      addEventListener() {}
    },
    fetch: async (route, options) => {
      requests.push({ route, body: JSON.parse(options.body), method: options.method });
      if (behavior === 'network') throw new Error('offline');
      if (behavior === 'json')
        return {
          ok: true,
          json: async () => {
            throw new SyntaxError('bad JSON');
          }
        };
      if (behavior === 'http') return { ok: false, json: async () => ({ ok: true }) };
      return {
        ok: behavior === 'success',
        json: async () =>
          behavior === 'success'
            ? { ok: true, file: { id: '1234567890', name: 'Edited' } }
            : { ok: false, error: 'تنظیمات ذخیره نشد', code: 'settings_save_failed' }
      };
    },
    setTimeout: fn => {
      const id = ++timerId;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval() {},
    confirm: () => true,
    localStorage: { getItem: () => null },
    console,
    URLSearchParams,
    URL
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  // Skip only startup; all handler definitions and save functions are the shipped code.
  vm.runInContext(source.slice(0, source.indexOf('load().then(')), context);
  context.recordToast = (message, kind) => feedback.push({ message, kind });
  context.recordReload = () => reloads++;
  vm.runInContext(
    'toast = recordToast; load = recordReload; CFG = { appearance: { textSize: 30 }, files: [] };',
    context
  );
  return {
    nodes,
    node,
    context,
    feedback,
    requests,
    timers,
    setBehavior: value => (behavior = value),
    setDesktopResult: value => (desktopResult = value),
    reloads: () => reloads,
    flush: async () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) await fn();
    }
  };
}

test('manual settings/reset saves show errors and keep drafts for disk, HTTP, network and JSON failures', async () => {
  for (const behavior of ['disk', 'http', 'network', 'json', 'success']) {
    for (const selector of [
      '#btnSaveSettings',
      '#btnSaveKick',
      '#btnSaveRate',
      '#btnResetSettings',
      '#updCheck',
      '#recHistory'
    ]) {
      const ui = controller();
      ui.setBehavior(behavior);
      ui.node('#mode').value = 'companion';
      const control = ui.node(selector);
      if (control.onclick) await control.onclick();
      else await control.onchange({ target: control });
      await ui.flush();
      assert.equal(ui.feedback.length, 1, selector + '/' + behavior);
      assert.equal(ui.feedback[0].kind, behavior === 'success' ? 'ok' : 'err');
      assert.equal(ui.node('#mode').value, 'companion', 'failed save retains entered values');
      if (behavior !== 'success') {
        assert.match(ui.feedback[0].message, /ذخیره نشد/);
        assert.equal(ui.reloads(), 0, 'no reload that would discard drafts');
      }
    }
  }
});

test('appearance autosave and preset feedback wait for persistence and allow retry', async () => {
  const ui = controller();
  ui.context.onSaved = () => ui.feedback.push({ kind: 'ok' });
  vm.runInContext('CFG.appearance.textSize = 45; saveLook(onSaved);', ui.context);
  assert.equal(ui.feedback.length, 0, 'no premature preset success');
  await ui.flush();
  assert.equal(ui.feedback[0].kind, 'err');
  assert.equal(vm.runInContext('CFG.appearance.textSize', ui.context), 45, 'retain appearance draft');
  ui.feedback.length = 0;
  ui.setBehavior('success');
  vm.runInContext('saveLook(onSaved);', ui.context);
  await ui.flush();
  assert.deepEqual(ui.feedback, [{ kind: 'ok' }]);
  assert.equal(ui.requests.at(-1).body.appearance.textSize, 45);
});

test('desktop toggle reports IPC persistence failure and does not issue a duplicate HTTP save', async () => {
  const ui = controller();
  vm.runInContext('INFO = { autostart: false };', ui.context);
  const toggle = ui.node('#autostart');
  toggle.checked = true;
  await toggle.onchange({ target: toggle });
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  assert.equal(ui.feedback[0].kind, 'err');
  ui.setBehavior('success');
  ui.setDesktopResult(true);
  toggle.checked = true;
  await toggle.onchange({ target: toggle });
  assert.equal(toggle.checked, true);
  assert.equal(vm.runInContext('INFO.autostart', ui.context), true, 'later renders use the observed OS setting');
  assert.equal(ui.feedback.at(-1).kind, 'ok');
  assert.equal(ui.requests.length, 0);
});

test('desktop autostart saves the observed OS value and restores OS/config on failed persistence', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const code = source.slice(
    source.indexOf("ipcMain.handle('app:autostart'"),
    source.indexOf("ipcMain.handle('app:copy'")
  );
  let handler,
    osValue = false,
    fail = true,
    accepted = true,
    saves = 0;
  const server = {
    config: { app: { autostart: false } },
    saveConfig: () => {
      saves++;
      return !fail;
    }
  };
  vm.runInNewContext(code, {
    ipcMain: { handle: (name, fn) => (handler = fn) },
    fromMain: () => true,
    server,
    autostartGet: () => osValue,
    autostartSet: value => {
      if (accepted) osValue = value;
      return osValue;
    }
  });
  assert.throws(() => handler({}, true), /ذخیره نشد/);
  assert.equal(osValue, false);
  assert.equal(server.config.app.autostart, false);
  fail = false;
  assert.equal(handler({}, true), true);
  assert.equal(server.config.app.autostart, true);
  accepted = false;
  assert.equal(handler({}, false), true, 'save the actual OS result, not the requested value');
  assert.equal(server.config.app.autostart, true);
  const beforeQuery = saves;
  assert.equal(handler({}), true);
  assert.equal(saves, beforeQuery, 'reading autostart does not write');
});

test('media inspector clears old saved feedback, retains failed drafts and saves on retry', async () => {
  const ui = controller();
  vm.runInContext(
    "selectedId = '1234567890'; CFG.files = [{id: selectedId, name: 'Original'}]; renderFiles = () => {};",
    ui.context
  );
  const name = ui.node('#iName'),
    saved = ui.node('#insSaved');
  name.value = 'Edited';
  saved.classList.add('show');
  name.listeners.input();
  assert.equal(saved.classes.has('show'), false, 'previous saved marker clears on edit');
  await ui.flush();
  assert.equal(saved.classes.has('show'), false, 'failed save never shows saved');
  assert.equal(name.value, 'Edited');
  assert.equal(vm.runInContext('CFG.files[0].name', ui.context), 'Original');
  assert.equal(ui.feedback.at(-1).kind, 'err');
  ui.setBehavior('success');
  name.listeners.input();
  await ui.flush();
  assert.equal(saved.classes.has('show'), true);
  assert.equal(vm.runInContext('CFG.files[0].name', ui.context), 'Edited');
});
