// Sahne Plus — pure helpers for the update check and download (no Electron imports, unit-tested with `node --test`).
// Only this repository's GitHub Releases are ever considered; only plain x.y.z tags are accepted.
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const REPO = 'AmirEyZed/sahne-plus';
const RELEASES = 'https://github.com/' + REPO + '/releases';
const LATEST_URL = RELEASES + '/latest';
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;
const RESPONSE_TIMEOUT_MS = 30 * 1000; // a release asset's response (or the whole checksum file) must arrive in this time
const STALL_TIMEOUT_MS = 60 * 1000; // the installer download fails when no data arrives (or none is written) for this long

// "1.3.2" or "v1.3.2" -> [1, 3, 2]; anything else (pre-releases, junk) -> null
function parseVersion(v) {
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate),
    b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Final URL of https://github.com/<repo>/releases/latest (GitHub redirects to the newest release) -> "1.3.2", else null
function versionFromReleaseUrl(u) {
  const m = /^https:\/\/github\.com\/amireyzed\/sahne-plus\/releases\/tag\/v(\d{1,4}\.\d{1,4}\.\d{1,4})\/?$/i.exec(
    String(u || '')
  );
  return m ? m[1] : null;
}

const installerName = version => 'Sahne-Plus-Setup-' + version + '.exe';
const assetUrl = (version, file) => RELEASES + '/download/v' + version + '/' + encodeURIComponent(file);
const releasePage = version => RELEASES + '/tag/v' + version;

// SHA256SUMS.txt ("<hex> *<file>" or "<hex>  <file>" per line, LF or CRLF) -> lowercase hex for `file`, else null
function checksumFor(text, file) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line.trim());
    if (m && m[2].trim() === file) return m[1].toLowerCase();
  }
  return null;
}

// Settles like `promise`, or rejects with "<what> timed out" after `ms` and then runs onTimeout (to abort the
// request). The timeout error is settled first because Electron's net.fetch rejects synchronously inside abort().
// It does not rely on the request honouring an AbortSignal: the caller is released either way.
function withTimeout(promise, ms, what, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(what + ' timed out'));
      try {
        if (onTimeout) onTimeout();
      } catch {}
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Streams a fetch Response body (a web ReadableStream) to `dest` and resolves with its SHA-256 (lowercase hex).
// It fails when a read, a write or the final close makes no progress for `stallMs` (a slow download that keeps
// moving is never cut off), when more than `maxBytes` arrive, or at once when the file cannot be written (disk full,
// a file locked by an antivirus). Before it rejects, the request body is cancelled and closing and deleting the
// partial file are attempted. In Electron, cancelling the body does not close the connection: the caller must also
// abort the request (download() does). onData(bytesSoFar) reports progress. `open` exists for tests.
async function saveStream(
  body,
  dest,
  { maxBytes = MAX_INSTALLER_BYTES, stallMs = STALL_TIMEOUT_MS, onData, open = fs.createWriteStream } = {}
) {
  const hash = crypto.createHash('sha256');
  const reader = body.getReader();
  const out = open(dest);
  // a write error can come at any time (also between chunks, with no write pending): one listener for the whole
  // download keeps it from becoming an uncaught 'error' event in the main process and fails the wait in progress
  // (for example a 'drain' that will never come). Only one wait exists at a time and nothing is left attached to it
  // after it settles, so a long download does not collect handlers chunk after chunk.
  let failure = null,
    failWait = null;
  out.on('error', e => {
    if (!failure) failure = e;
    if (failWait) failWait(e);
  });
  const closed = new Promise(res => out.once('close', res));
  const step = (p, what) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      let done = false;
      const fail = e => settle(reject, e);
      const settle = (fn, v) => {
        if (done) return;
        done = true;
        if (failWait === fail) failWait = null;
        clearTimeout(timer);
        fn(v);
      };
      const timer = setTimeout(() => settle(reject, new Error(what + ' timed out')), stallMs);
      failWait = fail;
      p.then(
        v => settle(resolve, v),
        e => settle(reject, e)
      );
    });
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await step(reader.read(), 'download: waiting for data');
      if (done) break;
      got += value.length;
      if (got > maxBytes) throw new Error('installer too large');
      hash.update(value);
      if (!out.write(value)) await step(new Promise(res => out.once('drain', res)), 'download: writing to disk');
      if (onData) onData(got);
    }
    out.end();
    await step(closed, 'download: closing the file');
  } catch (e) {
    reader.cancel(e).catch(() => {});
    out.destroy();
    await withTimeout(closed, 5000, 'closing the partial file').catch(() => {});
    try {
      fs.rmSync(dest, { force: true });
    } catch {}
    throw e;
  }
  return hash.digest('hex');
}

// A failure on the local disk (not the network): the user should free space or check the antivirus, not the VPN
const DISK_ERROR_CODES = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EBUSY', 'EROFS', 'EIO', 'EMFILE', 'ENFILE']);
const isDiskError = e =>
  !!e && (DISK_ERROR_CODES.has(e.code) || /^download: (writing to disk|closing the file) timed out$/.test(e.message));

module.exports = {
  REPO,
  LATEST_URL,
  MAX_INSTALLER_BYTES,
  MAX_SUMS_BYTES,
  RESPONSE_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  withTimeout,
  saveStream,
  isDiskError,
  parseVersion,
  isNewer,
  versionFromReleaseUrl,
  installerName,
  assetUrl,
  releasePage,
  checksumFor
};
