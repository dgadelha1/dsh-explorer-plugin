# dsh-explorer-plugin — Marketing Summary

> **DSH File Explorer**: a VS Code-style file editor inside the DeepSeek Harness.
> Version **0.2.0** · Author: **dgadelha1** · License: **MIT**

---

## 1. What it is

**dsh-explorer-plugin** is an open-source plugin for the **DeepSeek Harness (DSH)** — DeepSeek's AI agent platform — that adds a **full file explorer + code editor, VS Code style**, directly to the web GUI, right inside the agent chat.

In practice: while the AI agent works on the session workspace, the user sees the **file tree in real time** and can **open, edit, and save** any file with professional syntax highlighting — without ever leaving the agent window.

**Problem it solves:** previously, workspace files were invisible in the GUI — users only "saw" what the agent told them. With the plugin, the workspace becomes **visible and editable**, with direct read/write (no round-trip through the LLM conversation).

---

## 2. Key features

### 📂 Full-featured file explorer
- **Workspace tree** of the current session, with on-demand (lazy) loading
- **Complete CRUD**: open, create, rename, duplicate, move, and delete files/folders
- Folders first, alphabetical ordering; hidden files (dotfiles, `node_modules`) shown optionally
- **VS Code icons**: **Seti** theme for files + **codicon** for folders and UI actions

### ✏️ Professional code editor (Monaco)
- **Monaco Editor** (the same editor powering VS Code): line numbers, multiple tabs, undo/redo, minimap
- **Real VS Code TextMate syntax highlighting** for **28 languages**: JavaScript/TypeScript (incl. React), Python, HTML/CSS/SCSS/LESS, JSON/JSONC, Markdown, YAML, Shell, C/C++, Go, Rust, Java, PHP, SQL, C#, Ruby, Lua, Swift, XML, PowerShell, Batch, INI…
- **Official VS Code Dark+ and Light+ themes** (automatically follow the GUI's light/dark theme)
- **Save with Ctrl+S**, external conflict detection with Overwrite/Reload/Cancel dialog
- Optional line wrapping, large-file support (up to 50 MB), and binary handling

### 🔄 Agent integration
- **Real-time file watcher**: if the agent creates/edits files, the tree updates by itself (SSE)
- **Quick actions "Analyze" and "Fix"**: one click sends the file path to the agent chat

### 🎨 UI integrated with the platform
- Panel **docked into the app grid** — opens/closes, **resizes the chat**, is **collapsible, resizable, and movable** (left/right)
- **100% aligned with the DSH design system**: colors entirely driven by theme tokens (zero hardcoded colors)
- **Multilingual**: follows the GUI language (English, Português, 中文)

### 🛡️ Security first
- Every operation **confined to the session workspace** (sandbox)
- Protection against path traversal and symlink escapes (`realpath` + prefix check)
- The server **validates the root on every call** — only live-session cwds or registered workspace paths are allowed (no reading `/`, `/etc`, or `~` through the API)
- Binary detection and payload size caps (anti-OOM)

---

## 3. Technologies and libraries

| Library | Version | Role |
|---|---|---|
| **monaco-editor** | 0.56.0 | Code editor (AMD build, the same one in VS Code) |
| **vscode-textmate** | 9.3.2 | TextMate grammar engine (syntax highlighting) |
| **vscode-oniguruma** | 2.0.1 | Oniguruma regex engine compiled to WebAssembly (`onig.wasm`) |
| **VS Code grammars + themes** | pinned commit `2c0f00a` of microsoft/vscode | 28 official `.tmLanguage.json` grammars + Dark+/Light+ themes |
| **Seti + codicon** | from VS Code | File and UI icons |
| **React** | via DSH runtime | Only client runtime dependency |
| **Cordis (DSH framework)** | platform | Server plugin (RPC, static routes, SSE) |
| **Node.js** | ≥ 20 | Recursive `fs.watch` (inotify) and native APIs |

**Engineering highlight:** the client bundle is **hand-written** in the DSH module format (`window.__ModuleLoader__.load`), with **zero build step and zero toolchain dependencies** — the plugin is reproducible and runs **offline** (all assets are served by the plugin itself, no external CDN; pinned versions for reproducible vendoring).

---

## 4. Architecture at a glance

```
┌───────────────────────────── dsh-explorer-plugin ─────────────────────────────┐
│                                                                               │
│  Server half (lib/index.js) — Cordis plugin                                   │
│  ├─ RPC channel /explorer  → fs/* endpoints (stat, list, read, write, create, │
│  │                          rename, move, delete) — direct, no LLM round-trip │
│  ├─ Static routes /explorer-assets → Monaco, Oniguruma, grammars, themes      │
│  └─ SSE /explorer/events → real-time file watcher (fs.watch)                  │
│                                                                               │
│  Client half (lib/client.js) — hand-written bundle, no build                  │
│  ├─ Panel docked into the app grid (collapsible, movable, resizable)          │
│  ├─ File tree with Seti/codicon icons                                         │
│  └─ Monaco editor + tabs + TextMate + quick actions (Analyze/Fix)             │
│                                                                               │
│  Vendored assets (vendor/) — monaco, onig, textmate, grammars, themes,        │
│  codicon, seti — served at runtime, work offline                              │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Communication**: server↔client RPC over the `/explorer` channel — **instant** read/write, kept out of the conversation history
- **No build step**: `src/` is the single source; `lib/` is synced by `scripts/sync.mjs` (gated at `prepack`)
- **Testing**: server regression (sandbox/allowlist, caps, crash-free watcher), Node bundle smoke test, and a headless TextMate pipeline test (Puppeteer + Firefox)

---

## 5. Installation (to try it out)

```bash
# 1. Download the vendored assets (network required)
node scripts/vendor.mjs

# 2. Add the plugin to the DSH web profile
dsh plugin --profile web add -w /absolute/path/to/plugin

# 3. Restart dsh web
```

---

## 6. Authors and license

- **Author:** [dgadelha1](https://github.com/dgadelha1) — sole author/contributor
- **Repository:** [github.com/dgadelha1/dsh-explorer-plugin](https://github.com/dgadelha1/dsh-explorer-plugin)
- **License:** **MIT** — Copyright (c) 2026 dgadelha1
  - Free for personal, commercial, and modified use
  - Just keep the copyright notice
  - Software provided "as is", without warranty
- **Status:** version 0.2.0, open source (private on npm; installed via the DSH plugin system)

---

## 7. Ready-to-use taglines

> "Bring the power of VS Code into your AI agent: edit the workspace in real time while the agent works."

> "The DeepSeek Harness now has a professional code editor — real syntax highlighting, Dark+/Light+ themes, a file watcher, and AI quick actions — all integrated into the chat."

> "Open source, MIT, offline-first, and 100% aligned with the DSH design system."
