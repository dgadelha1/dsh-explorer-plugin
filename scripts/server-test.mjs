// Integration-style test of the server half (lib/index.js) with a mocked
// Cordis ctx: sandbox allowlist, path confinement, write/read roundtrip,
// size caps, and the fs.watch error handler (no process crash).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

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
const registrations = [];
const capturingCtx = {
  get: ctx.get.bind(ctx),
  connection: { rpc: { handle: (_ch, h) => { rpcHandler = h; return () => {}; } } },
  webServer: { register: (route) => { registrations.push(route); if (route.path === '/explorer/events') eventsHandler = route.handler; return () => {}; } },
};
const dispose = mod.apply(capturingCtx);
check('plugin registers rpc + 2 web routes', rpcHandler !== null && eventsHandler !== null && registrations.length === 2);

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
const { symlinkSync } = require('node:fs');
try {
  symlinkSync(outside, join(allowed, 'link-out'));
  r = await call('fs/read', { root: allowed, path: 'link-out' });
  check('symlink escape rejected', r.ok === false && r.error.code === 'bad-request', JSON.stringify(r));
} catch (e) {
  check('symlink escape rejected', false, 'symlink setup failed: ' + e.message);
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

// ── watcher error: deleting the watched dir must NOT crash the process ──
// The client always subscribes with the exact workspace root (never a
// subdirectory), and the allowlist is exact-match, so watch `allowed` itself.
const watchDir = allowed;
const sseReq = { url: '/explorer/events?root=' + encodeURIComponent(watchDir), on: () => {} };
const sseRes = {
  head: null, body: '',
  writeHead(code, h) { this.head = { code, h }; },
  write(chunk) { this.body += chunk; },
  end() {},
};
await eventsHandler(sseReq, sseRes, ctx);
check('SSE handler accepts allowed root', sseRes.head !== null && sseRes.head.code === 200, JSON.stringify(sseRes.head));
rmSync(watchDir, { recursive: true, force: true });
// give inotify a moment to deliver the error
await new Promise((resolve) => setTimeout(resolve, 700));
// If the 'error' handler were missing, the process would have crashed already.
check('watcher error did not crash the process', true);

dispose();
rmSync(wsRoot, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
