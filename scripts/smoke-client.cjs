// Smoke test for the client bundle.
//
// 1. Loads lib/client.js through a stubbed module loader and validates the
//    handoff contract (id, factory, apply, inject).
// 2. Runs `apply` against a mock client ctx to prove the plugin claims its
//    resources through effects, and that the CSS claim installs, is idempotent
//    and is disposable.
// 3. Renders ExplorerPanel once with a minimal React hook dispatcher. That
//    catches first-render crashes — the failure mode that silently blanks a
//    slot entry in the browser ("slot entry crashed in '<slot>'") — and proves
//    the copy still resolves when the framework-injected `t` prop is absent.
// 4. Runs the docking effect against a fake AppFrame and proves the panel is
//    inserted as a grid track WITHOUT shifting the app's auto-placed columns
//    (the regression that made the panel cover the chat window).
//
// All paths derive from this file's location, so the test works from any checkout.
const path = require('path');
const { loadModule } = require('./lib/toolchain.cjs');
const ws = path.resolve(__dirname, '..');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('ok   ' + name);
  else { failures++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// ── minimal DOM ──
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.style = {};
    this.scrollLeft = 0;
    this.listeners = {};
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  hasAttribute(k) { return this.attrs[k] !== undefined; }
  addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
  removeEventListener(k, fn) {
    const l = this.listeners[k];
    if (l) this.listeners[k] = l.filter((f) => f !== fn);
  }
  emit(k) { for (const fn of this.listeners[k] || []) fn(); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  querySelector(sel) {
    const m = /^style\[data-plugin="(.+)"\]$/.exec(sel);
    if (m) return this.children.find((c) => c.tagName === 'STYLE' && c.attrs['data-plugin'] === m[1]) || null;
    return null;
  }
}
const head = new FakeEl('head');
let shellOverlayEl = null; // set by the docking test: fake [data-shell-overlay]

const React = loadModule('react');

// ── minimal hook dispatcher (no react-dom, no real DOM) ──
const noop = () => {};
const dispatcher = {
  useState: (init) => [typeof init === 'function' ? init() : init, noop],
  useReducer: (reducer, init, initFn) => [initFn ? initFn(init) : init, noop],
  useEffect: noop,
  useLayoutEffect: noop,
  useInsertionEffect: noop,
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => (typeof getSnapshot === 'function' ? getSnapshot() : undefined),
  useTransition: () => [false, noop],
  useDeferredValue: (v) => v,
  useId: () => 'smoke',
  useDebugValue: noop,
  useImperativeHandle: noop,
  useContext: (c) => (c && c._currentValue !== undefined ? c._currentValue : undefined),
};

global.window = { __ModuleLoader__: { load: (handoff) => { global.__loaded = handoff; } } };
global.document = {
  head,
  createElement: (tag) => new FakeEl(tag),
  querySelector(sel) {
    if (sel === '[data-shell-overlay]') return shellOverlayEl;
    return head.querySelector(sel);
  },
};
global.localStorage = { getItem: () => null, setItem: () => {} };
global.navigator = { languages: ['en'] };
global.fetch = () => Promise.reject(new Error('offline smoke test'));
global.getComputedStyle = () => ({ position: 'static' });
global.EventSource = class { constructor() { this.onmessage = null; } close() {} };
global.MutationObserver = class {
  constructor(cb) { this.cb = cb; }
  observe() {} disconnect() {}
};
global.require = (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
};

require(path.join(ws, 'lib/client.js'));
const loaded = global.__loaded;
if (!loaded) throw new Error('loader.load never called');
if (loaded.id !== 'dsh-explorer-plugin') throw new Error('bad id: ' + loaded.id);
const out = loaded.factory(global.require);
if (typeof out.apply !== 'function') throw new Error('apply missing');
if (!Array.isArray(out.inject)) throw new Error('inject missing');

const emptySnap = { current: null, byId: {}, items: [] };

/**
 * Build a mock client ctx, run `apply`, execute every claimed effect the way
 * the host would on mount, and return the captured registrations.
 * @param bind - what ctx.locale.bind returns (a translator, or something hostile)
 */
function mountWith(bind) {
  const effects = [];
  const registered = { locale: [], slots: [] };
  const ctx = {
    effect(fn, name) { effects.push({ fn, name }); return () => {}; },
    on() { return () => {}; },
    get() { return undefined; },
    locale: {
      register(ns, dicts) { registered.locale.push({ ns, dicts }); return () => {}; },
      bind,
    },
    slots: { register(options, component) { registered.slots.push({ options, component }); return () => {}; } },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => emptySnap } },
    workspaces: { list: { subscribe: () => () => {}, getSnapshot: () => emptySnap } },
    theme: { getTheme: () => ({ active: { id: 'dark', colorScheme: 'dark' } }) },
    connection: { rpc: { call: () => Promise.reject(new Error('offline')) } },
  };
  out.apply(ctx);
  for (const effect of effects) {
    try { effect.fn(); } catch (error) { console.log('   claim failed (' + effect.name + '): ' + error.message); }
  }
  return { ctx, effects, registered };
}

const dispatching = (() => {
  const internals =
    React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE || // React 19
    React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;                // React 18
  if (internals && internals.ReactCurrentDispatcher) { internals.ReactCurrentDispatcher.current = dispatcher; return true; }
  if (internals && 'H' in internals) { internals.H = dispatcher; return true; }
  return false;
})();
if (!dispatching) {
  console.log('note: unknown React internals shape; first-render checks skipped');
}

// ── 1. apply() + resource claims ──
const { effects, registered } = mountWith((key) => 'T:' + key);
check('apply claims resources through ctx.effect', effects.length >= 3, JSON.stringify(effects.map((e) => e.name)));

const slotOptions = registered.slots.map((s) => s.options);
check('slot registration targets shell.overlay with a fresh id',
  registered.slots.length === 1 && slotOptions[0].name === 'shell.overlay' &&
  slotOptions[0].id === 'dsh-explorer' && typeof registered.slots[0].component === 'function',
  JSON.stringify(slotOptions));

check('locale dictionaries registered for the explorer namespace',
  registered.locale.length === 1 && registered.locale[0].ns === 'explorer' &&
  typeof registered.locale[0].dicts.en === 'object' && typeof registered.locale[0].dicts.zh === 'object',
  JSON.stringify(registered.locale.map((l) => l.ns)));

// ── 2. disposable CSS ──
const styleEffect = effects.find((e) => e.name && e.name.includes('style'));
check('apply claims the plugin stylesheet', styleEffect !== undefined);
if (styleEffect) {
  const installed = head.querySelector('style[data-plugin="dsh-explorer-plugin"]');
  check('stylesheet injected once', installed !== null && installed.textContent.includes('.dx-panel'));
  const secondClaim = styleEffect.fn(); // idempotent: must not add a second <style>
  check('stylesheet claim is idempotent', head.children.filter((c) => c.tagName === 'STYLE').length === 1);
  if (typeof secondClaim === 'function') secondClaim();
  check('stylesheet removed on dispose', head.querySelector('style[data-plugin="dsh-explorer-plugin"]') === null);
}

// ── 3. first render, with and without a usable locale seat ──
if (dispatching) {
  const component = registered.slots[0].component;

  let markup = null;
  let renderError = null;
  try {
    // No `t` prop on purpose: the module's own fallback must carry the copy.
    markup = component({});
  } catch (error) { renderError = error; }
  if (renderError) console.log('   render error: ' + renderError.message);
  check('ExplorerPanel renders on first paint without a t prop', markup !== null && renderError === null);
  const html = markup === null ? '' : JSON.stringify(markup);
  check('rendered tree carries the panel classes', html.includes('dx-panel'), html.slice(0, 160));

  // A hostile locale seat (bind missing, or bind ignoring the namespace) must
  // degrade to our own dictionary instead of blanking the panel.
  const hostile = [
    ['bind missing', undefined],
    ['bind throws', () => { throw new Error('no such namespace'); }],
    ['bind returns null', () => null],
  ];
  for (const [label, bind] of hostile) {
    const other = mountWith(bind);
    const otherComponent = other.registered.slots[0].component;
    let otherMarkup = null;
    let otherError = null;
    try { otherMarkup = otherComponent({}); } catch (error) { otherError = error; }
    const otherHtml = otherMarkup === null ? '' : JSON.stringify(otherMarkup);
    check('renders with locale ' + label + ' (dictionary fallback)',
      otherError === null && otherHtml.includes('Explorer'),
      otherError ? otherError.message : otherHtml.slice(0, 160));
  }

  // ── 4. docking regression: grid track insertion must not shift the app columns ──
  // The AppFrame auto-places its columns (sidebar → track 1, chat → track 2,
  // rightbar → track 3). Inserting our track without pinning them moved the
  // chat into our fixed-width track and the panel covered it completely.
  {
    const mk = (tag) => { const el = new FakeEl(tag); el.style = {}; return el; };
    const BASE = '280px minmax(400px, 1fr) minmax(0px, 0px)';
    const frame = mk('div');
    frame.style.gridTemplateColumns = BASE;
    frame.setAttribute('data-rightbar-collapsed', ''); // app's right sidebar closed (normal state)
    const sidebar = mk('div'), center = mk('div'), rightbar = mk('div'), overlay = mk('div');
    overlay.setAttribute('data-shell-overlay', '');
    frame.appendChild(sidebar); frame.appendChild(center);
    frame.appendChild(rightbar); frame.appendChild(overlay);
    frame.firstElementChild = sidebar;
    sidebar.nextElementSibling = center; center.nextElementSibling = rightbar;
    rightbar.nextElementSibling = overlay; overlay.nextElementSibling = null;
    overlay.parentElement = frame;
    shellOverlayEl = overlay;
    const observers = [];
    const MO = global.MutationObserver;
    global.MutationObserver = class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {} disconnect() {}
    };
    try {
      // fresh mount + render with useEffect collecting, then flush the effects
      const mounted = mountWith((key) => 'T:' + key);
      const Panel = mounted.registered.slots[0].component;
      const pending = [];
      dispatcher.useEffect = (fn) => { pending.push(fn); };
      let renderError = null;
      try { Panel({}); } catch (error) { renderError = error; }
      dispatcher.useEffect = noop;
      check('panel renders for the docking pass', renderError === null,
        renderError ? renderError.message : '');
      const cleanups = [];
      let effectErrors = 0;
      for (const fn of pending.splice(0)) {
        try { const off = fn(); if (typeof off === 'function') cleanups.push(off); }
        catch (error) { effectErrors++; console.log('   effect error: ' + error.message); }
      }
      check('mount effects run without crashing', effectErrors === 0);

      const docked = frame.style.gridTemplateColumns;
      check('panel width inserted as a grid track after the sidebar',
        docked === '280px 320px minmax(400px, 1fr) minmax(0px, 0px)', docked);
      check('only the displaced app columns pinned (chat not shifted into ours)',
        !sidebar.style.gridColumn && center.style.gridColumn === '3' && rightbar.style.gridColumn === '4',
        [sidebar.style.gridColumn, center.style.gridColumn, rightbar.style.gridColumn].join(','));

      // The app rewrites its own template (sidebar drag): the observer must re-dock.
      frame.style.gridTemplateColumns = '300px minmax(400px, 1fr) minmax(0px, 0px)';
      const mo = observers[observers.length - 1];
      if (mo) mo.cb();
      const redocked = frame.style.gridTemplateColumns;
      check('re-docks after the app rewrites its grid template',
        redocked === '300px 320px minmax(400px, 1fr) minmax(0px, 0px)', redocked);

      // React replacing a column node keeps the style attribute intact but
      // orphans the pin — the childList re-scan must re-pin the new node.
      const replacedCenter = mk('div');
      sidebar.nextElementSibling = replacedCenter;
      replacedCenter.nextElementSibling = rightbar;
      if (mo) mo.cb();
      check('re-pins a column node replaced by React (childList resync)',
        !sidebar.style.gridColumn && replacedCenter.style.gridColumn === '3' && rightbar.style.gridColumn === '4',
        [sidebar.style.gridColumn, replacedCenter.style.gridColumn, rightbar.style.gridColumn].join(','));

      for (const off of cleanups.splice(0)) { try { off(); } catch (e) { /* ignore */ } }
      check('teardown restores the app grid and clears the pins',
        frame.style.gridTemplateColumns === '300px minmax(400px, 1fr) minmax(0px, 0px)' &&
        !sidebar.style.gridColumn && !replacedCenter.style.gridColumn && !rightbar.style.gridColumn,
        frame.style.gridTemplateColumns);

      // Unknown frame structure: the grid must stay untouched (panel floats;
      // the chat is never shifted into a track it does not belong to). The
      // frame's scrollable overflow must also be pinned back to zero.
      const BASE2 = '280px minmax(400px, 1fr) minmax(0px, 0px)';
      const frame2 = mk('div');
      frame2.style.gridTemplateColumns = BASE2;
      frame2.setAttribute('data-rightbar-collapsed', '');
      frame2.scrollLeft = 256; // stray scroll artifact, as seen in the live app
      const lone = mk('div');
      const overlay2 = mk('div');
      overlay2.setAttribute('data-shell-overlay', '');
      frame2.appendChild(lone); frame2.appendChild(overlay2);
      frame2.firstElementChild = lone;
      lone.nextElementSibling = overlay2; overlay2.nextElementSibling = null;
      overlay2.parentElement = frame2;
      shellOverlayEl = overlay2;
      const mounted2 = mountWith((key) => 'T:' + key);
      const pending2 = [];
      dispatcher.useEffect = (fn) => { pending2.push(fn); };
      let renderError2 = null;
      try { mounted2.registered.slots[0].component({}); } catch (error) { renderError2 = error; }
      dispatcher.useEffect = noop;
      check('panel renders against an unknown frame', renderError2 === null,
        renderError2 ? renderError2.message : '');
      const cleanups2 = [];
      for (const fn of pending2.splice(0)) {
        try { const off = fn(); if (typeof off === 'function') cleanups2.push(off); } catch (e) { /* ignore */ }
      }
      check('unknown frame structure: grid untouched, no pins (fail-safe float)',
        frame2.style.gridTemplateColumns === BASE2 && !lone.style.gridColumn,
        frame2.style.gridTemplateColumns);
      check('stray frame scroll reset to zero (shell never scrolls)',
        frame2.scrollLeft === 0, String(frame2.scrollLeft));
      // A later stray scroll event must also snap back (scroll listener).
      frame2.scrollLeft = 128;
      frame2.emit('scroll');
      check('scroll event snaps the frame back to zero',
        frame2.scrollLeft === 0, String(frame2.scrollLeft));
      for (const off of cleanups2.splice(0)) { try { off(); } catch (e) { /* ignore */ } }
      shellOverlayEl = null;
    } finally {
      global.MutationObserver = MO;
      shellOverlayEl = null;
    }
  }
}

if (failures === 0) console.log('OK id=', loaded.id, 'inject=', JSON.stringify(out.inject));
console.log(failures === 0 ? '\nSMOKE OK' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
