# DSH File Explorer — Specification (v2, implemented)

Plugin for the DeepSeek Harness (DSH) that adds to the web GUI a **file explorer + code editor** in VS Code style: session workspace tree with full CRUD, Monaco editor with line numbers, multiple tabs, syntax highlighting with real VS Code TextMate grammars (Seti icon theme + Dark+/Light+ themes), agent integration (quick action) and locale following the GUI.

---

## 1. Overview

| Item | Decision |
|---|---|
| Type | npm package installable in the DSH profile via `dsh plugin` (bundle + client) |
| Server half | Cordis plugin (patch `cordis.patch.yml`) with the RPC file service |
| Client half | Bundle **hand-written** in the `window.__ModuleLoader__.load({id, factory})` format — **no build step** (zero toolchain dependencies) |
| File access | Direct server↔client RPC (channel `/explorer`), **not** routed through the LLM |
| Tree root | Current session workspace (session cwd); no session → open/create workspace flow |
| Permissions | Honors the session sandbox: every operation confined to the workspace root |
| Editor | Monaco Editor (AMD build served by the plugin itself) |
| Highlighting | Real VS Code TextMate grammars (via `vscode-textmate` + `vscode-oniguruma` WASM) + merged Dark+/Light+ themes |
| Icons | VS Code **codicon** font (UI/folders) + **Seti** icon theme (files, VS Code's default) |
| UI placement | Panel **docked as a real column of the app grid** (resizes the chat), collapsible, resizable and **movable** (left/right) |
| Language | Follows the active GUI locale (dictionaries `pt`, `en`, `zh`) |
| Author | dgadelha1 |
| Repository | https://github.com/dgadelha1/dsh-explorer-plugin |
| License | MIT |

## 2. Package structure

```
dsh-explorer-plugin/
├── package.json            # dsh.bundle.patch + dsh.client + exports
├── cordis.patch.yml        # inserts the server plugin line
├── LICENSE                 # MIT
├── SPEC.md                 # this document
├── lib/
│   ├── index.js            # server plugin (ESM): RPC, static routes, SSE/watcher
│   └── client.js           # client bundle (CJS factory of __ModuleLoader__) — single source, no build
├── src/                    # source copies (exports ./src/*) kept in sync
├── scripts/
│   ├── vendor.mjs          # downloads assets into vendor/ (idempotent; pinned versions)
│   ├── merge-themes.mjs    # JSONC -> strict JSON + merges the themes' include chain
│   ├── sync.mjs            # copies src/ -> lib/ (--check fails if they diverge; runs at prepack)
│   ├── server-test.mjs     # server regression test (sandbox/allowlist, caps, crash-free watcher)
│   ├── smoke-client.cjs    # bundle smoke test (loader stub in Node)
│   └── syntax-test-driver.cjs  # headless TextMate pipeline test (puppeteer + Firefox)
└── vendor/                 # assets served at runtime (committed to the repo)
    ├── monaco/             # monaco-editor (min AMD build; source maps removed)
    ├── onig/               # vscode-oniguruma (onig.wasm + UMD loader)
    ├── textmate/           # vscode-textmate (CJS/UMD release)
    ├── grammars/           # official .tmLanguage.json + manifest.json (scope → file)
    ├── themes/             # dark_plus.json / light_plus.json (strict JSON, merged)
    ├── codicon/            # VS Code codicon font (UI + folders)
    └── seti/               # seti font + vs-seti-icon-theme.json (file icons)
```

### 2.1 package.json metadata

```jsonc
{
  "name": "dsh-explorer-plugin",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./src/*": "./src/*",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-modules",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-theme",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

The server plugin exports `{ name: 'explorer', inject: ['webServer', 'connection'], apply(ctx) }`.

### 2.2 cordis.patch.yml

```yaml
- insert:
    - id: explorer
      name: 'dsh-explorer-plugin'
```

## 3. Server half (`lib/index.js`)

### 3.1 RPC channel `/explorer`

Registered with `ctx.connection.rpc.handle('/explorer', handler)` — on dsh releases where the `connection` service cannot see `webServer` from its own fiber (0.1.5-rc.3, where the documented `handle` throws `cannot get property "webServer" without inject`), the plugin falls back to the service's registry: `connection.register(ctx, '/explorer', handler)`, with the plugin's ctx as owner — the same prefix route, fence, and HTTP/envelope bridge. The former `{ authority: 'loopback' }` no longer exists: the platform fence requires a loopback Host + same-origin **and** the browser session cookie (401 without it).
> The channel **cannot contain an inner `/`** (`CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`) — hence `/explorer` and not `/rpc/explorer`.

Handler `(endpoint, payload, signal) → RpcResult`. The client calls `ctx.connection.rpc.call('/explorer', endpoint, payload)` → `POST /explorer/<endpoint>`.

Endpoints (all with `{root, …}`; paths always relative to the root):

| endpoint | payload | return |
|---|---|---|
| `fs/stat` | `{root, path}` | `{exists, path, name, isDir, size, mtimeMs, hidden}` (missing → `{exists:false}`) |
| `fs/list` | `{root, path, includeHidden}` | `{path, entries:[{name,path,isDir,size,mtimeMs,hidden}]}` (folders first, name-sorted; dotfiles filtered by `includeHidden`) |
| `fs/read` | `{root, path}` | `{content, size, mtimeMs}` — binary → `{binary:true}`; > 2 MB → `{tooLarge:true, size}` |
| `fs/readLarge` | `{root, path}` | content up to **50 MB** (above → `{tooLarge:true, size}`; used to open read-only) |
| `fs/write` | `{root, path, content}` | `{written, mtimeMs, size}` (atomic temp+rename write with `O_EXCL` and temp cleanup; mkdir -p of parent; **payload capped at 50 MB**) |
| `fs/create` | `{root, path, kind:'file'\|'dir'}` | `{path}` (fails with `directory-exists` if it already exists) |
| `fs/rename` | `{root, path, newName}` | `{path}` (same directory) |
| `fs/move` | `{root, path, targetDir}` | `{path}` (another directory; collision → `directory-exists`) |
| `fs/delete` | `{root, path}` | `{deleted:true}` (file or recursive folder; root is locked) |

Rules:
- **Confinement/sandbox**: `path.resolve(root, …)` + prefix check; existing paths go through `realpath` of the deepest ancestor (blocks symlinks that escape the root). Escaping → `bad-request`. Reads re-confirm the file's `realpath` immediately before I/O (reduced TOCTOU window).
- **Root validated server-side (not trusted from the client)**: the `root` sent by the client must be the canonical cwd of a live session or a workspace registry path — otherwise `bad-request`/`403`. This prevents reading/writing arbitrary directories (`/`, `/etc`, `~`) through the loopback API. The RPC channel is protected by the platform fence (`isTrustedApiRequest`: loopback Host + same-origin, plus the browser session cookie).
- `root` validated as an existing directory on every call.
- Error codes only from the shared RPC schema (`bad-request`, `directory-exists`, `directory-unreadable`, `internal`) — the client schema rejects unknown codes. The mutating endpoints' `catch` blocks **rethrow an already-typed `FsError`** instead of re-wrapping everything as `internal`: otherwise a confinement rejection (`bad-request`) would surface as an ordinary I/O failure.
- **Hidden by default on the server too**: an omitted `includeHidden` is treated as `false` (the client opts in through the header toggle), so the server default and the UI default agree.
- Static-route MIME is resolved from the **basename extension**, and only when the basename has a dot: `lastIndexOf('.')` over the whole path returns `-1` for an extensionless name and `slice(-1)` would hand the path's last character to the MIME table.
- Binary detected by a NUL byte within the first 8 KB.

### 3.2 Web routes (webServer)

| route | type | function |
|---|---|---|
| `/explorer-assets` | prefix | serves `vendor/` with correct MIME and `Cache-Control: no-cache` |
| `/explorer/events` | exact | watcher **SSE**: `data: {"type":"fs","root":...,"events":[...]}` (25 s heartbeat; 503 without watcher) |

### 3.3 Watcher

- `fs.watch(root, {recursive:true})` (Node ≥ 20, inotify) with ~120 ms debounce; non-recursive fallback if recursive fails.
- **Watcher `error` handled**: an `FSWatcher` without an `error` listener crashes the whole Node process (happened in production). The handler now closes the watcher, wakes the SSE clients once (refresh), and schedules **a single recreation** after 2 s — the server never crashes.
- One instance per active root, shared among SSE connections (refcount per client).
- Events grouped → broadcast to that root's clients; the client refreshes the tree with debounce.

## 4. Client half (`lib/client.js`)

### 4.1 Registration and architecture

- Bundle in the `window.__ModuleLoader__.load({id:'dsh-explorer-plugin', factory})` format, exporting `apply` + `inject`.
- `inject` (services): `['slots','layout','connection','sessions','workspaces','locale','theme']`.
- `apply(ctx)`: registers `explorer` dictionaries (pt/en/zh) and the `ExplorerPanel` component in the `shell.overlay` (list, root) slot of `ui-layout`.
- **Translated copy without depending on the `t` seat**: the registration declares `locale: 'explorer'` (the same pattern shipped plugins use, e.g. `agent-presets`' `settings.section`), but `shell.overlay`'s standard props do not include `t` — so the component resolves its translator in a cascade: `props.t` → `ctx.locale.bind('explorer')` → the internal dictionary (`en`, then `pt`). A host contract change therefore degrades to readable text instead of crashing the slot entry (which is what happens when a component throws: `slot entry crashed in '<slot>'`).
- Runtime dependencies of the bundle: only `react` (via `require`); everything else via `ctx` services. CSS is injected as a `<style data-plugin="dsh-explorer-plugin">` claimed by `ctx.effect`, so it is idempotent and disposed on unload (ownership lives in a `WeakSet`, so a repeated claim returns a working disposer instead of leaking the stylesheet).
- **Colors 100% from the theme**: all CSS uses DSH design-system tokens (`--dsw-*` — texts, borders, backgrounds, hover, dialogs, shadows) and `color-mix()` for translucent overlays; **no hardcoded hex/rgb**. Every token name is validated against the live token set of the installed DSH (`cordis_inspect_query` `Theme`, plus the bundle's own token table); the status bar uses the accent color (`--dsw-alias-state-business-primary`), folders/unsaved dot use the theme amber (`--dsw-alias-state-warn-*`), errors use `--dsw-alias-state-error-*`. The panel follows light/dark automatically via the app's theme attributes.
- Runtime assets loaded by classic script/fetch from `/explorer-assets` (monaco AMD via `loader.js` + `require.config({paths:{vs}})`; onig/textmate as classic UMD → `window.onig` / `window.vscodetextmate`; onig.wasm via `loadWASM({data})`).

### 4.2 Panel: docked into the grid (resizes the chat)

- The panel is rendered in the `shell.overlay` of the AppFrame, but **participates in the layout**: an effect reads the AppFrame's inline `grid-template-columns` (located via `[data-shell-overlay]`), **inserts the panel width as a column** (left side → after the DSH sidebar; right side → at the end) and keeps in sync with app changes via `MutationObserver` (self-loop guard by comparing the resulting template, not the read-back string).
- **The columns displaced by the insertion are pinned with `grid-column`**: the AppFrame places its columns by **auto-placement** (sidebar → track 1, chat → track 2, rightbar → track 3), so merely inserting a track would shift the chat into the panel's fixed track — the panel would cover it completely (the "explorer over the chat window" bug seen on the Desktop app 0.2.0-rc.2). Only **the columns after the insertion point** get pinned (left: chat→3, rightbar→4; the sidebar keeps natural placement; right: no pins, append at the end). Pins are inline, idempotent and cleared on teardown; React does not manage `grid-column` on those elements, so there is no conflict.
- **The app columns are re-scanned on every apply** and the observer also watches `childList`: if React replaces a column node while the panel is open, the pin dies with the old node — the re-scan re-pins the new node in the same cycle.
- **The panel's own track is detected by its exact value** (`state.width + "px"` at the insertion spot: index 1 on the left, the last token on the right) — the app never writes that user-tuned width at those positions, and the detection survives the CSSOM re-serializing what we wrote.
- **Structure fail-safe**: fewer than 2 in-flow columns or an undecodable template → the grid is **left untouched** (the panel floats at the edge instead of shifting the chat into the wrong track) and any leftover track of ours is undone.
- **The frame never scrolls**: the app parks its right-sidebar pane off-canvas past the frame's right edge, which leaves the `overflow:hidden` frame with scrollable overflow — a stray programmatic scroll (focus, wheel, tooling) used to shift the whole shell, our alignment included (seen live: `scrollLeft=256`). The effect zeroes `frame.scrollLeft` on mount and in a `scroll` listener.
- **Coexistence with the app's right sidebar**: when the app opens its own right sidebar (`data-rightbar-collapsed` absent), the panel **steps aside to the left automatically** — once per open episode (a manual flip back while it is open is respected). Known degradation, absent app cooperation: with the app's right sidebar open, the chat drops to the app's minimum (400px) and the app sidebar may get partially clipped — fixing that needs an upstream contract (a negotiable column slot).
- The panel honors `--dsh-frame-overlay-top` (the app's contract for overlay content under the Desktop titlebar; web fallback `0px`).
- The panel is `position:absolute` inside the frame, aligned to the inserted column. Result: opening the panel **shrinks the chat** (with the app grid transition).
- **Collapsible** (state persisted in `localStorage` `dsh-explorer.prefs`); minimized becomes a **thin pill at the screen edge, mid-height** (doesn't overlap the session log / status bar).
- **Resizable**: grip on the panel edge (1:1 drag, grid transition disabled while dragging, 260–560 px) + **vertical tree/editor divider** (20–70%, persisted).
- **Movable**: left/right flip button (arrow shows the destination); state persisted.

### 4.3 Tree

- Nodes loaded **lazily** (1 level per expansion via `fs/list`); folders first, alphabetical.
- **Hidden by default** (dotfiles, `node_modules`…) with a header toggle (persisted).
- **Icons**: folders = VS Code codicon (theme amber color, open/closed); files = **official Seti theme** (`vs-seti-icon-theme.json` + `seti.woff`), with lookup `fileNames → fileExtensions → languageIds → _default` and light/dark variants; codicon fallback while Seti loads.
- Per-item actions (hover, codicon glyphs): new file/folder (folders), duplicate (files), rename, move, delete (confirmation).
- **Watcher**: subscribes to `/explorer/events?root=…`; refresh with 300 ms debounce; expanded state preserved.
- No workspace: workspace list + "Open folder…" (`pickDirectory` + `create` + `startSession`).

### 4.4 Tabs + Monaco editor

- VS Code-style tabs (blue top on active, amber modified dot, close ×, middle-click/Ctrl+W).
- **Single Monaco flow** (avoids races): `requireMonaco → ensureThemes → creates the editor (if needed) → attaches the tab's model`; re-runs on tab/readOnly/theme change. Editor disposed on host unmount.
- Options: `lineNumbers:'on'`, minimap off, `automaticLayout`, font 13, `readOnly` per tab.
- **Optional line wrapping**: "Wrap" button in the status bar toggles `wordWrap` on/off (applied via `updateOptions`, no editor recreation); preference persisted in `dsh-explorer.prefs` (`wrap`), default off.
- **Themes**: `dark_plus.json`/`light_plus.json` are **JSONC + `include` chain** in the VS Code repo — `scripts/merge-themes.mjs` converts them into **self-contained strict JSON** (65/64 rules, bg `#1E1E1E`/`#FFFFFF`) at vendoring time. The editor is only created after `defineTheme`, with guaranteed `vs-dark`/`vs` fallback (never white on the dark theme).
- **TextMate highlighting**:
  - Provider registered **only after** the grammar loads (before that, Monaco's native tokenizer keeps provisional colors).
  - **Two-step re-tokenization**: `setModelLanguage(model,'plaintext')` → back to the original id (Monaco ignores `setLanguageId` with the same id — historical cause of "editor without colors").
  - Grammars by extension→languageId→scope (manifest); Monarch fallback when there's no grammar.
- **Ctrl+S** saves (with conflict check by `mtimeMs`/`size` → Overwrite/Reload/Cancel dialog).
- **Pure reducer + persistence**: the panel reducer has no side effects; prefs (`includeHidden`, `open`, `side`, `width`, `splitPct`) are persisted by a single `useEffect` over an in-memory cache (`loadPrefs`/`savePrefs`), no `localStorage` re-parse on every action.
- **Workspace switch**: old Monaco models are disposed (`disposeAllModels`) when changing root — the model cache is keyed by relative path and would leak/collide across workspaces.
- **Correct SSE closures**: the `EventSource` handler reads `expanded`/`includeHidden` via refs, not the effect closure (which only re-runs on root change) — post-watcher refresh always uses the current value.
- **`loadLarge` with a ceiling**: `fs/readLarge` may return `tooLarge` (50 MB cap); the client shows the banner and doesn't open the file.
- **Binary** → warning; **> 2 MB** → read-only banner with "Open anyway".
- **Quick action**: "Analyze"/"Fix" in the status bar → `sessions.binding(cur).prompt([{type:'text', text: '<Action>: <relative-path>'}], 'queue')`.

### 4.5 Status bar

- Status bar in the **theme accent color** (DSW accent) of the editor: file path, read-only/unsaved tags, Save (Ctrl+S), Analyze, Fix buttons.
- Discrete panel footer: workspace root + tab count; errors in red.

## 5. Installation (documented/reproducible)

1. pnpm is not on the system PATH: use the **local shim** (`.bin/pnpm` → `node <workspace>/.pnpm-home/node_modules/pnpm/bin/pnpm.cjs`); the npm/pnpm cache stays **inside the workspace** (`.npm-cache`) because `~/.npm` is on a read-only mount.
2. `node scripts/vendor.mjs` (downloads monaco, oniguruma, textmate, grammars, themes, codicon, seti — network required).
3. `PATH="$PWD/.bin:$PATH" dsh plugin --profile web add -w /absolute/path` (the `-w` flag is required because the profile is a pnpm workspace root).
4. **Restart `dsh web`** (client-plugin scanning and loader composition happen at boot). Changes to the **client only** (`lib/client.js`, `vendor/`) are served live with `no-cache` — just refresh the page.

## 6. Acceptance criteria (verified)

> Automated verification: `npm test` = `scripts/server-test.mjs` (72 assertions: confinement/allowlist, caps, static-route MIME, listing defaults, watcher, and the HTTP trust fence — Host/Origin/Sec-Fetch-Site on both routes) + `scripts/smoke-client.cjs` (23 assertions: loader contract, `apply` claims, disposable CSS, first render with and without a locale seat, and the docking regression — inserted track, minimal pins for the displaced columns, re-sync after the app rewrites its grid, re-pin of a React-replaced node, teardown restoring the grid, unknown-structure fail-safe and stray-frame-scroll zeroing). On Windows the symlink cases use a **junction** (`mklink /J`), so the escape coverage runs without privilege; only FIFO is left out.

- [x] Panel opens/closes, moves left/right, resizes (edge + divider); state persists.
- [x] Opening the panel **resizes the chat** (grid column).
- [x] Tree shows the session workspace; without a session, open/create flow.
- [x] Full CRUD (open, create, rename, duplicate, move, delete) with confirmations.
- [x] Monaco editor with line numbers, tabs, dirty indicator, Ctrl+S, undo/redo.
- [x] Editor theme follows the harness (Dark+ dark on the dark theme; never white).
- [x] TextMate highlighting (pipeline validated in Node: markdown/TS with correct scopes; provider registered post-grammar + forced re-tokenization).
- [x] VS Code icons: codicon (UI/folders) + Seti (files).
- [x] External conflict detected (mtime) and handled.
- [x] Watcher updates the tree when the agent creates/edits files.
- [x] Quick action sends the file path to the chat.
- [x] Writes outside the root are blocked (sandbox).
- [x] Locale follows the GUI (pt-BR when active; otherwise en/zh).

## 7. Architecture decisions (why)

- **No build**: the client bundle format is a stable contract (`__ModuleLoader__.load`); hand-writing it eliminates tsdown/config and guarantees reproducibility without a toolchain. `src/` is the single source; `lib/` is synced by `scripts/sync.mjs` (gated at `prepack`).
- **Assets served by the plugin itself**: `/explorer-assets` (DSH webServer routing) — no external CDN, works offline. **Pinned vendor** (monaco 0.56.0, oniguruma 2.0.1, textmate 9.3.2, grammars at a fixed microsoft/vscode commit) for reproducible vendoring.
- **Own RPC instead of agent tools**: instant read/write outside the conversation history; the sandbox is enforced server-side (confinement to the root **+ root allowlist: only live-session cwds or registered workspaces**).
- **JSONC → JSON at vendoring**: VS Code themes have comments and `include`; `response.json()` would fail at runtime (cause of the white editor).

## 8. Out of scope (v1)

- File drag & drop, minimap, global search (Ctrl+P), diff, git integration, multiple simultaneous roots, image preview (only a binary warning), remote multi-device editing, configurable alternative icon theme (swapping Seti is just replacing the mapping).
