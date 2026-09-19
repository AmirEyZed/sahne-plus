// Update check helpers: version parsing, the GitHub redirect, asset URLs and checksum lookup (run with `node --test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../electron/update-core');

test('versions: only plain x.y.z, compared numerically', () => {
  assert.deepEqual(core.parseVersion('v1.3.10'), [1, 3, 10]);
  assert.equal(core.parseVersion('1.4.0-beta.1'), null);
  assert.equal(core.parseVersion('latest'), null);
  assert.ok(core.isNewer('1.3.10', '1.3.9'), '10 > 9, not a string compare');
  assert.ok(core.isNewer('2.0.0', '1.99.99'));
  assert.ok(!core.isNewer('1.3.1', '1.3.1'));
  assert.ok(!core.isNewer('1.3.0', '1.3.1'), 'never offers a downgrade');
  assert.ok(!core.isNewer('junk', '1.0.0'));
});

test('the release redirect is accepted only for this repository', () => {
  assert.equal(core.versionFromReleaseUrl('https://github.com/AmirEyZed/sahne-plus/releases/tag/v1.3.1'), '1.3.1');
  assert.equal(core.versionFromReleaseUrl('https://github.com/AmirEyZed/sahne-plus/releases'), null, 'no releases yet');
  assert.equal(core.versionFromReleaseUrl('https://github.com/someone/sahne-plus/releases/tag/v9.9.9'), null);
  assert.equal(core.versionFromReleaseUrl('https://evil.example/AmirEyZed/sahne-plus/releases/tag/v9.9.9'), null);
  assert.equal(core.versionFromReleaseUrl('https://github.com/AmirEyZed/sahne-plus/releases/tag/v2.0.0-rc1'), null);
});

test('asset URLs point at this repository and the checksum file is parsed strictly', () => {
  assert.equal(
    core.assetUrl('1.3.1', core.installerName('1.3.1')),
    'https://github.com/AmirEyZed/sahne-plus/releases/download/v1.3.1/Sahne-Plus-Setup-1.3.1.exe'
  );
  const h = 'a'.repeat(64);
  assert.equal(core.checksumFor(h + ' *Sahne-Plus-Setup-1.3.1.exe\n', 'Sahne-Plus-Setup-1.3.1.exe'), h);
  assert.equal(core.checksumFor(h.toUpperCase() + '  Sahne-Plus-Setup-1.3.1.exe\r\n', 'Sahne-Plus-Setup-1.3.1.exe'), h);
  assert.equal(core.checksumFor(h + ' *Sahne-Plus-Setup-1.3.0.exe\n', 'Sahne-Plus-Setup-1.3.1.exe'), null);
  assert.equal(core.checksumFor('abc *Sahne-Plus-Setup-1.3.1.exe', 'Sahne-Plus-Setup-1.3.1.exe'), null);
});
