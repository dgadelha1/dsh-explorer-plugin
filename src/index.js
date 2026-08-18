/**
 * dsh-explorer-plugin — server half.
 *
 * A Cordis plugin that powers the File Explorer UI:
 *   - RPC channel `/rpc/explorer` (fs/* endpoints), registered on the
 *     `connection` service with loopback trust (the GUI is served on
 *     loopback, matching every other browser RPC channel). The platform's
 *     connection service additionally enforces same-origin (Origin /
 *     sec-fetch-site) so cross-site requests are rejected before reaching us.
 *   - Static assets under `/explorer-assets` (monaco, oniguruma wasm,
 *     TextMate grammars, VS Code themes) served from this package's vendor/.
 *   - SSE at `/explorer/events?root=...` broadcasting fs.watch events so the
 *     tree refreshes in real time (including when the agent writes files).
 *
 * Security model:
 *   - Every filesystem operation is confined to the workspace root supplied
 *     by the client (the session's cwd), honoring the session sandbox.
 *   - The client-supplied root is NOT trusted blindly: it must resolve to a
 *     directory that is the canonical cwd of a live session or a registered
 *     workspace path (see assertAllowedRoot). This closes the "read any local
 *     directory through the loopback API" hole and matches the SPEC claim of
 *     honoring the session sandbox.
 *   - Path traversal and symlink escapes are blocked by confine/confineReal
 *     (realpath of the deepest existing ancestor + re-confinement).
 */
import { readdir, stat, realpath, readFile, writeFile, rename, rm, mkdir, open } from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { dirname, basename, join, relative, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Cordis plugin name. */
export const name = 'explorer';
/** Services required before this plugin can mount. */
export const inject = ['webServer', 'connection'];

/** Cap above which fs/read refuses to inline content (client opens read-only). */
const MAX_INLINE_BYTES = 2 * 1024 * 1024;
/** Cap above which fs/readLarge refuses to read at all (OOM guard). */
const MAX_READLARGE_BYTES = 50 * 1024 * 1024;
/** Cap for fs/write payloads (OOM guard). */
const MAX_WRITE_BYTES = 50 * 1024 * 1024;
/** Binary sniff window. */
const BINARY_SNIFF_BYTES = 8192;
/** Watcher event debounce. */
const WATCH_DEBOUNCE_MS = 120;
/** Delay before a single watcher-recreation retry after an fs.watch error. */
const WATCHER_RETRY_MS = 2000;
/** SSE heartbeat interval. */
const SSE_HEARTBEAT_MS = 25_000;
/** Concurrency for per-entry stat() during directory listing. */
const LIST_STAT_CONCURRENCY = 32;

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Business error carrier (converted to the RPC error branch at the boundary). */
class FsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Success value for every fs endpoint (schema-safe: values are free-form). */
const ok = (value) => ({ ok: true, value });
/** Error branch; only codes the shared RPC schema knows are used. */
const fail = (error) => ({
  ok: false,
  error: error instanceof FsError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: 'internal', message: String(error?.message ?? error), details: {} },
});

/** Absolute path for a client-supplied relative path, confined to root. */
function confine(root, rel) {
  const abs = resolve(root, rel ?? '.');
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new FsError('bad-request', `path escapes the workspace root: ${rel}`, { issues: [] });
  }
  return abs;
}

/**
 * Confine + canonicalize: realpath the deepest existing ancestor and re-append
 * the remainder, so a symlinked directory cannot smuggle a write outside root.
 */
async function confineReal(root, rel) {
  const abs = confine(root, rel);
  let p = abs;
  let suffix = '';
  for (;;) {
    try {
      const real = await realpath(p);
      const out = suffix === '' ? real : join(real, suffix);
      return confine(root, out);
    } catch {
      const parent = dirname(p);
      if (p === parent) break;
      suffix = suffix === '' ? basename(p) : join(basename(p), suffix);
      p = parent;
    }
  }
  return abs;
}

/**
 * Shrink the symlink-swap (TOCTOU) race: re-resolve the final path right
 * before the actual read and re-confine. This cannot fully close the window
 * (a concurrent actor with workspace write access could still swap between
 * this check and the syscall), but it removes the wide window where a symlink
 * planted after confineReal() would be followed to an out-of-root target.
 */
async function reconfineIfExists(root, abs) {
  let real;
  try {
    real = await realpath(abs);
  } catch {
    return abs; // file vanished; the operation will surface ENOENT
  }
  return confine(root, real);
}

/**
 * Run `fn` over `items` with at most `limit` promises in flight, preserving
 * order. Used for directory listing stats so huge directories do not spawn
 * unbounded concurrent syscalls (or serialize thousands of them).
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Server-side sandbox gate: the client-supplied root must be a directory the
 * harness actually owns — the canonical cwd of a live session, or a path in
 * the workspace registry. Arbitrary directories (/, /etc, ~) are rejected, so
 * a caller that only knows the loopback API cannot read or mutate files
 * outside the harness's workspaces.
 *
 * @param {object} ctx - plugin context (used for optional service lookup).
 * @param {string} root - resolved, existing root directory (see requireDir).
 */
async function assertAllowedRoot(ctx, root) {
  let canonical;
  try {
    canonical = await realpath(root);
  } catch {
    throw new FsError('bad-request', `workspace root not accessible: ${root}`, { issues: [] });
  }
  const allowed = await allowedRoots(ctx);
  if (!allowed.has(canonical)) {
    throw new FsError('bad-request', 'workspace root not recognized: no live session or workspace owns this directory', { issues: [] });
  }
}

/**
 * Build the set of canonical paths the harness owns right now: every live
 * session's header cwd plus every registered workspace path. Services are
 * looked up via ctx.get (optional) so the plugin still mounts in contexts
 * where one of them is absent; when neither exists, no root is allowed.
 */
async function allowedRoots(ctx) {
  const out = new Set();
  const add = async (p) => {
    if (typeof p === 'string' && p !== '') {
      try {
        out.add(await realpath(p));
      } catch {
        /* directory deleted; skip */
      }
    }
  };
  if (typeof ctx.get === 'function') {
    const sessions = ctx.get('sessions');
    if (sessions && typeof sessions.list === 'function') {
      for (const s of sessions.list()) {
        await add(s?.header?.cwd);
      }
    }
    const registry = ctx.get('workspaceRegistry');
    if (registry && typeof registry.list === 'function') {
      for (const w of registry.list()) {
        await add(w?.path);
      }
    }
  }
  return out;
}

async function requireDir(root) {
  if (typeof root !== 'string' || root === '') throw new FsError('bad-request', 'missing workspace root', { issues: [] });
  let st;
  try {
    st = await stat(root);
  } catch {
    throw new FsError('bad-request', `workspace root not accessible: ${root}`, { issues: [] });
  }
  if (!st.isDirectory()) throw new FsError('bad-request', `workspace root is not a directory: ${root}`, { issues: [] });
  return resolve(root);
}

async function statEntry(abs) {
  let st;
  try {
    st = await stat(abs);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new FsError('bad-request', `cannot stat ${abs}: ${error?.message ?? error}`, { issues: [] });
  }
  return {
    name: basename(abs),
    path: '.',
    isDir: st.isDirectory(),
    size: st.isDirectory() ? 0 : st.size,
    mtimeMs: st.mtimeMs,
    hidden: basename(abs).startsWith('.'),
  };
}

// ── endpoints ───────────────────────────────────────────────────────────────
// Every endpoint receives `{ ...payload, root }` where root was validated by
// requireDir + assertAllowedRoot. Paths are relative to that root.

/** fs/stat — metadata for one path (missing -> { exists: false }). */
async function endpointStat(root, rel) {
  const abs = await confineReal(root, rel);
  const entry = await statEntry(abs);
  if (entry === null) return ok({ exists: false });
  entry.path = rel ?? '.';
  return ok({ exists: true, ...entry });
}

/** fs/list — one directory level; dirs first, name-sorted, dotfiles gated. */
async function endpointList(root, rel, includeHidden) {
  const abs = await confineReal(root, rel);
  let dirents;
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch (error) {
    throw new FsError('directory-unreadable', `cannot list ${abs}: ${error?.message ?? error}`, { path: abs });
  }
  const rows = await mapLimit(dirents, LIST_STAT_CONCURRENCY, async (d) => {
    if (d.name === '.' || d.name === '..') return null;
    const full = join(abs, d.name);
    let st;
    try {
      st = await stat(full);
    } catch {
      return null; // vanished between readdir and stat
    }
    const hidden = d.name.startsWith('.');
    if (hidden && !includeHidden) return null;
    return {
      name: d.name,
      path: relative(root, full) || '.',
      isDir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtimeMs: st.mtimeMs,
      hidden,
    };
  });
  const entries = rows.filter(Boolean);
  entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return ok({ path: relative(root, abs) || '.', entries });
}

/** fs/read — inline content up to MAX_INLINE_BYTES; binary/tooLarge branches. */
async function endpointRead(root, rel) {
  const abs = await reconfineIfExists(root, await confineReal(root, rel));
  let st;
  try {
    st = await stat(abs);
  } catch (error) {
    throw new FsError('bad-request', `cannot read ${rel}: ${error?.message ?? error}`, { issues: [] });
  }
  if (st.isDirectory()) throw new FsError('bad-request', `is a directory: ${rel}`, { issues: [] });
  if (st.size > MAX_INLINE_BYTES) return ok({ tooLarge: true, size: st.size, mtimeMs: st.mtimeMs });
  let buf;
  try {
    buf = await readFile(abs);
  } catch (error) {
    throw new FsError('bad-request', `cannot read ${rel}: ${error?.message ?? error}`, { issues: [] });
  }
  const sniff = buf.subarray(0, BINARY_SNIFF_BYTES);
  if (sniff.includes(0)) return ok({ binary: true, size: buf.length, mtimeMs: st.mtimeMs });
  return ok({ content: buf.toString('utf8'), size: buf.length, mtimeMs: st.mtimeMs });
}

/** fs/readLarge — like fs/read but with a higher (still finite) cap. */
async function endpointReadLarge(root, rel) {
  const abs = await reconfineIfExists(root, await confineReal(root, rel));
  let st;
  try {
    st = await stat(abs);
  } catch (error) {
    throw new FsError('bad-request', `cannot read ${rel}: ${error?.message ?? error}`, { issues: [] });
  }
  if (st.isDirectory()) throw new FsError('bad-request', `is a directory: ${rel}`, { issues: [] });
  if (st.size > MAX_READLARGE_BYTES) return ok({ tooLarge: true, size: st.size, mtimeMs: st.mtimeMs });
  let buf;
  try {
    buf = await readFile(abs);
  } catch (error) {
    throw new FsError('bad-request', `cannot read ${rel}: ${error?.message ?? error}`, { issues: [] });
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return ok({ binary: true, size: buf.length });
  return ok({ content: buf.toString('utf8'), size: buf.length });
}

/** fs/write — atomic (tmp + rename), mkdir -p parent, size-capped, O_EXCL tmp. */
async function endpointWrite(root, rel, content) {
  if (typeof content !== 'string') throw new FsError('bad-request', 'content must be a string', { issues: [] });
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    throw new FsError('bad-request', `content too large (max ${MAX_WRITE_BYTES} bytes)`, { issues: [] });
  }
  const abs = await confineReal(root, rel);
  let tmp = null;
  try {
    await mkdir(dirname(abs), { recursive: true });
    // 'wx' fails if the temp path already exists, so a pre-planted symlink at
    // the temp name is never followed; rename() then atomically replaces the
    // target (moving the link itself, never following it).
    tmp = join(dirname(abs), `.${basename(abs)}.dsh-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const fh = await open(tmp, 'wx');
    try {
      await fh.writeFile(content, 'utf8');
    } finally {
      await fh.close();
    }
    await rename(tmp, abs);
    tmp = null; // committed; nothing to clean up
  } catch (error) {
    throw new FsError('internal', `write failed for ${rel}: ${error?.message ?? error}`);
  } finally {
    if (tmp !== null) {
      try {
        await rm(tmp, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
  const st = await stat(abs);
  return ok({ written: true, mtimeMs: st.mtimeMs, size: st.size });
}

/** fs/create — new file (O_EXCL) or directory (non-recursive mkdir). */
async function endpointCreate(root, rel, kind) {
  if (kind !== 'file' && kind !== 'dir') {
    throw new FsError('bad-request', `invalid kind: ${String(kind)}`, { issues: [] });
  }
  const abs = await confineReal(root, rel);
  try {
    await mkdir(dirname(abs), { recursive: true });
    if (kind === 'dir') {
      await mkdir(abs, { recursive: false });
    } else {
      await writeFile(abs, '', { flag: 'wx' });
    }
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new FsError('directory-exists', `already exists: ${rel}`, { path: abs });
    }
    throw new FsError('internal', `create failed for ${rel}: ${error?.message ?? error}`);
  }
  return ok({ path: rel });
}

/** fs/rename — same directory; newName must be a bare safe filename. */
async function endpointRename(root, rel, newName) {
  if (
    typeof newName !== 'string' || newName === '' ||
    newName === '.' || newName === '..' ||
    newName.includes('/') || newName.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(newName) // control chars / NUL
  ) {
    throw new FsError('bad-request', `invalid name: ${String(newName)}`, { issues: [] });
  }
  const abs = await confineReal(root, rel);
  const target = join(dirname(abs), newName);
  try {
    await rename(abs, target);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new FsError('bad-request', `not found: ${rel}`, { issues: [] });
    throw new FsError('internal', `rename failed: ${error?.message ?? error}`);
  }
  return ok({ path: relative(root, target) || '.' });
}

/** fs/move — relocate into another (existing, confined) directory. */
async function endpointMove(root, rel, targetDir) {
  const abs = await confineReal(root, rel);
  const tdir = await confineReal(root, targetDir);
  let tst;
  try {
    tst = await stat(tdir);
  } catch {
    throw new FsError('bad-request', `target directory not found: ${targetDir}`, { issues: [] });
  }
  if (!tst.isDirectory()) throw new FsError('bad-request', `target is not a directory: ${targetDir}`, { issues: [] });
  const target = join(tdir, basename(abs));
  try {
    await rename(abs, target);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new FsError('bad-request', `not found: ${rel}`, { issues: [] });
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
      throw new FsError('directory-exists', `target already exists: ${relative(root, target) || '.'}`, { path: target });
    }
    throw new FsError('internal', `move failed: ${error?.message ?? error}`);
  }
  return ok({ path: relative(root, target) || '.' });
}

/** fs/delete — file or recursive dir; the workspace root itself is blocked. */
async function endpointDelete(root, rel) {
  const abs = await confineReal(root, rel);
  if (abs === root) throw new FsError('bad-request', 'cannot delete the workspace root', { issues: [] });
  try {
    await rm(abs, { recursive: true, force: false });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new FsError('bad-request', `not found: ${rel}`, { issues: [] });
    throw new FsError('internal', `delete failed: ${error?.message ?? error}`);
  }
  return ok({ deleted: true });
}

const ENDPOINTS = {
  'fs/stat': (p) => endpointStat(p.root, p.path),
  'fs/list': (p) => endpointList(p.root, p.path, p.includeHidden !== false),
  'fs/read': (p) => endpointRead(p.root, p.path),
  'fs/readLarge': (p) => endpointReadLarge(p.root, p.path),
  'fs/write': (p) => endpointWrite(p.root, p.path, p.content),
  'fs/create': (p) => endpointCreate(p.root, p.path, p.kind),
  'fs/rename': (p) => endpointRename(p.root, p.path, p.newName),
  'fs/move': (p) => endpointMove(p.root, p.path, p.targetDir),
  'fs/delete': (p) => endpointDelete(p.root, p.path),
};

/**
 * RPC channel handler: validates the root once (existence + sandbox
 * allowlist), then dispatches. ctx is captured from apply() so the sandbox
 * gate can read live sessions / the workspace registry.
 */
async function rpcHandler(endpoint, payload, ctx) {
  try {
    const fn = ENDPOINTS[endpoint];
    if (fn === undefined) {
      return fail(new FsError('bad-request', `unknown endpoint: ${endpoint}`, { issues: [] }));
    }
    const root = await requireDir(payload?.root);
    await assertAllowedRoot(ctx, root);
    return await fn({ ...payload, root });
  } catch (error) {
    return fail(error);
  }
}

// ── static assets ────────────────────────────────────────────────────────────

const VENDOR_DIR = fileURLToPath(new URL('../vendor/', import.meta.url));

function assetPathFor(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice('/explorer-assets'.length));
  } catch {
    return null; // malformed percent-encoding
  }
  rel = rel.replace(/^[/\\]+/, '');
  if (rel === '' || /[\u0000-\u001f\u007f]/.test(rel)) return null;
  // Reject traversal segments BEFORE normalizing, so '..' can never be
  // collapsed away into an in-bounds path. Both '/' and '\' separators are
  // treated as path separators for this check.
  if (rel.split(/[\\/]+/).includes('..')) return null;
  const full = resolve(VENDOR_DIR, rel);
  const base = resolve(VENDOR_DIR) + sep;
  if (full !== resolve(VENDOR_DIR) && !full.startsWith(base)) return null;
  return full;
}

async function staticHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/explorer-assets' || url.pathname === '/explorer-assets/') {
    res.writeHead(302, { Location: '/explorer-assets/monaco/vs/loader.js' });
    res.end();
    return;
  }
  const full = assetPathFor(url.pathname);
  if (full === null) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  let data;
  try {
    data = await readFile(full);
  } catch {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = full.slice(full.lastIndexOf('.')).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

// ── SSE watcher ──────────────────────────────────────────────────────────────
// One fs.watch per active root, shared by all SSE clients of that root
// (refcounted). A watcher error must never crash the server: without an
// 'error' listener Node throws on the FSWatcher, killing the whole process —
// this happened before the handler existed. We close the broken watcher, wake
// clients once so they refresh, and schedule a single bounded recreation.

const sseClients = new Set(); // { res, root }
const watchers = new Map(); // root -> { handle, clients:Set, timer, retryTimer }

/** Create an fs.watch handle for root (recursive, non-recursive fallback). */
function createWatcher(root) {
  try {
    const handle = fsSync.watch(root, { recursive: true }, (event, filename) => {
      queueWatcherEvent(root, { kind: event === 'rename' ? (filename === null ? 'deleted' : 'renamed') : 'changed', path: String(filename ?? '') });
    });
    handle.on('error', () => onWatcherError(root));
    return handle;
  } catch {
    // No recursive watch (or EPERM) — degrade to non-recursive root watch.
    try {
      const handle = fsSync.watch(root, (event) => {
        queueWatcherEvent(root, { kind: event === 'rename' ? 'renamed' : 'changed', path: '' });
      });
      handle.on('error', () => onWatcherError(root));
      return handle;
    } catch {
      return null;
    }
  }
}

async function startWatcher(root) {
  const existing = watchers.get(root);
  if (existing !== undefined) {
    if (existing.handle !== null) return existing;
    // Previous watcher errored; try to recreate it immediately.
    const handle = createWatcher(root);
    if (handle !== null) {
      existing.handle = handle;
      return existing;
    }
    return null;
  }
  const handle = createWatcher(root);
  if (handle === null) return null;
  const record = { handle, clients: new Set(), timer: null, retryTimer: null };
  watchers.set(root, record);
  return record;
}

/** fs.watch emitted an error: close the handle, wake clients, retry once. */
function onWatcherError(root) {
  const record = watchers.get(root);
  if (record === undefined) return;
  try {
    record.handle?.close();
  } catch {
    /* already closed */
  }
  record.handle = null;
  if (record.timer !== null) {
    clearTimeout(record.timer);
    record.timer = null;
  }
  // Wake clients once so the tree refreshes even though the watcher died.
  const payload = JSON.stringify({ type: 'fs', root, events: [{ kind: 'changed', path: '' }] });
  for (const client of record.clients) {
    try {
      client.res.write(`data: ${payload}\n\n`);
    } catch {
      /* client gone; cleaned by its close handler */
    }
  }
  if (record.retryTimer !== null) return; // a retry is already scheduled
  record.retryTimer = setTimeout(() => {
    record.retryTimer = null;
    if (record.clients.size === 0) {
      watchers.delete(root);
      return;
    }
    startWatcher(root); // best-effort; failures are contained in createWatcher
  }, WATCHER_RETRY_MS);
}

function queueWatcherEvent(root, event) {
  const record = watchers.get(root);
  if (record === undefined || record.handle === null) return;
  if (record.timer !== null) clearTimeout(record.timer);
  record.timer = setTimeout(() => {
    record.timer = null;
    const payload = JSON.stringify({ type: 'fs', root, events: [event] });
    for (const client of record.clients) {
      try {
        client.res.write(`data: ${payload}\n\n`);
      } catch {
        /* client gone; cleaned by close handler */
      }
    }
  }, WATCH_DEBOUNCE_MS);
}

function stopWatcherIfIdle(root) {
  const record = watchers.get(root);
  if (record === undefined) return;
  if (record.clients.size > 0) return;
  if (record.timer !== null) clearTimeout(record.timer);
  if (record.retryTimer !== null) {
    clearTimeout(record.retryTimer);
    record.retryTimer = null;
  }
  try {
    record.handle?.close();
  } catch {
    /* already closed */
  }
  watchers.delete(root);
}

async function eventsHandler(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const rootParam = url.searchParams.get('root') ?? '';
  let root;
  try {
    root = await requireDir(rootParam);
    await assertAllowedRoot(ctx, root);
  } catch (error) {
    // Distinguish "not a directory" (400) from "not an owned workspace" (403).
    if (error instanceof FsError && error.code === 'bad-request' && error.message.includes('not recognized')) {
      res.writeHead(403);
      res.end('forbidden root');
      return;
    }
    res.writeHead(400);
    res.end('invalid root');
    return;
  }
  const record = await startWatcher(root);
  if (record === null) {
    res.writeHead(503);
    res.end('watcher unavailable');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, root };
  record.clients.add(client);
  sseClients.add(client);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, SSE_HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    record.clients.delete(client);
    sseClients.delete(client);
    stopWatcherIfIdle(root);
  });
}

// ── plugin body ──────────────────────────────────────────────────────────────

export function apply(ctx) {
  const disposers = [];
  disposers.push(ctx.connection.rpc.handle('/explorer', (endpoint, payload) => rpcHandler(endpoint, payload, ctx), { authority: 'loopback' }));
  disposers.push(ctx.webServer.register({ kind: 'prefix', path: '/explorer-assets', handler: staticHandler }));
  disposers.push(ctx.webServer.register({ kind: 'exact', path: '/explorer/events', handler: (req, res) => eventsHandler(req, res, ctx) }));
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    for (const record of watchers.values()) {
      if (record.timer !== null) clearTimeout(record.timer);
      if (record.retryTimer !== null) clearTimeout(record.retryTimer);
      try {
        record.handle?.close();
      } catch {
        /* ignore */
      }
    }
    watchers.clear();
    sseClients.clear();
  };
}
