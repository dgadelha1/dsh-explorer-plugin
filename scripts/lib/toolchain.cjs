// Shared toolchain lookups for the manual verification scripts
// (smoke-client, render-check, syntax-test-driver).
//
// Two portability problems this solves:
//
//   1. Module resolution. These scripts used to require packages straight out
//      of `.pnpm-home/node_modules` — a gitignored directory that exists only
//      on the machine that vendored the offline pnpm toolchain. Nothing in the
//      checkout created it, so a fresh clone could not run the scripts at all
//      (`MODULE_NOT_FOUND: .pnpm-home/node_modules/react`). The packages are
//      now real devDependencies installed into the normal `node_modules`, and
//      the vendored copy is kept only as a fallback so this checkout keeps
//      working offline.
//
//   2. Browser discovery. The Firefox binary was pinned to `/usr/bin/firefox`,
//      which is wrong for snap (`/snap/bin/firefox` — the Ubuntu default),
//      firefox-esr, flatpak, a local tarball, and macOS.
const fs = require('fs');
const path = require('path');

/** Repository root (this file lives in scripts/lib/). */
const WORKSPACE = path.resolve(__dirname, '..', '..');

/**
 * Require a package for the checkout, preferring a normal `node_modules`
 * resolution and falling back to the vendored `.pnpm-home` copy.
 */
function loadModule(name) {
  const vendored = path.join(WORKSPACE, '.pnpm-home', 'node_modules', name);
  try {
    return require(require.resolve(name, { paths: [WORKSPACE] }));
  } catch (error) {
    if (fs.existsSync(vendored)) return require(vendored);
    throw new Error(
      `Cannot find package "${name}". Run "pnpm install" in ${WORKSPACE} first.\n` +
        `  Looked in: ${path.join(WORKSPACE, 'node_modules')}\n` +
        `         and: ${vendored}\n` +
        `  Original error: ${error.message}`,
    );
  }
}

/** Well-known Firefox locations, most common first. */
const FIREFOX_CANDIDATES = [
  '/usr/bin/firefox',
  '/usr/bin/firefox-esr',
  '/usr/local/bin/firefox',
  '/snap/bin/firefox',
  '/var/lib/flatpak/exports/bin/org.mozilla.firefox',
  '/opt/firefox/firefox',
  '/usr/lib/firefox/firefox',
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
];

/**
 * Locate a Firefox executable: an explicit FIREFOX_PATH wins, then a PATH
 * lookup, then the well-known locations above.
 */
function resolveFirefox() {
  const override = process.env.FIREFOX_PATH;
  if (override !== undefined && override !== '') {
    if (fs.existsSync(override)) return override;
    throw new Error(`FIREFOX_PATH is set to "${override}" but no such file exists.`);
  }
  const names = process.platform === 'win32' ? ['firefox.exe'] : ['firefox', 'firefox-esr'];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }
  for (const candidate of FIREFOX_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Could not find a Firefox binary. Point FIREFOX_PATH at the executable, e.g.\n' +
      '  FIREFOX_PATH=/snap/bin/firefox node scripts/render-check.cjs\n' +
      `  Tried every PATH entry plus: ${FIREFOX_CANDIDATES.join(', ')}`,
  );
}

module.exports = { WORKSPACE, loadModule, resolveFirefox, FIREFOX_CANDIDATES };
