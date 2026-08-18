/**
 * dsh-explorer-plugni — server half.
 *
 * A Cordis plugin that powers the File Explorer UI:
 *   - RPC channel `/rpc/explorer` (fs/* endpoints), registered on the
 *     `connection` service with loopback trust (the GUI is served on
 *     loopback, matching every other browser RPC channel).
 *   - Static assets under `/explorer-assets` (monaco, oniguruma wasm,
 *     TextMate grammars, VS Code themes) served from this package's vendor/.
 *   - SSE at `/explorer/events?root=...` broadcasting fs.watch events so the
 *     tree refreshes in real time (including when the agent writes files).
 *
 * Every filesystem operation is confined to the workspace root supplied by
 * the client (the session's cwd), honoring the session sandbox: nothing
 * outside the root can be read or written through this plugin.
 */
import { readdir, stat, realpath, readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { dirname, basename, join, relative, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable Cordis plugin name. */
export const name = 'explorer';
/** Services required before this plugin can mount. */
export const inject = ['webServer', 'connection'];

/** Cap above which fs/read refuses to inline content (client opens read-only). */
const MAX_INLINE_BYTES = 2 * 1024 * 1024;
/** Binary sniff window. */
const BINARY_SNIFF_BYTES = 8192;
/** Watcher event debounce. */
const WATCH_DEBOUNCE_MS = 120;
/** SSE heartbeat interval. */
const SSE_HEARTBEAT_MS = 25_000;

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

async function endpointStat(root, rel) {
  const abs = await confineReal(root, rel);
  const entry = await statEntry(abs);
  if (entry === null) return ok({ exists: false });
  entry.path = rel ?? '.';
  return ok({ exists: true, ...entry });
}

async function endpointList(root, rel, includeHidden) {
  const abs = await confineReal(root, rel);
  let dirents;
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch (error) {
    throw new FsError('directory-unreadable', `cannot list ${abs}: ${error?.message ?? error}`, { path: abs });
  }
  const entries = [];
  for (const d of dirents) {
    if (d.name === '.' || d.name === '..') continue;
    const full = join(abs, d.name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue; // vanished between readdir and stat
    }
    const hidden = d.name.startsWith('.');
    if (hidden && !includeHidden) continue;
    entries.push({
      name: d.name,
      path: relative(root, full) || '.',
      isDir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtimeMs: st.mtimeMs,
      hidden,
    });
  }
  entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return ok({ path: relative(root, abs) || '.', entries });
}

async function endpointRead(root, rel) {
  const abs = await confineReal(root, rel);
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

async function endpointReadLarge(root, rel) {
  const abs = await confineReal(root, rel);
  let buf;
  try {
    buf = await readFile(abs);
  } catch (error) {
    throw new FsError('bad-request', `cannot read ${rel}: ${error?.message ?? error}`, { issues: [] });
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return ok({ binary: true, size: buf.length });
  return ok({ content: buf.toString('utf8'), size: buf.length });
}

async function endpointWrite(root, rel, content) {
  if (typeof content !== 'string') throw new FsError('bad-request', 'content must be a string', { issues: [] });
  const abs = await confineReal(root, rel);
  try {
    await mkdir(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.${basename(abs)}.dsh-tmp-${process.pid}-${Date.now()}`);
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, abs);
  } catch (error) {
    throw new FsError('internal', `write failed for ${rel}: ${error?.message ?? error}`);
  }
  const st = await stat(abs);
  return ok({ written: true, mtimeMs: st.mtimeMs, size: st.size });
}

async function endpointCreate(root, rel, kind) {
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

async function endpointRename(root, rel, newName) {
  if (typeof newName !== 'string' || newName === '' || newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
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

/** RPC channel handler: validates the root once, then dispatches. */
async function rpcHandler(endpoint, payload) {
  try {
    const fn = ENDPOINTS[endpoint];
    if (fn === undefined) {
      return fail(new FsError('bad-request', `unknown endpoint: ${endpoint}`, { issues: [] }));
    }
    const root = await requireDir(payload?.root);
    return await fn({ ...payload, root });
  } catch (error) {
    return fail(error);
  }
}

// ── static assets ────────────────────────────────────────────────────────────

const VENDOR_DIR = fileURLToPath(new URL('../vendor/', import.meta.url));

function assetPathFor(pathname) {
  const rel = normalize(decodeURIComponent(pathname.slice('/explorer-assets'.length)).replace(/^[/\\]+/, ''));
  if (rel === '' || rel.startsWith('..') || rel.includes('..\\') || rel.split(sep).includes('..')) return null;
  const full = resolve(VENDOR_DIR, rel);
  if (!full.startsWith(resolve(VENDOR_DIR) + sep) && full !== resolve(VENDOR_DIR)) return null;
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

const sseClients = new Set(); // { res, root, watcherKey }
const watchers = new Map(); // root -> { handle, clients:Set, timer }

async function startWatcher(root) {
  const existing = watchers.get(root);
  if (existing !== undefined) return existing;
  let handle;
  try {
    handle = fsSync.watch(root, { recursive: true }, (event, filename) => {
      queueWatcherEvent(root, { kind: event === 'rename' ? (filename === null ? 'deleted' : 'renamed') : 'changed', path: String(filename ?? '') });
    });
  } catch (error) {
    // No recursive watch (or EPERM) — degrade to non-recursive root watch + periodic rescan signal.
    try {
      handle = fsSync.watch(root, (event) => {
        queueWatcherEvent(root, { kind: event === 'rename' ? 'renamed' : 'changed', path: '' });
      });
    } catch {
      return null;
    }
  }
  const record = { handle, clients: new Set(), timer: null };
  watchers.set(root, record);
  return record;
}

function queueWatcherEvent(root, event) {
  const record = watchers.get(root);
  if (record === undefined) return;
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
  try {
    record.handle.close();
  } catch {
    /* already closed */
  }
  watchers.delete(root);
}

async function eventsHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rootParam = url.searchParams.get('root') ?? '';
  let root;
  try {
    root = await requireDir(rootParam);
  } catch {
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
  disposers.push(ctx.connection.rpc.handle('/explorer', rpcHandler, { authority: 'loopback' }));
  disposers.push(ctx.webServer.register({ kind: 'prefix', path: '/explorer-assets', handler: staticHandler }));
  disposers.push(ctx.webServer.register({ kind: 'exact', path: '/explorer/events', handler: eventsHandler }));
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    for (const record of watchers.values()) {
      try {
        record.handle.close();
      } catch {
        /* ignore */
      }
    }
    watchers.clear();
    sseClients.clear();
  };
}
