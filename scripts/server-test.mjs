// Integration-style test of the server half (lib/index.js) with a mocked
// Cordis ctx: sandbox allowlist, path confinement, write/read roundtrip,
// size caps, and the fs.watch error handler (no process crash).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const mod = await import('../lib/index.js');

const wsRoot = mkdtempSync(join(tmpdir(), 'dsh-explorer-test-'));
const allowed = join(wsRoot, 'workspace');
const other = join(wsRoot, 'other');
mkdirSync(allowed);
mkdirSync(other);
writeFileSync(join(allowed, 'hello.txt'), 'hello world\n');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('ok   ' + name);
  else { failures++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// Symlinks and FIFOs need capabilities a plain Windows account lacks (`EPERM` on
// symlink, no `mkfifo`). Those checks are reported as skips there instead of
// failing the run, so the suite stays meaningful on both platforms; every
// assertion that does run still counts as a failure when it fails.
let skips = 0;
function skip(names, why) {
  for (const name of Array.isArray(names) ? names : [names]) {
    skips++;
    console.log('skip ' + name + ' :: ' + why);
  }
}

/**
 * Create one symlink; false (plus the recorded reason) when unsupported here.
 * Windows denies `symlinkSync` to unprivileged accounts (EPERM), so fall back
 * to a directory junction, which is a real reparse-point symlink for the
 * purpose of the confinement checks and needs no special capability. File
 * targets have no junction equivalent, so those cases still skip there.
 */
let symlinkUnavailable = '';
let symlinkKind = 'symlink';
function makeSymlink(target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch (error) {
    if (process.platform === 'win32') {
      try {
        execFileSync('cmd', ['/c', 'mklink', '/J', path, target], { stdio: 'ignore' });
        symlinkKind = 'junction';
        return true;
      } catch {
        /* fall through to the recorded skip reason */
      }
    }
    symlinkUnavailable ||= 'symlinks unavailable: ' + error.message;
    return false;
  }
}

// ── mock ctx ──
const sessionsList = [{ header: { cwd: allowed } }];
const registryList = [{ path: allowed }];
const ctx = {
  get(name) {
    if (name === 'sessions') return { list: () => sessionsList };
    if (name === 'workspaceRegistry') return { list: () => registryList };
    return undefined;
  },
  connection: { rpc: { handle: () => () => {} } },
  webServer: { register: () => () => {} },
};

let rpcHandler = null;
let eventsHandler = null;
let staticHandler = null;
const registrations = [];
const capturingCtx = {
  get: ctx.get.bind(ctx),
  connection: { rpc: { handle: (_ch, h) => { rpcHandler = h; return () => {}; } } },
  webServer: {
    register: (route) => {
      registrations.push(route);
      if (route.path === '/explorer/events') eventsHandler = route.handler;
      if (route.path === '/explorer-assets') staticHandler = route.handler;
      return () => {};
    },
  },
};
const dispose = mod.apply(capturingCtx);
check(
  'plugin registers rpc + 2 web routes',
  rpcHandler !== null && eventsHandler !== null && staticHandler !== null && registrations.length === 2,
);

// ── RPC channel registration: documented call first, channel-registry fallback ──
// Current dsh resolves `webServer` from the connection plugin's own fiber, so
// `rpc.handle` throws at boot for a sibling plugin row; the plugin must then
// register on the service's channel registry with its own ctx as owner.
const injectError = new Error('cannot get property "webServer" without inject');
let fallbackHandler = null;
let fallbackOwner = null;
let fallbackChannel = null;
const fallbackRegistrations = [];
const fallbackCtx = {
  get: ctx.get.bind(ctx),
  connection: {
    rpc: { handle: () => { throw injectError; } },
    register(owner, channel, handler) {
      fallbackOwner = owner;
      fallbackChannel = channel;
      fallbackHandler = handler;
      return () => {};
    },
  },
  webServer: { register: (route) => { fallbackRegistrations.push(route); return () => {}; } },
};
const disposeFallback = mod.apply(fallbackCtx);
check('rpc.handle "without inject" falls back to the channel registry',
  fallbackHandler !== null && fallbackOwner === fallbackCtx && fallbackChannel === '/explorer' && fallbackRegistrations.length === 2);
const viaFallback = fallbackHandler === null ? { ok: false, error: { code: 'no-handler' } } : await fallbackHandler('fs/list', { root: allowed, path: '.', includeHidden: true });
check('fallback channel dispatches endpoints', viaFallback.ok === true && viaFallback.value.entries.some((e) => e.name === 'hello.txt'), JSON.stringify(viaFallback));

// An unrelated registration failure must not be swallowed.
const unrelated = new Error('client-connection: channel already registered');
let rethrown = null;
try {
  mod.apply({
    get: ctx.get.bind(ctx),
    connection: { rpc: { handle: () => { throw unrelated; } }, register: () => () => {} },
    webServer: { register: () => () => {} },
  });
} catch (error) {
  rethrown = error;
}
check('unrelated rpc.handle failures are rethrown', rethrown === unrelated, String(rethrown && rethrown.message));

// Without the registry method the documented failure is rethrown as-is.
let propagated = null;
try {
  mod.apply({
    get: ctx.get.bind(ctx),
    connection: { rpc: { handle: () => { throw injectError; } } },
    webServer: { register: () => () => {} },
  });
} catch (error) {
  propagated = error;
}
check('missing registry method rethrows the inject failure', propagated === injectError, String(propagated && propagated.message));

const call = async (endpoint, payload) => {
  const r = await rpcHandler(endpoint, payload);
  return r;
};

// ── allowlist: allowed root works ──
let r = await call('fs/list', { root: allowed, path: '.', includeHidden: true });
check('fs/list on allowed root', r.ok === true && r.value.entries.some((e) => e.name === 'hello.txt'), JSON.stringify(r));

// ── allowlist: arbitrary root rejected ──
r = await call('fs/list', { root: '/etc', path: '.', includeHidden: false });
check('fs/list on /etc rejected (sandbox)', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));

r = await call('fs/stat', { root: '/', path: 'etc/passwd' });
check('fs/stat on /etc/passwd rejected (sandbox)', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));

r = await call('fs/write', { root: '/home', path: 'x.txt', content: 'pwn' });
check('fs/write under /home rejected (sandbox)', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));

// ── traversal ──
r = await call('fs/read', { root: allowed, path: '../other/secret.txt' });
check('path traversal ../ rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
r = await call('fs/read', { root: allowed, path: '..%2Fother%2Fsecret.txt' });
check('encoded traversal rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));

// ── symlink escape ──
const outside = join(wsRoot, 'outside.txt');
writeFileSync(outside, 'top secret');
if (makeSymlink(outside, join(allowed, 'link-out'))) {
  r = await call('fs/read', { root: allowed, path: 'link-out' });
  check('symlink escape rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
} else {
  skip('symlink escape rejected', symlinkUnavailable);
}

// ── write/read roundtrip (atomic) ──
r = await call('fs/write', { root: allowed, path: 'sub/deep/file.txt', content: 'nova' });
check('fs/write creates parent dirs + file', r.ok === true && existsSync(join(allowed, 'sub/deep/file.txt')), JSON.stringify(r));
r = await call('fs/read', { root: allowed, path: 'sub/deep/file.txt' });
check('fs/read roundtrip', r.ok === true && r.value.content === 'nova', JSON.stringify(r));

// ── size caps ──
r = await call('fs/read', { root: allowed, path: 'hello.txt' });
check('fs/read small file inline', r.ok === true && typeof r.value.content === 'string' && r.value.content.includes('hello'), JSON.stringify(r));

const big = join(allowed, 'big.bin');
const fh = await (await import('node:fs/promises')).open(big, 'w');
await fh.truncate(3 * 1024 * 1024); // 3 MB > 2 MB inline cap
await fh.close();
r = await call('fs/read', { root: allowed, path: 'big.bin' });
check('fs/read >2MB -> tooLarge', r.ok === true && r.value.tooLarge === true, JSON.stringify(r));

const huge = join(allowed, 'huge.bin');
const fh2 = await (await import('node:fs/promises')).open(huge, 'w');
await fh2.truncate(60 * 1024 * 1024); // 60 MB > 50 MB readLarge cap
await fh2.close();
r = await call('fs/readLarge', { root: allowed, path: 'huge.bin' });
check('fs/readLarge >50MB -> tooLarge (OOM guard)', r.ok === true && r.value.tooLarge === true, JSON.stringify(r));

// ── write size cap ──
r = await call('fs/write', { root: allowed, path: 'huge-write.txt', content: 'x'.repeat(60 * 1024 * 1024) });
check('fs/write >50MB rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));

// ── binary detection ──
writeFileSync(join(allowed, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
r = await call('fs/read', { root: allowed, path: 'bin.dat' });
check('binary sniff', r.ok === true && r.value.binary === true, JSON.stringify(r));

// ── invalid create kind / rename name ──
r = await call('fs/create', { root: allowed, path: 'x', kind: 'symlink' });
check('fs/create invalid kind rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
r = await call('fs/rename', { root: allowed, path: 'hello.txt', newName: 'a\u0000b' });
check('fs/rename NUL rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));

// ── root itself cannot be renamed/moved/deleted ──
r = await call('fs/rename', { root: allowed, path: '.', newName: 'moved' });
check('fs/rename of the root rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
r = await call('fs/move', { root: allowed, path: '.', targetDir: 'sub' });
check('fs/move of the root rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
r = await call('fs/delete', { root: allowed, path: '.' });
check('fs/delete of the root rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));

// ── symlink workspace root: normal ops work, root guards still hold ──
const linkRoot = join(wsRoot, 'linkroot');
if (makeSymlink(allowed, linkRoot)) {
  r = await call('fs/list', { root: linkRoot, path: '.', includeHidden: true });
  check('fs/list works through a symlink root', r.ok === true && r.value.entries.some((e) => e.name === 'hello.txt'), JSON.stringify(r));
  r = await call('fs/read', { root: linkRoot, path: 'hello.txt' });
  check('fs/read works through a symlink root', r.ok === true && r.value.content.includes('hello'), JSON.stringify(r));
  r = await call('fs/delete', { root: linkRoot, path: '.' });
  check('fs/delete of symlink root rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
  r = await call('fs/rename', { root: linkRoot, path: '.', newName: 'x' });
  check('fs/rename of symlink root rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
} else {
  skip([
    'fs/list works through a symlink root',
    'fs/read works through a symlink root',
    'fs/delete of symlink root rejected',
    'fs/rename of symlink root rejected',
  ], symlinkUnavailable);
}

// ── write through a symlinked directory is confined ──
const outsideDir = join(wsRoot, 'outside-dir');
mkdirSync(outsideDir);
if (makeSymlink(outsideDir, join(allowed, 'sub-link'))) {
  r = await call('fs/write', { root: allowed, path: 'sub-link/new.txt', content: 'x' });
  check('fs/write through out-of-root symlink dir rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
  r = await call('fs/create', { root: allowed, path: 'sub-link/new2.txt', kind: 'file' });
  check('fs/create through out-of-root symlink dir rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
} else {
  skip([
    'fs/write through out-of-root symlink dir rejected',
    'fs/create through out-of-root symlink dir rejected',
  ], symlinkUnavailable);
}

// ── out-of-root symlinks are hidden from listings (no metadata leak) ──
if (makeSymlink(outside, join(allowed, 'leaky-link'))) {
  r = await call('fs/list', { root: allowed, path: '.', includeHidden: true });
  check('out-of-root symlink hidden from fs/list', r.ok === true && !r.value.entries.some((e) => e.name === 'leaky-link'), JSON.stringify(r));
} else {
  skip('out-of-root symlink hidden from fs/list', symlinkUnavailable);
}

// ── FIFO/special files never reach readFile (would hang the handler) ──
const { execSync } = require('node:child_process');
const fifo = join(allowed, 'pipe.fifo');
let fifoReady = false;
try {
  execSync(`mkfifo "${fifo}"`);
  fifoReady = existsSync(fifo);
} catch {
  fifoReady = false; // Windows and minimal images ship no mkfifo
}
if (fifoReady) {
  r = await call('fs/read', { root: allowed, path: 'pipe.fifo' });
  check('fs/read of a FIFO rejected (no hang)', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
  r = await call('fs/readLarge', { root: allowed, path: 'pipe.fifo' });
  check('fs/readLarge of a FIFO rejected (no hang)', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
} else {
  skip([
    'fs/read of a FIFO rejected (no hang)',
    'fs/readLarge of a FIFO rejected (no hang)',
  ], 'mkfifo unavailable on this platform');
}

// ── prototype-chain endpoint names are cleanly rejected ──
for (const bad of ['__proto__', 'constructor', 'hasOwnProperty']) {
  r = await call(bad, { root: allowed, path: '.' });
  check(`endpoint ${bad} -> bad-request`, r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
}

// ── HTTP trust fence (DNS rebinding / cross-site) on both routes ──
// Both the asset route and the SSE route gate on isTrustedRequest. Until now
// the only exercise of that gate was a mock that omitted `headers` entirely,
// so the handler threw a TypeError instead of answering. A missing headers bag
// must fail closed with 403, and every non-loopback or cross-site request must
// be refused before the handler touches the filesystem.

function makeReq(url, headers) {
  const req = {
    url,
    handlers: {},
    on(event, fn) { (this.handlers[event] ??= []).push(fn); },
    emit(event) { for (const fn of this.handlers[event] ?? []) fn(); },
  };
  if (headers !== undefined) req.headers = headers;
  return req;
}

function makeRes() {
  return {
    head: null,
    body: '',
    writeHead(code, h) { this.head = { code, h }; },
    write(chunk) { this.body += chunk ?? ''; },
    end(chunk) { this.body += chunk ?? ''; },
  };
}

/** Run an HTTP handler and report the status it wrote. */
async function statusFor(handler, url, headers) {
  const req = makeReq(url, headers);
  const res = makeRes();
  await handler(req, res);
  return { code: res.head?.code ?? null, req, res };
}

const LOOPBACK_HOST = '127.0.0.1:3080';
const SSE_URL = '/explorer/events?root=' + encodeURIComponent(allowed);
// [label, headers, trusted] — `undefined` headers means no headers bag at all.
const TRUST_CASES = [
  ['loopback Host', { host: LOOPBACK_HOST }, true],
  ['localhost Host', { host: 'localhost:3080' }, true],
  ['IPv6 loopback Host', { host: '[::1]:3080' }, true],
  ['same-origin Origin', { host: LOOPBACK_HOST, origin: 'http://' + LOOPBACK_HOST }, true],
  ['LAN Host', { host: '192.168.1.10:3080' }, false],
  ['DNS-rebinding Host', { host: 'evil.com' }, false],
  ['cross-site Sec-Fetch-Site', { host: LOOPBACK_HOST, 'sec-fetch-site': 'cross-site' }, false],
  ['foreign Origin', { host: LOOPBACK_HOST, origin: 'http://evil.com' }, false],
  ['Origin port mismatch', { host: LOOPBACK_HOST, origin: 'http://127.0.0.1:9999' }, false],
  ['malformed Host', { host: 'not a host' }, false],
  ['missing headers bag', undefined, false],
];

for (const [label, headers, trusted] of TRUST_CASES) {
  for (const [route, handler, url, accepted] of [
    ['SSE', eventsHandler, SSE_URL, 200],
    ['asset', staticHandler, '/explorer-assets', 302],
  ]) {
    const want = trusted ? accepted : 403;
    let out = null;
    let threw = null;
    try {
      out = await statusFor(handler, url, headers);
    } catch (error) {
      threw = error;
    }
    check(
      `${route} trust: ${label} -> ${want}`,
      threw === null && out.code === want,
      threw !== null ? `threw ${threw.message}` : `got ${out.code}`,
    );
    // A trusted SSE request opens a live client + heartbeat; close it so the
    // deletion test below is not racing leaked watchers.
    if (threw === null) out.req.emit('close');
  }
}

// ── asset route: real file served, traversal refused ──
r = await statusFor(staticHandler, '/explorer-assets/monaco/vs/loader.js', { host: LOOPBACK_HOST });
check('asset route serves a vendored file', r.code === 200, `got ${r.code}`);
r = await statusFor(staticHandler, '/explorer-assets/%2e%2e/%2e%2e/etc/passwd', { host: LOOPBACK_HOST });
check('asset route encoded traversal -> 403', r.code === 403, `got ${r.code}`);


// ── fs/list hidden default ──
// Hidden entries are opt-in: omitting includeHidden must behave exactly like
// false, and an explicit true must surface dotfiles.
mkdirSync(join(allowed, 'visible-dir'));
writeFileSync(join(allowed, '.secret'), 's');
r = await call('fs/list', { root: allowed, path: '.' });
check('fs/list omitting includeHidden hides dotfiles',
  r.ok === true && !r.value.entries.some((e) => e.name === '.secret') && r.value.entries.some((e) => e.name === 'visible-dir'),
  JSON.stringify(r));
r = await call('fs/list', { root: allowed, path: '.', includeHidden: false });
check('fs/list includeHidden:false hides dotfiles', r.ok === true && !r.value.entries.some((e) => e.name === '.secret'), JSON.stringify(r));
r = await call('fs/list', { root: allowed, path: '.', includeHidden: true });
check('fs/list includeHidden:true shows dotfiles', r.ok === true && r.value.entries.some((e) => e.name === '.secret'), JSON.stringify(r));

// ── error codes survive the write/rename/move catch wrappers ──
// A confinement rejection inside those handlers must stay `bad-request`; a
// blanket `internal` re-wrap would present a sandbox escape attempt as an
// ordinary I/O failure.
const xssDir = join(wsRoot, 'xss');
mkdirSync(xssDir);
if (makeSymlink(xssDir, join(allowed, 'xss-link'))) {
  r = await call('fs/write', { root: allowed, path: 'xss-link/planted.txt', content: 'pwn' });
  check('fs/write escape keeps bad-request (not internal)', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
  r = await call('fs/rename', { root: allowed, path: 'xss-link/planted.txt', newName: 'renamed' });
  check('fs/rename escape keeps bad-request (not internal)', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
  r = await call('fs/move', { root: allowed, path: 'xss-link/planted.txt', targetDir: '.' });
  check('fs/move escape keeps bad-request (not internal)', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
  r = await call('fs/create', { root: allowed, path: 'xss-link/created.txt', kind: 'file' });
  check('fs/create escape keeps bad-request (not internal)', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
} else {
  skip([
    'fs/write escape keeps bad-request (not internal)',
    'fs/rename escape keeps bad-request (not internal)',
    'fs/move escape keeps bad-request (not internal)',
    'fs/create escape keeps bad-request (not internal)',
  ], symlinkUnavailable);
}

// ── static asset route: MIME by basename, traversal refused ──
const assetsRoute = registrations.find((route) => route.path === '/explorer-assets');
check('assets route registered as prefix', assetsRoute !== undefined && assetsRoute.kind === 'prefix');
if (assetsRoute) {
  const assetReq = (url) => ({ url, headers: { host: '127.0.0.1:3080' } });
  const assetRes = () => ({
    head: null, body: null,
    writeHead(code, h) { this.head = { code, h }; },
    end(payload) { this.body = payload; },
  });
  let ares = assetRes();
  await assetsRoute.handler(assetReq('/explorer-assets/monaco/vs/loader.js'), ares);
  check('asset .js served with JS MIME and nosniff',
    ares.head && ares.head.code === 200 && ares.head.h['Content-Type'].startsWith('text/javascript') && ares.head.h['X-Content-Type-Options'] === 'nosniff',
    JSON.stringify(ares.head));

  // Extensionless / missing asset: the old `slice(lastIndexOf('.'))` returned
  // the last CHARACTER of the path, so this must resolve through the
  // octet-stream arm rather than a bogus MIME lookup key.
  ares = assetRes();
  await assetsRoute.handler(assetReq('/explorer-assets/no-extension-asset'), ares);
  check('missing asset -> 404', ares.head !== null && ares.head.code === 404, JSON.stringify(ares.head));

  ares = assetRes();
  await assetsRoute.handler(assetReq('/explorer-assets/..%2f..%2fpackage.json'), ares);
  check('asset traversal refused', ares.head !== null && ares.head.code === 403, JSON.stringify(ares.head));

  ares = assetRes();
  await assetsRoute.handler({ url: '/explorer-assets/monaco/vs/loader.js', headers: { host: 'evil.example.com' } }, ares);
  check('asset route refuses non-loopback Host', ares.head !== null && ares.head.code === 403, JSON.stringify(ares.head));
}

// ── watcher error: deleting the watched dir must NOT crash the process ──
// The client always subscribes with the exact workspace root (never a
// subdirectory), and the allowlist is exact-match, so watch `allowed` itself.
const watchDir = allowed;
const sseReq = makeReq('/explorer/events?root=' + encodeURIComponent(watchDir), { host: LOOPBACK_HOST });
const sseRes = makeRes();
await eventsHandler(sseReq, sseRes, ctx);
check('SSE handler accepts allowed root', sseRes.head !== null && sseRes.head.code === 200, JSON.stringify(sseRes.head));
rmSync(watchDir, { recursive: true, force: true });
// give inotify a moment to deliver the error
await new Promise((resolve) => setTimeout(resolve, 700));
// If the 'error' handler were missing, the process would have crashed already.
check('watcher error did not crash the process', true);

dispose();
disposeFallback();
rmSync(wsRoot, { recursive: true, force: true });

console.log(failures === 0
  ? `\nALL TESTS PASSED${skips > 0 ? ` (${skips} skipped: symlinks/mkfifo unavailable here)` : ''}`
  : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
