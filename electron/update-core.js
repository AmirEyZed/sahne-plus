// Sahne Plus — pure helpers for the update check (no Electron imports, unit-tested with `node --test`).
// Only this repository's GitHub Releases are ever considered; only plain x.y.z tags are accepted.
'use strict';

const REPO = 'AmirEyZed/sahne-plus';
const RELEASES = 'https://github.com/' + REPO + '/releases';
const LATEST_URL = RELEASES + '/latest';
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;

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

module.exports = {
  REPO,
  LATEST_URL,
  MAX_INSTALLER_BYTES,
  MAX_SUMS_BYTES,
  parseVersion,
  isNewer,
  versionFromReleaseUrl,
  installerName,
  assetUrl,
  releasePage,
  checksumFor
};
