/**
 * dsh-explorer-plugin — client half.
 *
 * Hand-written bundle in the DSH client-module format (no build step):
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * The factory requires only `react`; everything else comes from the client
 * runtime services handed to apply(ctx): slots, layout, connection, sessions,
 * workspaces, locale, theme.
 *
 * Runtime assets (monaco AMD build, oniguruma wasm, TextMate grammars, VS Code
 * themes, codicon font) are served by the server half under /explorer-assets.
 */
window.__ModuleLoader__.load({
	id: "dsh-explorer-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;
		var useMemo = React.useMemo, useCallback = React.useCallback, useReducer = React.useReducer;
		var useSyncExternalStore = React.useSyncExternalStore;

		// ───────────────────────── helpers ─────────────────────────
		function h(tag, props, ...children) { return React.createElement(tag, props, ...children); }
		function cx() { var out = []; for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]); return out.join(" "); }
		function baseName(p) { var i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
		function dirName(p) { var i = p.lastIndexOf("/"); return i <= 0 ? "." : p.slice(0, i); }
		function debounce(fn, ms) { var t = null; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); }; }
		function fmtBytes(n) {
			if (n < 1024) return n + " B";
			if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
			return (n / (1024 * 1024)).toFixed(1) + " MB";
		}
		function extOf(p) { var m = /\.([^.\\/]+)$/.exec(p); return m ? m[1].toLowerCase() : ""; }

		// ───────────────────────── codicon glyphs (VS Code font) ─────────────────────────
		var GLYPH = {
			"chevron-right": "\ueab6",
			"chevron-down": "\ueab4",
			close: "\uea76",
			refresh: "\ueb37",
			file: "\uea7b",
			"file-code": "\ueae9",
			"file-binary": "\ueae8",
			"file-media": "\ueaea",
			"file-pdf": "\ueaeb",
			"file-zip": "\ueaef",
			folder: "\uea83",
			"folder-opened": "\ueaf7",
			"new-file": "\uea7f",
			"new-folder": "\uea80",
			edit: "\uea73",
			trash: "\uea81",
			copy: "\uebcc",
			"arrow-left": "\uea9b",
			"arrow-right": "\uea9c",
			eye: "\uea70",
			"eye-closed": "\ueae7",
			grabber: "\ueb02",
			files: "\ueaf0",
			window: "\ueb7f",
		};
		function icon(name) { return h("span", { className: "dx-icon", "aria-hidden": true }, GLYPH[name] || ""); }

		// ───────────────────────── file icons (VS Code default "Seti" theme) ─────────────────────────
		var setiTheme = null;
		var setiWaiters = [];
		function ensureSeti() {
			if (setiTheme) return Promise.resolve(setiTheme);
			return fetch("/explorer-assets/seti/vs-seti-icon-theme.json").then(function (r) { return r.json(); }).then(function (j) {
				setiTheme = j;
				setiWaiters.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
				setiWaiters = [];
				return j;
			}).catch(function (e) {
				console.error("[dsh-explorer] seti icon theme failed to load", e);
				return null;
			});
		}
		function onSetiReady(fn) {
			if (setiTheme) { fn(); return function () {}; }
			setiWaiters.push(fn);
			return function () {
				var i = setiWaiters.indexOf(fn);
				if (i >= 0) setiWaiters.splice(i, 1);
			};
		}
		// "\E051" (JSON string) -> the actual glyph char. fromCodePoint (not
		// fromCharCode) so codepoints above U+FFFF (astral / non-BMP) survive.
		function glyphChar(def) {
			var fc = (def && def.fontCharacter) || "";
			var hex = fc.replace(/^\\+[uU]?/, "");
			var code = parseInt(hex, 16);
			return isNaN(code) ? "" : String.fromCodePoint(code);
		}
		function setiIconDef(path, isLight) {
			if (!setiTheme) return null;
			var name = baseName(path);
			var key = setiTheme.fileNames[name] || setiTheme.fileExtensions[extOf(path)] || setiTheme.languageIds[langForPath(path)] || setiTheme.file;
			if (isLight) {
				var lk = key + "_light";
				if (setiTheme.iconDefinitions[lk]) key = lk;
				else if (setiTheme.light && setiTheme.light.file && key === setiTheme.file && setiTheme.iconDefinitions[setiTheme.light.file]) key = setiTheme.light.file;
			}
			return setiTheme.iconDefinitions[key] || null;
		}
		function fileIcon(path, isLight) {
			var def = setiIconDef(path, isLight);
			if (def) {
				// The glyph color comes from the Seti icon theme itself; when a
				// definition has no fontColor, fall back to a themed neutral.
				var style = def.fontColor ? { color: def.fontColor } : null;
				return h("span", {
					className: cx("dx-ic dx-seti", !def.fontColor && "dx-seti-fallback"),
					style: style,
					"aria-hidden": true,
				}, glyphChar(def));
			}
			// fallback (seti not loaded yet): codicon file glyph, themed color
			return h("span", { className: "dx-ic dx-icon dx-file", "aria-hidden": true }, GLYPH.file);
		}
		function folderIcon(open) {
			return h("span", { className: "dx-ic dx-icon dx-folder", "aria-hidden": true }, GLYPH[open ? "folder-opened" : "folder"]);
		}

		// ───────────────────────── styles ─────────────────────────
		var CSS = `
@font-face{font-family:"codicon";font-display:block;src:url("/explorer-assets/codicon/codicon.ttf") format("truetype")}
@font-face{font-family:"seti";font-display:block;src:url("/explorer-assets/seti/seti.woff") format("woff")}
.dx-overlay{position:absolute;top:0;bottom:0;z-index:2147483000;pointer-events:none}
.dx-overlay.dx-left{left:0}
.dx-overlay.dx-right{right:0}
/* Every color below comes from the DSH design-system theme (--dsw-* tokens):
   nothing is hardcoded, so the panel follows the active light/dark theme. */
.dx-panel{position:absolute;top:0;bottom:0;pointer-events:auto;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;box-shadow:0 0 24px var(--dsw-alias-bg-mask-1)}
.dx-left .dx-panel{border-right:1px solid var(--dsw-alias-border-l2)}
.dx-right .dx-panel{border-left:1px solid var(--dsw-alias-border-l2)}
.dx-icon{font:normal normal normal 16px/1 codicon;display:inline-block;text-align:center;text-decoration:none;text-rendering:auto;-webkit-font-smoothing:antialiased;user-select:none;flex:none}
.dx-seti{font-family:seti;font-size:17px;line-height:1;display:inline-block;text-align:center;text-rendering:auto;-webkit-font-smoothing:antialiased;user-select:none;flex:none}
.dx-seti-fallback{color:var(--dsw-alias-label-secondary)}
.dx-file{color:var(--dsw-alias-label-tertiary)}

/* header */
.dx-header{display:flex;align-items:center;height:36px;padding:0 6px 0 12px;flex:none;gap:1px}
.dx-title{flex:1;min-width:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none}
.dx-tbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;flex:none;font-size:15px}
.dx-tbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dx-tbtn:disabled{opacity:.35;cursor:default}
.dx-tbtn:disabled:hover{background:transparent}

/* body: tree / split / editor */
.dx-body{flex:1;min-height:0;display:flex;flex-direction:column}
.dx-tree-wrap{flex:0 1 auto;min-height:48px;overflow:auto;overflow-x:hidden;padding:2px 0 6px;scrollbar-width:thin}
.dx-split{flex:none;height:5px;cursor:ns-resize;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-caption);background:transparent}
.dx-split:hover,.dx-split.dx-drag{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent);color:var(--dsw-alias-state-business-primary)}
.dx-editor-wrap{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;position:relative;border-top:1px solid var(--dsw-alias-border-l2)}
.dx-editor-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:12px;user-select:none}

/* tree */
.dx-row{position:relative;display:flex;align-items:center;height:22px;padding-right:6px;cursor:pointer;white-space:nowrap;margin:0 0 0 6px}
.dx-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dx-row.dx-selected{background:var(--dsw-alias-interactive-bg-active)}
.dx-row.dx-selected::before{content:"";position:absolute;left:-6px;top:0;bottom:0;width:2px;background:var(--dsw-alias-state-business-primary)}
.dx-chev{width:18px;height:22px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);cursor:pointer;border:none;background:transparent;padding:0;font-size:11px}
.dx-chev:hover{color:var(--dsw-alias-label-primary)}
.dx-chev.dx-spacer{visibility:hidden;cursor:default}
.dx-ic{flex:none;width:20px;text-align:center;font-size:16px;user-select:none}
.dx-folder{color:var(--dsw-alias-state-warn-primary)}
.dx-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;padding-left:6px;font-size:13px}
.dx-actions{display:none;gap:0;flex:none;align-items:center}
.dx-row:hover .dx-actions{display:inline-flex}
.dx-act{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;border-radius:4px;padding:0;opacity:.85}
.dx-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);opacity:1}
.dx-inline{flex:1;min-width:0;margin:0 6px 2px 24px;display:flex;gap:4px}
.dx-inline input{flex:1;min-width:0;font:inherit;color:inherit;background:var(--dsw-alias-bg-mask-2);border:1px solid var(--dsw-alias-state-business-primary);border-radius:3px;padding:2px 6px;outline:none}

/* tabs (VS Code style) — deliberately slim: half-height, discreet */
.dx-tabs{display:flex;flex:none;overflow-x:auto;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);scrollbar-width:thin}
.dx-tab{display:inline-flex;align-items:center;gap:4px;max-width:120px;height:18px;padding:0 4px 0 7px;border-right:1px solid var(--dsw-alias-border-l1);border-top:1px solid transparent;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary);flex:none;white-space:nowrap;user-select:none}
.dx-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dx-tab.dx-active{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border-top:2px solid var(--dsw-alias-state-business-primary)}
.dx-tabname{overflow:hidden;text-overflow:ellipsis}
.dx-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none;display:none}
.dx-tab.dx-dirty .dx-dot{display:inline-block}
.dx-tabclose{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:11px;padding:0;border-radius:3px;opacity:.8;flex:none}
.dx-tabclose .dx-icon{font:normal normal normal 12px/1 codicon}
.dx-tabclose:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}

/* editor */
.dx-editor{flex:1;min-height:0;position:relative}
.dx-editor-root{position:absolute;inset:0}
.dx-editor-fail{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-state-error-primary);font-size:12px;padding:16px;text-align:center}
.dx-banner{position:absolute;top:0;left:0;right:0;z-index:10;display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--dsw-alias-state-warn-tertiary);border-bottom:1px solid var(--dsw-alias-state-warn-secondary);font-size:12px;color:inherit;flex-wrap:wrap}
.dx-banner .dx-btns{margin-left:auto;display:flex;gap:6px}

/* status bar (accent color of the active theme) */
.dx-status{flex:none;display:flex;align-items:center;gap:8px;height:22px;padding:0 10px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-static-neutral-00);font-size:12px;white-space:nowrap;overflow:hidden}
.dx-status .dx-status-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;opacity:.95}
.dx-status .dx-status-err{color:var(--dsw-alias-state-error-secondary);overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.dx-sbtn{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border:none;border-radius:3px;background:color-mix(in srgb,var(--dsw-static-neutral-00) 14%,transparent);color:var(--dsw-static-neutral-00);cursor:pointer;font-size:12px;flex:none}
.dx-sbtn:hover{background:color-mix(in srgb,var(--dsw-static-neutral-00) 26%,transparent)}
.dx-sbtn.dx-on{background:color-mix(in srgb,var(--dsw-static-neutral-00) 26%,transparent);box-shadow:inset 0 0 0 1px var(--dsw-static-neutral-00)}
.dx-sbtn:disabled{opacity:.45;cursor:default}
.dx-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:1px solid color-mix(in srgb,var(--dsw-static-neutral-00) 40%,transparent);border-radius:3px;font-size:10px;text-transform:uppercase;letter-spacing:.4px;flex:none;opacity:.9}
.dx-tag.dx-warn{border-color:var(--dsw-alias-state-warn-secondary);color:var(--dsw-alias-state-warn-secondary)}
.dx-footer{flex:none;display:flex;align-items:center;gap:8px;height:22px;padding:0 10px;font-size:11px;color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l2);white-space:nowrap;overflow:hidden}
.dx-footer .dx-status-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dx-footer .dx-status-err{color:var(--dsw-alias-state-error-primary);overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}

/* no-workspace */
.dx-nosession{display:flex;flex-direction:column;gap:6px;padding:14px 12px;overflow:auto}
.dx-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;padding:0 4px}
.dx-btn{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-elevated-fill);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:4px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.dx-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dx-wsrow{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer}
.dx-wsrow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dx-wsrow .dx-path{font-size:11px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dx-wsrow .dx-wsicon{color:var(--dsw-alias-state-warn-primary);font-size:16px}

/* dialog */
.dx-dialog{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1);pointer-events:auto}
.dx-dialogbox{background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:16px;max-width:380px;width:90%;box-shadow:0 8px 32px var(--dsw-alias-bg-mask-3);font-size:13px}
.dx-dlg-title{font-weight:600;margin-bottom:10px}
.dx-dlg-body{margin-bottom:14px;opacity:.92;word-break:break-word}
.dx-dlg-actions{display:flex;justify-content:flex-end;gap:8px}
.dx-danger{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}
.dx-danger:hover{background:var(--dsw-alias-state-error-secondary)}
.dx-dialogbox input{flex:1;min-width:0;font:inherit;color:inherit;background:var(--dsw-alias-bg-mask-2);border:1px solid var(--dsw-alias-state-business-primary);border-radius:4px;padding:4px 8px;outline:none}

/* reopen toggle: slim pill docked to the screen edge, mid-height */
.dx-toggle{position:fixed;top:50%;transform:translateY(-50%);z-index:2147483000;display:inline-flex;align-items:center;justify-content:center;width:24px;height:46px;border:none;cursor:pointer;font-size:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-specific-sidebar-fill);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 2px 8px var(--dsw-alias-bg-mask-1)}
.dx-toggle.dx-tleft{left:0;border-left:none;border-radius:0 8px 8px 0}
.dx-toggle.dx-tright{right:0;border-right:none;border-radius:8px 0 0 8px}
.dx-toggle:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 28%,transparent)}

/* edge resize grip */
.dx-resize{position:absolute;top:0;bottom:0;width:6px;cursor:ew-resize;z-index:6;pointer-events:auto}
.dx-resize.dx-rleft{left:-3px}
.dx-resize.dx-rright{right:-3px}
.dx-resize::after{content:"";position:absolute;top:0;bottom:0;width:1px;background:transparent;transition:background .12s}
.dx-resize.dx-rleft::after{left:2px}
.dx-resize.dx-rright::after{right:2px}
.dx-resize:hover::after,.dx-resize.dx-drag::after{background:var(--dsw-alias-state-business-primary)}
.dx-spin{display:inline-block;animation:dxspin 1s linear infinite}
@keyframes dxspin{to{transform:rotate(360deg)}}
`;
		(function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin="dsh-explorer-plugin"]')) return;
			var s = document.createElement("style");
			s.setAttribute("data-plugin", "dsh-explorer-plugin");
			s.textContent = CSS;
			document.head.appendChild(s);
		})();

		// ───────────────────────── locale ─────────────────────────
		var NS = "explorer";
		var dict = {
			pt: {
				"panel.title": "Explorador",
				"panel.collapse": "Recolher painel",
				"panel.expand": "Abrir explorador",
				"panel.moveLeft": "Mover para a esquerda",
				"panel.moveRight": "Mover para a direita",
				"panel.refresh": "Atualizar",
				"panel.toggleHidden": "Mostrar arquivos ocultos",
				"panel.newFile": "Novo arquivo na raiz",
				"panel.newFolder": "Nova pasta na raiz",
				"tree.empty": "Pasta vazia",
				"tree.loading": "Carregando…",
				"tree.noWorkspace": "Nenhum workspace aberto.",
				"tree.openFolder": "Abrir pasta…",
				"tree.chooseWorkspace": "Escolha um workspace:",
				"tree.newFile": "Novo arquivo",
				"tree.newFolder": "Nova pasta",
				"tree.rename": "Renomear",
				"tree.duplicate": "Duplicar",
				"tree.move": "Mover",
				"tree.delete": "Excluir",
				"tree.confirmDeleteTitle": "Excluir?",
				"tree.confirmDeleteBody": "Excluir {name}? Esta ação não pode ser desfeita.",
				"tree.confirmMoveBody": "Mover para o diretório (caminho relativo à raiz):",
				"tree.renamePlaceholder": "Novo nome",
				"tree.newPlaceholder": "Nome do arquivo",
				"tree.newFolderPlaceholder": "Nome da pasta",
				"tree.movePlaceholder": "ex.: src/components",
				"editor.save": "Salvar",
				"editor.saved": "Salvo",
				"editor.unsaved": "Não salvo",
				"editor.readOnly": "Somente leitura",
				"editor.binary": "Arquivo binário — não é possível abrir no editor.",
				"editor.tooLarge": "Arquivo muito grande ({size}).",
				"editor.loadAnyway": "Abrir mesmo assim (somente leitura)",
				"editor.placeholder": "Selecione um arquivo para visualizar",
				"editor.conflictTitle": "Arquivo mudou no disco",
				"editor.conflictBody": "{name} foi modificado fora do editor. O que deseja fazer?",
				"editor.overwrite": "Sobrescrever",
				"editor.reload": "Recarregar",
				"editor.analyze": "Analisar",
				"editor.fix": "Corrigir",
				"editor.wrap": "Quebra de linha",
				"editor.wrapShort": "Quebra",
				"editor.sendHint": "Enviar caminho para o agente",
				"editor.noSession": "Nenhuma sessão ativa para enviar ao agente.",
				"editor.loadFailed": "Falha ao carregar o editor: {error}",
				"common.ok": "OK",
				"common.cancel": "Cancelar",
				"common.delete": "Excluir",
				"status.root": "{root}",
			},
			en: {
				"panel.title": "Explorer",
				"panel.collapse": "Collapse panel",
				"panel.expand": "Open explorer",
				"panel.moveLeft": "Move to left",
				"panel.moveRight": "Move to right",
				"panel.refresh": "Refresh",
				"panel.toggleHidden": "Show hidden files",
				"panel.newFile": "New file in root",
				"panel.newFolder": "New folder in root",
				"tree.empty": "Empty folder",
				"tree.loading": "Loading…",
				"tree.noWorkspace": "No workspace open.",
				"tree.openFolder": "Open folder…",
				"tree.chooseWorkspace": "Choose a workspace:",
				"tree.newFile": "New file",
				"tree.newFolder": "New folder",
				"tree.rename": "Rename",
				"tree.duplicate": "Duplicate",
				"tree.move": "Move",
				"tree.delete": "Delete",
				"tree.confirmDeleteTitle": "Delete?",
				"tree.confirmDeleteBody": "Delete {name}? This cannot be undone.",
				"tree.confirmMoveBody": "Move to directory (path relative to root):",
				"tree.renamePlaceholder": "New name",
				"tree.newPlaceholder": "File name",
				"tree.newFolderPlaceholder": "Folder name",
				"tree.movePlaceholder": "e.g. src/components",
				"editor.save": "Save",
				"editor.saved": "Saved",
				"editor.unsaved": "Unsaved",
				"editor.readOnly": "Read-only",
				"editor.binary": "Binary file — cannot be opened in the editor.",
				"editor.tooLarge": "File too large ({size}).",
				"editor.loadAnyway": "Open anyway (read-only)",
				"editor.placeholder": "Select a file to view",
				"editor.conflictTitle": "File changed on disk",
				"editor.conflictBody": "{name} was modified outside the editor. What do you want to do?",
				"editor.overwrite": "Overwrite",
				"editor.reload": "Reload",
				"editor.analyze": "Analyze",
				"editor.fix": "Fix",
				"editor.wrap": "Word wrap",
				"editor.wrapShort": "Wrap",
				"editor.sendHint": "Send path to the agent",
				"editor.noSession": "No active session to send to the agent.",
				"editor.loadFailed": "Failed to load the editor: {error}",
				"common.ok": "OK",
				"common.cancel": "Cancel",
				"common.delete": "Delete",
				"status.root": "{root}",
			},
			zh: {
				"panel.title": "资源管理器",
				"panel.collapse": "折叠面板",
				"panel.expand": "打开资源管理器",
				"panel.moveLeft": "移到左侧",
				"panel.moveRight": "移到右侧",
				"panel.refresh": "刷新",
				"panel.toggleHidden": "显示隐藏文件",
				"panel.newFile": "根目录新建文件",
				"panel.newFolder": "根目录新建文件夹",
				"tree.empty": "空文件夹",
				"tree.loading": "加载中…",
				"tree.noWorkspace": "未打开工作区。",
				"tree.openFolder": "打开文件夹…",
				"tree.chooseWorkspace": "选择工作区：",
				"tree.newFile": "新建文件",
				"tree.newFolder": "新建文件夹",
				"tree.rename": "重命名",
				"tree.duplicate": "复制",
				"tree.move": "移动",
				"tree.delete": "删除",
				"tree.confirmDeleteTitle": "删除？",
				"tree.confirmDeleteBody": "删除 {name}？此操作无法撤销。",
				"tree.confirmMoveBody": "移动到目录（相对根的路径）：",
				"tree.renamePlaceholder": "新名称",
				"tree.newPlaceholder": "文件名",
				"tree.newFolderPlaceholder": "文件夹名",
				"tree.movePlaceholder": "例如 src/components",
				"editor.save": "保存",
				"editor.saved": "已保存",
				"editor.unsaved": "未保存",
				"editor.readOnly": "只读",
				"editor.binary": "二进制文件 — 无法在编辑器中打开。",
				"editor.tooLarge": "文件过大（{size}）。",
				"editor.loadAnyway": "仍然打开（只读）",
				"editor.placeholder": "选择文件进行查看",
				"editor.conflictTitle": "文件已在磁盘上更改",
				"editor.conflictBody": "{name} 已在编辑器外被修改。您想怎么做？",
				"editor.overwrite": "覆盖",
				"editor.reload": "重新加载",
				"editor.analyze": "分析",
				"editor.fix": "修复",
				"editor.wrap": "自动换行",
				"editor.wrapShort": "换行",
				"editor.sendHint": "将路径发送给代理",
				"editor.noSession": "没有可发送给代理的活动会话。",
				"editor.loadFailed": "加载编辑器失败：{error}",
				"common.ok": "确定",
				"common.cancel": "取消",
				"common.delete": "删除",
				"status.root": "{root}",
			},
		};

		// ───────────────────────── rpc ─────────────────────────
		function rpcErrorOf(error) {
			var e = new Error((error && error.message) || "unknown error");
			e.code = error && error.code;
			return e;
		}
		async function callRpc(ctx, endpoint, payload) {
			var result = await ctx.connection.rpc.call("/explorer", endpoint, payload);
			if (!result || result.ok !== true) throw rpcErrorOf(result && result.error);
			return result.value;
		}

		// ───────────────────────── persistence ─────────────────────────
		// One in-memory cache, loaded once: saves merge onto it instead of
		// re-parsing localStorage on every action (cheap + no lost updates).
		var PREFS_KEY = "dsh-explorer.prefs";
		var prefsCache = null;
		function loadPrefs() {
			if (prefsCache) return prefsCache;
			try { prefsCache = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { prefsCache = {}; }
			return prefsCache;
		}
		function savePrefs(p) {
			prefsCache = p;
			try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* private mode */ }
		}

		// ───────────────────────── monaco loader ─────────────────────────
		var monacoPromise = null;
		function ensureMonaco() {
			if (monacoPromise) return monacoPromise;
			monacoPromise = new Promise(function (resolve, reject) {
				function boot() {
					var req = window.require;
					if (typeof req !== "function" || typeof req.config !== "function") { reject(new Error("monaco loader not available")); return; }
					req.config({ paths: { vs: "/explorer-assets/monaco/vs" } });
					req(["vs/editor/editor.main"], function () { resolve(window.monaco); }, function (err) { reject(err || new Error("monaco failed to load")); });
				}
				if (typeof window.require === "function" && typeof window.require.config === "function") { boot(); return; }
				var s = document.createElement("script");
				s.src = "/explorer-assets/monaco/vs/loader.js";
				s.async = true;
				s.onload = boot;
				s.onerror = function () { monacoPromise = null; reject(new Error("failed to load monaco loader")); };
				document.head.appendChild(s);
			});
			return monacoPromise;
		}

		// ───────────────────────── textmate ─────────────────────────
		function loadScript(src) {
			return new Promise(function (res, rej) {
				var s = document.createElement("script");
				s.src = src;
				s.async = true;
				s.onload = function () { res(); };
				s.onerror = function () { rej(new Error("failed to load " + src)); };
				document.head.appendChild(s);
			});
		}
		var textmateReady = null;
		// Boot the TextMate pipeline once: load the UMD scripts (oniguruma +
		// vscode-textmate), compile the oniguruma WASM from bytes (fetched as
		// ArrayBuffer — avoids MIME pitfalls of .wasm module loading), then
		// build a Registry whose loadGrammar fetches our vendored grammars.
		function ensureTextmate() {
			if (textmateReady) return textmateReady;
			textmateReady = (async function () {
				await Promise.all([
					loadScript("/explorer-assets/onig/main.js"),
					loadScript("/explorer-assets/textmate/main.js"),
				]);
				var onig = window.onig;
				var tm = window.vscodetextmate;
				if (!onig || !tm) throw new Error("textmate scripts missing");
				var wasm = await (await fetch("/explorer-assets/onig/onig.wasm")).arrayBuffer();
				await onig.loadWASM({ data: wasm });
				var registry = new tm.Registry({
					onigLib: Promise.resolve({
						createOnigScanner: function (patterns) { return new onig.OnigScanner(patterns); },
						createOnigString: function (s) { return new onig.OnigString(s); },
					}),
					loadGrammar: async function (scopeName) {
						var meta = grammarByScope && grammarByScope[scopeName];
						if (!meta) return null;
						var raw = await (await fetch("/explorer-assets/grammars/" + meta)).text();
						return tm.parseRawGrammar(raw, meta);
					},
				});
				return { registry: registry };
			})().catch(function (e) { textmateReady = null; throw e; });
			return textmateReady;
		}

		var grammarByScope = null; // scope -> grammar file
		var grammarPromises = {}; // scope -> Promise<grammar>
		var loadedGrammars = {}; // scope -> grammar (sync access for tokenize)
		var providerInstalled = {}; // langId -> true

		function ensureManifest() {
			if (grammarByScope) return Promise.resolve(grammarByScope);
			return fetch("/explorer-assets/grammars/manifest.json").then(function (r) { return r.json(); }).then(function (m) {
				grammarByScope = {};
				Object.keys(m).forEach(function (file) { grammarByScope[m[file]] = file; });
				return grammarByScope;
			});
		}
		function ensureGrammar(scope) {
			if (!grammarPromises[scope]) {
				grammarPromises[scope] = ensureTextmate().then(function (t) {
					return t.registry.loadGrammar(scope);
				}).then(function (g) {
					if (!g) throw new Error("no grammar for " + scope);
					loadedGrammars[scope] = g;
					notifyGrammarReady(scope);
					return g;
				});
			}
			return grammarPromises[scope];
		}

		// ── language mapping ──
		var EXT_TO_LANG = {
			js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
			ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact",
			py: "python", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
			json: "json", jsonc: "jsonc", md: "markdown", markdown: "markdown", yaml: "yaml", yml: "yaml",
			sh: "shell", bash: "shell", zsh: "shell", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
			go: "go", rs: "rust", java: "java", xml: "xml", svg: "xml", php: "php", sql: "sql",
			ini: "ini", cfg: "ini", cs: "csharp", rb: "ruby", lua: "lua", swift: "swift",
			bat: "bat", cmd: "bat", ps1: "powershell", txt: "plaintext", log: "plaintext",
			gitignore: "plaintext", env: "plaintext", editorconfig: "plaintext",
		};
		var LANG_GRAMMAR = {
			javascript: "JavaScript.tmLanguage.json",
			javascriptreact: "JavaScriptReact.tmLanguage.json",
			typescript: "TypeScript.tmLanguage.json",
			typescriptreact: "TypeScriptReact.tmLanguage.json",
			python: "python.tmLanguage.json",
			html: "html.tmLanguage.json",
			css: "css.tmLanguage.json",
			scss: "scss.tmLanguage.json",
			less: "less.tmLanguage.json",
			json: "json.tmLanguage.json",
			jsonc: "jsonc.tmLanguage.json",
			markdown: "markdown.tmLanguage.json",
			yaml: "yaml.tmLanguage.json",
			shell: "shell-unix-bash.tmLanguage.json",
			c: "cpp.tmLanguage.json",
			cpp: "cpp.tmLanguage.json",
			go: "go.tmLanguage.json",
			rust: "rust.tmLanguage.json",
			java: "java.tmLanguage.json",
			xml: "xml.tmLanguage.json",
			php: "php.tmLanguage.json",
			sql: "sql.tmLanguage.json",
			ini: "ini.tmLanguage.json",
			csharp: "csharp.tmLanguage.json",
			ruby: "ruby.tmLanguage.json",
			lua: "lua.tmLanguage.json",
			swift: "swift.tmLanguage.json",
			bat: "bat.tmLanguage.json",
			powershell: "powershell.tmLanguage.json",
		};
		function langForPath(p) { var e = extOf(p); return EXT_TO_LANG[e] || "plaintext"; }

		var monaco = null;
		function requireMonaco() { return ensureMonaco().then(function (m) { monaco = m; return m; }); }

		function ensureLangRegistered(langId) {
			if (!monaco) return;
			if (langId === "javascriptreact" || langId === "typescriptreact" || langId === "jsonc") {
				var already = false;
				try { already = !!monaco.languages.getLanguages().some(function (l) { return l.id === langId; }); } catch (e) { already = false; }
				if (!already) monaco.languages.register({ id: langId });
			}
		}

		function installProvider(langId) {
			if (providerInstalled[langId]) return;
			providerInstalled[langId] = true;
			var file = LANG_GRAMMAR[langId];
			if (!file) return;
			ensureManifest().then(function () {
				var scope = Object.keys(grammarByScope).find(function (s) { return grammarByScope[s] === file; });
				if (!scope) return;
				// Register the TextMate tokens provider only AFTER the grammar is
				// actually loaded: until then Monaco's built-in tokenizer keeps
				// producing colors (no blank-editor flash).
				ensureGrammar(scope).then(function () {
					monaco.languages.setTokensProvider(langId, {
						getInitialState: function () { return { stack: null }; },
						tokenize: function (line, state) {
							var g = loadedGrammars[scope];
							if (!g) return { tokens: [], endState: state };
							var res = g.tokenizeLine(line, state.stack || null);
							var tokens = [];
							for (var i = 0; i < res.tokens.length; i++) {
								tokens.push({ startIndex: res.tokens[i].startIndex, scopes: res.tokens[i].scopes.join(" ") });
							}
							return { tokens: tokens, endState: { stack: res.ruleStack } };
						},
					});
					retokenizeModels(langId);
				}).catch(function (e) {
					console.error("[dsh-explorer] textmate grammar failed for", langId, e);
				});
			});
		}

		// Force open models to re-tokenize with the (now registered) TextMate
		// provider. Monaco's setModelLanguage is a no-op when the language id is
		// unchanged, so we bounce through "plaintext" to invalidate the cache.
		function retokenizeModels(langId) {
			Object.keys(modelCache).forEach(function (path) {
				var rec = modelCache[path];
				if (!rec) return;
				if (langId && rec.model.getLanguageId() !== langId) return;
				try {
					var id = rec.model.getLanguageId();
					monaco.editor.setModelLanguage(rec.model, "plaintext");
					monaco.editor.setModelLanguage(rec.model, id);
				} catch (e) { /* ignore */ }
			});
		}

		// Re-tokenize open models once their TextMate grammar finishes loading.
		var grammarReadyListeners = [];
		function notifyGrammarReady(scope) {
			for (var i = 0; i < grammarReadyListeners.length; i++) {
				try { grammarReadyListeners[i](scope); } catch (e) { /* ignore */ }
			}
		}
		function onGrammarReady(fn) {
			grammarReadyListeners.push(fn);
			return function () {
				var i = grammarReadyListeners.indexOf(fn);
				if (i >= 0) grammarReadyListeners.splice(i, 1);
			};
		}

		// ───────────────────────── themes ─────────────────────────
		var themesDefined = { dark: false, light: false };
		var themeReady = null;
		function ensureThemes() {
			if (themeReady) return themeReady;
			themeReady = requireMonaco().then(function () {
				return Promise.all(["dark_plus.json", "light_plus.json"].map(async function (name) {
					var json = await (await fetch("/explorer-assets/themes/" + name)).json();
					var converted = convertVscodeTheme(json);
					var key = name === "dark_plus.json" ? "dark" : "light";
					monaco.editor.defineTheme(key === "dark" ? "dsh-explorer-dark" : "dsh-explorer-light", converted);
					themesDefined[key] = true;
				}));
			});
			return themeReady;
		}
		function convertVscodeTheme(t) {
			var rules = [];
			var tokenColors = t.tokenColors || [];
			for (var i = 0; i < tokenColors.length; i++) {
				var rc = tokenColors[i];
				var scopes = rc.scope == null ? [""] : (Array.isArray(rc.scope) ? rc.scope : [rc.scope]);
				var settings = rc.settings || {};
				for (var j = 0; j < scopes.length; j++) {
					var rule = { token: scopes[j] };
					if (settings.foreground) rule.foreground = settings.foreground;
					if (settings.fontStyle) rule.fontStyle = settings.fontStyle;
					rules.push(rule);
				}
			}
			var bg = (t.colors || {})["editor.background"] || "";
			var bgLum = parseInt(bg.replace("#", ""), 16);
			var isLight = t.type === "light" || (!isNaN(bgLum) && bgLum > 0x888888);
			return {
				base: isLight ? "vs" : "vs-dark",
				inherit: true,
				rules: rules,
				colors: t.colors || {},
			};
		}

		// ───────────────────────── model cache ─────────────────────────
		var modelCache = {}; // path -> { model, langId }
		var suppressDirty = {}; // path -> true while programmatic setValue
		var dirtyHandler = null;
		function setDirtyHandler(fn) { dirtyHandler = fn; }

		// Build a valid file:// URI. encodeURI leaves '#', '?', '&', '=' intact,
		// which would make the model address ambiguous — encode per segment.
		function uriForPath(path) {
			return "file:///" + String(path).split("/").map(function (seg) { return encodeURIComponent(seg); }).join("/");
		}

		// Dispose every cached Monaco model (workspace switch / teardown).
		function disposeAllModels() {
			Object.keys(modelCache).forEach(function (path) {
				var rec = modelCache[path];
				if (rec && rec.model) { try { rec.model.dispose(); } catch (e) { /* ignore */ } }
			});
			modelCache = {};
			suppressDirty = {};
		}

		function getOrCreateModel(path, content, langId) {
			var rec = modelCache[path];
			if (rec) return rec.model;
			var model = monaco.editor.createModel(content, langId, monaco.Uri.parse(uriForPath(path)));
			modelCache[path] = { model: model, langId: langId };
			model.onDidChangeContent(function () {
				if (suppressDirty[path]) return;
				if (dirtyHandler) dirtyHandler(path);
			});
			return model;
		}

		// ───────────────────────── state ─────────────────────────
		function initialState() {
			var prefs = loadPrefs();
			return {
				root: null,
				includeHidden: !!prefs.includeHidden,
				entries: {},
				loading: {},
				expanded: {},
				tabs: [],
				activePath: null,
				panelOpen: prefs.open !== false,
				side: prefs.side === "right" ? "right" : "left",
				width: Math.min(Math.max(prefs.width || 320, 260), 560),
				splitPct: Math.min(Math.max(prefs.splitPct || 42, 20), 70),
				wrap: !!prefs.wrap,
				panelOffset: 0,
				notice: null,
				confirm: null,
				prompt: null,
			};
		}

		function reducer(state, action) {
			switch (action.type) {
				case "SET_ROOT": {
					if (state.root === action.root) return state;
					return { ...state, root: action.root, entries: {}, loading: {}, expanded: {}, tabs: [], activePath: null, notice: null, confirm: null, prompt: null };
				}
				case "SET_ENTRIES": {
					var entries = { ...state.entries, [action.path]: action.entries };
					var loading = { ...state.loading };
					delete loading[action.path];
					return { ...state, entries: entries, loading: loading };
				}
				case "SET_LOADING": {
					return { ...state, loading: { ...state.loading, [action.path]: true } };
				}
				case "TOGGLE_EXPANDED": {
					var expanded = { ...state.expanded };
					if (expanded[action.path]) delete expanded[action.path];
					else expanded[action.path] = true;
					return { ...state, expanded: expanded };
				}
				case "TOGGLE_WRAP": return { ...state, wrap: !state.wrap };
				case "SET_INCLUDE_HIDDEN": {
					return { ...state, includeHidden: !state.includeHidden, entries: {}, expanded: {} };
				}
				case "OPEN_TAB": {
					var tabs = state.tabs.slice();
					if (tabs.some(function (t) { return t.path === action.tab.path; })) return { ...state, activePath: action.tab.path };
					tabs.push(action.tab);
					return { ...state, tabs: tabs, activePath: action.tab.path };
				}
				case "UPDATE_TAB": {
					var tabs2 = state.tabs.map(function (t) { return t.path === action.path ? { ...t, ...action.patch } : t; });
					var activePath2 = state.activePath;
					if (activePath2 === action.path && action.patch.path) activePath2 = action.patch.path;
					return { ...state, tabs: tabs2, activePath: activePath2 };
				}
				case "CLOSE_TAB": {
					var tabs3 = state.tabs.filter(function (t) { return t.path !== action.path; });
					var activePath3 = state.activePath;
					if (activePath3 === action.path) activePath3 = tabs3.length ? tabs3[tabs3.length - 1].path : null;
					return { ...state, tabs: tabs3, activePath: activePath3 };
				}
				case "ACTIVATE_TAB": return { ...state, activePath: action.path };
				case "PANEL_OPEN": return { ...state, panelOpen: action.open };
				case "PANEL_SIDE": return { ...state, side: action.side };
				case "PANEL_WIDTH": return { ...state, width: action.width };
				case "SPLIT_PCT": return { ...state, splitPct: action.pct };
				case "PANEL_OFFSET": return { ...state, panelOffset: action.offset };
				case "NOTICE": return { ...state, notice: action.notice };
				case "CLEAR_NOTICE": return { ...state, notice: null };
				case "CONFIRM": return { ...state, confirm: action.confirm };
				case "CLEAR_CONFIRM": return { ...state, confirm: null };
				case "PROMPT": return { ...state, prompt: action.prompt };
				case "CLEAR_PROMPT": return { ...state, prompt: null };
				default: return state;
			}
		}

		// ───────────────────────── root derivation ─────────────────────────
		function deriveRoot(sessionsSnap, workspacesSnap) {
			var cur = sessionsSnap && sessionsSnap.current;
			var s = cur && sessionsSnap.byId && sessionsSnap.byId[cur];
			if (s && s.cwd) return s.cwd;
			if (workspacesSnap) {
				var recent = workspacesSnap.recentWorkspaceId;
				var ws = recent && workspacesSnap.items && workspacesSnap.items.find(function (w) { return w.workspaceId === recent; });
				if (ws && ws.path) return ws.path;
			}
			return null;
		}

		// ───────────────────────── main component ─────────────────────────
		var appCtx = null;

		function ExplorerPanel(props) {
			var t = props.t;
			var ctx = appCtx;
			var [state, dispatch] = useReducer(reducer, null, initialState);
			var refreshTimer = useRef(null);
			var lastSetGrid = useRef(null);
			var [setiTick, setSetiTick] = useState(0);

			var sessionsSnap = useSyncExternalStore(
				function (cb) { return ctx.sessions.list.subscribe(cb); },
				function () { return ctx.sessions.list.getSnapshot(); }
			);
			var workspacesSnap = useSyncExternalStore(
				function (cb) { return ctx.workspaces.list.subscribe(cb); },
				function () { return ctx.workspaces.list.getSnapshot(); }
			);
			var themeSnap = useSyncExternalStore(
				function (cb) { return ctx.on("theme/change", cb); },
				function () { return ctx.theme.getTheme(); }
			);
			var colorScheme = themeSnap && themeSnap.active ? themeSnap.active.colorScheme : "dark";

			var derivedRoot = useMemo(function () { return deriveRoot(sessionsSnap, workspacesSnap); }, [sessionsSnap, workspacesSnap]);

			// Refs mirroring state values that effects must read at event time
			// without re-running (avoids stale closures in the SSE handler).
			var expandedRef = useRef(state.expanded);
			var includeHiddenRef = useRef(state.includeHidden);
			expandedRef.current = state.expanded;
			includeHiddenRef.current = state.includeHidden;

			// Workspace switch: drop every cached Monaco model first — the cache
			// is keyed by relative path only, so stale models from the previous
			// root would leak memory and collide by path.
			useEffect(function () {
				if (state.root === derivedRoot) return;
				disposeAllModels();
				dispatch({ type: "SET_ROOT", root: derivedRoot });
			}, [derivedRoot]);

			// Persist panel preferences. The reducer stays pure (no side
			// effects); this single effect owns localStorage writes.
			useEffect(function () {
				savePrefs({
					includeHidden: state.includeHidden,
					open: state.panelOpen,
					side: state.side,
					width: state.width,
					splitPct: state.splitPct,
					wrap: state.wrap,
				});
			}, [state.includeHidden, state.panelOpen, state.side, state.width, state.splitPct, state.wrap]);

			useEffect(function () {
				setDirtyHandler(function (path) {
					dispatch({ type: "UPDATE_TAB", path: path, patch: { dirty: true } });
				});
				return function () { setDirtyHandler(null); };
			}, []);

			useEffect(function () {
				if (!state.notice) return;
				var timer = setTimeout(function () { dispatch({ type: "CLEAR_NOTICE" }); }, 6000);
				return function () { clearTimeout(timer); };
			}, [state.notice]);

			useEffect(function () {
				if (!state.root) return;
				loadDir(state.root, ".", state.includeHidden);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [state.root, state.includeHidden]);

			useEffect(function () {
				if (!state.root) return;
				var es = new EventSource("/explorer/events?root=" + encodeURIComponent(state.root));
				var onMsg = function () {
					if (refreshTimer.current) clearTimeout(refreshTimer.current);
					// Read via refs: this effect only re-runs on root changes,
					// so closing over state.expanded/includeHidden would freeze
					// stale values here.
					refreshTimer.current = setTimeout(function () { refreshTree(state.root, expandedRef.current, includeHiddenRef.current); }, 300);
				};
				es.onmessage = onMsg;
				return function () { es.close(); if (refreshTimer.current) clearTimeout(refreshTimer.current); };
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [state.root]);

			useEffect(function () {
				requireMonaco().then(function () {
					ensureThemes();
					ensureLangRegistered("javascriptreact");
					ensureLangRegistered("typescriptreact");
					ensureLangRegistered("jsonc");
				}).catch(function (e) { console.error("[dsh-explorer] monaco init failed", e); });
			}, []);

			// Load the VS Code default (Seti) icon theme once; bump a state so the
			// tree re-renders with the real file icons when it arrives.
			useEffect(function () {
				var off = onSetiReady(function () { setSetiTick(function (n) { return n + 1; }); });
				ensureSeti();
				return off;
			}, []);

			// Dock the panel as a real grid column so it RESIZES the app (chat)
			// instead of floating over it. We insert our width into the AppFrame's
			// grid-template-columns and keep it in sync via MutationObserver.
			useEffect(function () {
				var overlayEl = document.querySelector("[data-shell-overlay]");
				var frame = overlayEl && overlayEl.parentElement;
				if (!frame) return;
				var observer = null;
				var appBase = null;
				function splitTokens(s) {
					var out = [], cur = "", depth = 0;
					for (var i = 0; i < s.length; i++) {
						var c = s[i];
						if (c === "(") depth++;
						if (c === ")") depth--;
						if (c === " " && depth === 0) { if (cur) { out.push(cur); cur = ""; } }
						else cur += c;
					}
					if (cur) out.push(cur);
					return out;
				}
				function applyGrid() {
					var raw = frame.style.gridTemplateColumns || "";
					if (raw === lastSetGrid.current) return;
					var t = splitTokens(raw);
					if (t.length === 0) return; // app has not laid out the grid yet; observer will re-apply
					if (t.length > 3) {
						// our inserted column is present; strip it (left inserts at idx 1, right appends)
						t = state.side === "left" ? t.filter(function (_, i) { return i !== 1; }) : t.slice(0, t.length - 1);
					}
					appBase = t.join(" ");
					var sidebarW = parseFloat(t[0]) || 0;
					if (state.panelOpen) {
						if (state.side === "left") t.splice(1, 0, state.width + "px");
						else t.push(state.width + "px");
					}
					var next = t.join(" ");
					lastSetGrid.current = next;
					frame.style.gridTemplateColumns = next;
					dispatch({ type: "PANEL_OFFSET", offset: sidebarW });
				}
				applyGrid();
				observer = new MutationObserver(applyGrid);
				observer.observe(frame, { attributes: true, attributeFilter: ["style"] });
				return function () {
					if (observer) observer.disconnect();
					if (appBase !== null && frame.style.gridTemplateColumns === lastSetGrid.current) {
						frame.style.gridTemplateColumns = appBase;
					}
					lastSetGrid.current = null;
				};
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [state.panelOpen, state.side, state.width]);

			useEffect(function () {
				return onGrammarReady(function () {
					retokenizeModels(null);
				});
			}, []);

			function loadDir(root, rel, includeHidden) {
				dispatch({ type: "SET_LOADING", path: rel });
				callRpc(ctx, "fs/list", { root: root, path: rel, includeHidden: includeHidden }).then(function (r) {
					dispatch({ type: "SET_ENTRIES", path: rel, entries: r.entries });
				}).catch(function (e) {
					dispatch({ type: "SET_ENTRIES", path: rel, entries: [] });
					dispatch({ type: "NOTICE", notice: { kind: "error", text: String(e.message || e) } });
				});
			}

			function refreshTree(root, expanded, includeHidden) {
				var paths = Object.keys(expanded || {}).concat(["."]);
				paths.forEach(function (p) {
					callRpc(ctx, "fs/list", { root: root, path: p, includeHidden: includeHidden }).then(function (r) {
						dispatch({ type: "SET_ENTRIES", path: p, entries: r.entries });
					}).catch(function () { /* dir may be gone */ });
				});
			}

			function toggleDir(rel) {
				dispatch({ type: "TOGGLE_EXPANDED", path: rel });
				var willExpand = !state.expanded[rel];
				if (willExpand && !state.entries[rel] && !state.loading[rel]) {
					loadDir(state.root, rel, state.includeHidden);
				}
			}

			async function openFile(entry) {
				if (entry.isDir) { toggleDir(entry.path); return; }
				var existing = state.tabs.find(function (t) { return t.path === entry.path; });
				if (existing) { dispatch({ type: "ACTIVATE_TAB", path: entry.path }); return; }
				try {
					var r = await callRpc(ctx, "fs/read", { root: state.root, path: entry.path });
					var langId = langForPath(entry.path);
					var tab = {
						path: entry.path,
						name: entry.name,
						dir: dirName(entry.path),
						langId: langId,
						dirty: false,
						readOnly: false,
						tooLarge: !!r.tooLarge,
						binary: !!r.binary,
						mtimeMs: r.mtimeMs,
						size: r.size,
						content: r.content,
					};
					if (r.binary) { dispatch({ type: "NOTICE", notice: { kind: "error", text: t("editor.binary") } }); return; }
					dispatch({ type: "OPEN_TAB", tab: tab });
				} catch (e) {
					dispatch({ type: "NOTICE", notice: { kind: "error", text: String(e.message || e) } });
				}
			}

			// "Open anyway (read-only)" for files above the inline cap. The
			// server's readLarge still has its own (higher) cap — surface it.
			async function loadLarge(path) {
				try {
					var r = await callRpc(ctx, "fs/readLarge", { root: state.root, path: path });
					if (r.tooLarge) {
						dispatch({ type: "NOTICE", notice: { kind: "error", text: t("editor.tooLarge", { size: fmtBytes(r.size) }) } });
						return;
					}
					if (r.binary) {
						dispatch({ type: "NOTICE", notice: { kind: "error", text: t("editor.binary") } });
						return;
					}
					dispatch({ type: "UPDATE_TAB", path: path, patch: { readOnly: true, tooLarge: false, content: r.content, mtimeMs: Date.now() } });
					var model = modelCache[path] && modelCache[path].model;
					if (model) { suppressDirty[path] = true; model.setValue(r.content); delete suppressDirty[path]; }
				} catch (e) {
					dispatch({ type: "NOTICE", notice: { kind: "error", text: String(e.message || e) } });
				}
			}

			function closeTab(path) {
				var tab = state.tabs.find(function (t) { return t.path === path; });
				if (tab && tab.dirty) {
					dispatch({ type: "CONFIRM", confirm: { kind: "closeDirty", path: path, name: tab.name } });
					return;
				}
				doCloseTab(path);
			}
			function doCloseTab(path) {
				var rec = modelCache[path];
				if (rec) { try { rec.model.dispose(); } catch (e) { /* ignore */ } delete modelCache[path]; }
				dispatch({ type: "CLOSE_TAB", path: path });
			}

			async function saveTab(path) {
				var tab = state.tabs.find(function (t) { return t.path === path; });
				var rec = modelCache[path];
				if (!tab || !rec || tab.readOnly) return;
				var content = rec.model.getValue();
				try {
					var st = await callRpc(ctx, "fs/stat", { root: state.root, path: path });
					if (st.exists && (st.mtimeMs !== tab.mtimeMs || st.size !== tab.size)) {
						dispatch({ type: "CONFIRM", confirm: { kind: "conflict", path: path, name: tab.name } });
						return;
					}
					var wr = await callRpc(ctx, "fs/write", { root: state.root, path: path, content: content });
					dispatch({ type: "UPDATE_TAB", path: path, patch: { dirty: false, mtimeMs: wr.mtimeMs, size: wr.size } });
				} catch (e) {
					dispatch({ type: "NOTICE", notice: { kind: "error", text: String(e.message || e) } });
				}
			}

			async function confirmOverwrite(path) {
				var tab = state.tabs.find(function (t) { return t.path === path; });
				var rec = modelCache[path];
				if (!tab || !rec) return;
				try {
					var wr = await callRpc(ctx, "fs/write", { root: state.root, path: path, content: rec.model.getValue() });
					dispatch({ type: "UPDATE_TAB", path: path, patch: { dirty: false, mtimeMs: wr.mtimeMs, size: wr.size } });
					dispatch({ type: "CLEAR_CONFIRM" });
				} catch (e) {
					dispatch({ type: "NOTICE", notice: { kind: "error", text: String(e.message || e) } });
				}
			}

			async function reloadFile(path) {
				try {
					var r = await callRpc(ctx, "fs/read", { root: state.root, path: path });
					if (r.binary || r.tooLarge) { dispatch({ type: "CLEAR_CONFIRM" }); return; }
					var model = modelCache[path] && modelCache[path].model;
					if (model) { suppressDirty[path] = true; model.setValue(r.content); delete suppressDirty[path]; }
					dispatch({ type: "UPDATE_TAB", path: path, patch: { dirty: false, mtimeMs: r.mtimeMs, size: r.size } });
					dispatch({ type: "CLEAR_CONFIRM" });
				} catch (e) {
					dispatch({ type: "NOTICE", notice: { kind: "error", text: String(e.message || e) } });
				}
			}

			function quickAction(kind, path) {
				var cur = sessionsSnap && sessionsSnap.current;
				if (!cur) { dispatch({ type: "NOTICE", notice: { kind: "error", text: t("editor.noSession") } }); return; }
				var binding = ctx.sessions.binding(cur);
				if (!binding) { dispatch({ type: "NOTICE", notice: { kind: "error", text: t("editor.noSession") } }); return; }
				var label = kind === "analyze" ? t("editor.analyze") : t("editor.fix");
				var text = label + ": " + path;
				binding.prompt([{ type: "text", text: text }], "queue").then(function (res) {
					if (!res.ok) throw new Error(res.error.code + ": " + res.error.message);
				}).catch(function (e) {
					dispatch({ type: "NOTICE", notice: { kind: "error", text: String(e.message || e) } });
				});
			}

			function confirmDelete(entry) {
				dispatch({ type: "CONFIRM", confirm: { kind: "delete", path: entry.path, name: entry.name, isDir: entry.isDir } });
			}
			async function doDelete(path) {
				try {
					await callRpc(ctx, "fs/delete", { root: state.root, path: path });
					var rec = modelCache[path];
					if (rec) { try { rec.model.dispose(); } catch (e) { /* ignore */ } delete modelCache[path]; }
					dispatch({ type: "CLOSE_TAB", path: path });
					refreshTree(state.root, state.expanded, state.includeHidden);
					dispatch({ type: "CLEAR_CONFIRM" });
				} catch (e) {
					dispatch({ type: "NOTICE", notice: { kind: "error", text: String(e.message || e) } });
				}
			}

			function commitPrompt(value) {
				var p = state.prompt;
				dispatch({ type: "CLEAR_PROMPT" });
				if (!value) return;
				(async function () {
					try {
						if (p.kind === "newfile") {
							var target = p.path === "." ? value : p.path + "/" + value;
							await callRpc(ctx, "fs/create", { root: state.root, path: target, kind: "file" });
						} else if (p.kind === "newdir") {
							var target2 = p.path === "." ? value : p.path + "/" + value;
							await callRpc(ctx, "fs/create", { root: state.root, path: target2, kind: "dir" });
						} else if (p.kind === "rename") {
							await callRpc(ctx, "fs/rename", { root: state.root, path: p.path, newName: value });
							var dir = dirName(p.path);
							var newPath = dir === "." ? value : dir + "/" + value;
							var rec = modelCache[p.path];
							if (rec) { modelCache[newPath] = rec; delete modelCache[p.path]; }
							dispatch({ type: "UPDATE_TAB", path: p.path, patch: { path: newPath, name: value, dir: dir } });
						} else if (p.kind === "move") {
							await callRpc(ctx, "fs/move", { root: state.root, path: p.path, targetDir: value });
							var name = baseName(p.path);
							var newPath2 = value === "." ? name : value + "/" + name;
							var rec2 = modelCache[p.path];
							if (rec2) { modelCache[newPath2] = rec2; delete modelCache[p.path]; }
							dispatch({ type: "UPDATE_TAB", path: p.path, patch: { path: newPath2, dir: value === "." ? "." : value } });
						} else if (p.kind === "duplicate") {
							var dup = dirName(p.path) + "/" + value;
							var content = await callRpc(ctx, "fs/read", { root: state.root, path: p.path });
							await callRpc(ctx, "fs/write", { root: state.root, path: dup, content: content.content || "" });
						}
						refreshTree(state.root, state.expanded, state.includeHidden);
					} catch (e) {
						dispatch({ type: "NOTICE", notice: { kind: "error", text: String(e.message || e) } });
					}
				})();
			}

			async function openFolder() {
				try {
					var picked = await ctx.workspaces.pickDirectory();
					if (!picked) return;
					var ws = await ctx.workspaces.create({ path: picked });
					ctx.workspaces.startSession(ws.workspaceId);
				} catch (e) {
					dispatch({ type: "NOTICE", notice: { kind: "error", text: String(e.message || e) } });
				}
			}

			function startResize(e) {
				e.preventDefault();
				var startX = e.clientX;
				var startW = state.width;
				var side = state.side;
				var frame = document.querySelector("[data-shell-overlay]");
				frame = frame && frame.parentElement;
				var prevTransition = frame ? frame.style.transition : null;
				if (frame) frame.style.transition = "none"; // keep dragging 1:1
				function onMove(ev) {
					var dx = ev.clientX - startX;
					var w = side === "right" ? startW - dx : startW + dx;
					w = Math.min(Math.max(w, 260), 560);
					dispatch({ type: "PANEL_WIDTH", width: w });
				}
				function onUp() {
					if (frame) frame.style.transition = prevTransition || "";
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				}
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			}

			function startSplitDrag(e) {
				e.preventDefault();
				var wrap = e.currentTarget.parentElement;
				var rect = wrap.getBoundingClientRect();
				var startY = e.clientY;
				var startPct = state.splitPct;
				function onMove(ev) {
					var dy = ev.clientY - startY;
					var pct = startPct + (dy / rect.height) * 100;
					dispatch({ type: "SPLIT_PCT", pct: Math.min(Math.max(pct, 20), 70) });
				}
				function onUp() {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				}
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			}

			var activeTab = state.tabs.find(function (t) { return t.path === state.activePath; }) || null;

			if (!state.panelOpen) {
				return h("button", {
					className: cx("dx-toggle", state.side === "right" ? "dx-tright" : "dx-tleft"),
					title: t("panel.expand"),
					onClick: function () { dispatch({ type: "PANEL_OPEN", open: true }); },
				}, icon("files"));
			}

			return h("div", { className: cx("dx-overlay", state.side === "right" ? "dx-right" : "dx-left") },
				h("div", {
					className: "dx-panel",
					style: {
						width: state.width,
						left: state.side === "left" ? state.panelOffset : undefined,
						right: state.side === "right" ? 0 : undefined,
					},
				},
					h("div", { className: "dx-header" },
						h("span", { className: "dx-title", title: state.root || "", children: t("panel.title") }),
						h("button", { className: "dx-tbtn", title: t("panel.newFile"), disabled: !state.root, onClick: function () { dispatch({ type: "PROMPT", prompt: { kind: "newfile", path: ".", placeholder: t("tree.newPlaceholder") } }); } }, icon("new-file")),
						h("button", { className: "dx-tbtn", title: t("panel.newFolder"), disabled: !state.root, onClick: function () { dispatch({ type: "PROMPT", prompt: { kind: "newdir", path: ".", placeholder: t("tree.newFolderPlaceholder") } }); } }, icon("new-folder")),
						h("button", { className: "dx-tbtn", title: t("panel.refresh"), disabled: !state.root, onClick: function () { if (state.root) refreshTree(state.root, state.expanded, state.includeHidden); } }, icon("refresh")),
						h("button", { className: "dx-tbtn", title: t("panel.toggleHidden"), onClick: function () { dispatch({ type: "SET_INCLUDE_HIDDEN" }); } }, icon(state.includeHidden ? "eye" : "eye-closed")),
						h("button", { className: "dx-tbtn", title: state.side === "right" ? t("panel.moveLeft") : t("panel.moveRight"), onClick: function () { dispatch({ type: "PANEL_SIDE", side: state.side === "right" ? "left" : "right" }); } }, icon(state.side === "right" ? "arrow-left" : "arrow-right")),
						h("button", { className: "dx-tbtn", title: t("panel.collapse"), onClick: function () { dispatch({ type: "PANEL_OPEN", open: false }); } }, icon("chevron-right")),
					),
					state.root
						? h("div", { className: "dx-body" },
							h("div", { className: "dx-tree-wrap", style: { flexBasis: state.splitPct + "%" } },
								h(TreeView, {
									t: t, root: state.root, entries: state.entries, loading: state.loading,
									expanded: state.expanded, selected: state.activePath, includeHidden: state.includeHidden,
									isLight: colorScheme === "light",
									onToggle: toggleDir, onOpen: openFile, onDelete: confirmDelete,
									onPrompt: function (p) { dispatch({ type: "PROMPT", prompt: p }); },
								}),
							),
							h("div", { className: "dx-split", onMouseDown: startSplitDrag }, icon("grabber")),
							h("div", { className: "dx-editor-wrap" },
								activeTab
									? h(EditorPane, {
										t: t, tab: activeTab, colorScheme: colorScheme,
										tabs: state.tabs, activePath: state.activePath,
										onActivate: function (path) { dispatch({ type: "ACTIVATE_TAB", path: path }); },
										onSave: activeTab ? function () { saveTab(activeTab.path); } : null,
										onClose: closeTab,
										onLoadLarge: loadLarge,
										onAnalyze: activeTab ? function () { quickAction("analyze", activeTab.path); } : null,
										onFix: activeTab ? function () { quickAction("fix", activeTab.path); } : null,
										wrap: state.wrap,
										onToggleWrap: function () { dispatch({ type: "TOGGLE_WRAP" }); },
									})
									: h("div", { className: "dx-editor-empty", children: t("editor.placeholder") }),
							),
							h("div", { className: "dx-footer" },
								state.notice
									? h("span", { className: "dx-status-err", children: state.notice.text })
									: h("span", { className: "dx-status-path", title: state.root, children: t("status.root", { root: state.root }) }),
								state.tabs.length ? h("span", { children: state.tabs.length + (state.tabs.length === 1 ? " tab" : " tabs") }) : null,
							),
						)
						: h(NoWorkspaceView, { t: t, workspacesSnap: workspacesSnap, onOpenFolder: openFolder, onPick: function (wsId) { ctx.workspaces.startSession(wsId); } }),
					state.confirm ? h(ConfirmDialog, { t: t, confirm: state.confirm, onConfirm: function (choice) {
						var c = state.confirm;
						if (c.kind === "delete") { if (choice === "ok") doDelete(c.path); else dispatch({ type: "CLEAR_CONFIRM" }); }
						else if (c.kind === "conflict") {
							if (choice === "overwrite") confirmOverwrite(c.path);
							else if (choice === "reload") reloadFile(c.path);
							else dispatch({ type: "CLEAR_CONFIRM" });
						} else if (c.kind === "closeDirty") { if (choice === "ok") doCloseTab(c.path); else dispatch({ type: "CLEAR_CONFIRM" }); }
						else dispatch({ type: "CLEAR_CONFIRM" });
					} }) : null,
					state.prompt ? h(PromptDialog, { t: t, prompt: state.prompt, onSubmit: commitPrompt, onCancel: function () { dispatch({ type: "CLEAR_PROMPT" }); } }) : null,
					h("div", { className: cx("dx-resize", state.side === "right" ? "dx-rleft" : "dx-rright"), onMouseDown: startResize }),
				),
			);
		}

		// ───────────────────────── tree ─────────────────────────
		function TreeView(props) {
			var t = props.t;
			var rootEntries = props.entries["."];
			if (!rootEntries) return h("div", { className: "dx-hint", style: { padding: "8px 14px" }, children: t("tree.loading") });
			return h("div", null,
				rootEntries.map(function (e) { return h(TreeNode, { key: e.path, ...props, entry: e }); }),
				rootEntries.length === 0 ? h("div", { className: "dx-hint", style: { padding: "8px 14px" }, children: t("tree.empty") }) : null,
			);
		}

		function TreeNode(props) {
			var t = props.t, entry = props.entry, depth = props.depth || 0;
			var isDir = entry.isDir;
			var expanded = !!props.expanded[entry.path];
			var loading = !!props.loading[entry.path];
			var children = props.entries[entry.path] || null;
			var indent = { paddingLeft: 4 + depth * 14 };

			return h("div", null,
				h("div", {
					className: cx("dx-row", props.selected === entry.path && "dx-selected"),
					style: indent,
					title: entry.path,
					onClick: function (e) {
						if (e.target.closest(".dx-act") || e.target.closest(".dx-chev")) return;
						props.onOpen(entry);
					},
					onDoubleClick: function () { if (isDir) props.onToggle(entry.path); },
				},
					isDir
						? h("button", { className: "dx-chev", onClick: function (e) { e.stopPropagation(); props.onToggle(entry.path); } }, icon(expanded ? "chevron-down" : "chevron-right"))
						: h("span", { className: "dx-chev dx-spacer" }, icon("chevron-right")),
					isDir ? folderIcon(expanded) : fileIcon(entry.name, props.isLight),
					h("span", { className: "dx-name", children: entry.name }),
					loading && isDir ? h("span", { className: "dx-spin dx-icon", style: { fontSize: 12, opacity: .6 } }, "◌") : null,
					h("span", { className: "dx-actions" },
						isDir ? [
							h("button", { key: "nf", className: "dx-act", title: t("tree.newFile"), onClick: function (e) { e.stopPropagation(); props.onPrompt({ kind: "newfile", path: entry.path, placeholder: t("tree.newPlaceholder") }); } }, icon("new-file")),
							h("button", { key: "nd", className: "dx-act", title: t("tree.newFolder"), onClick: function (e) { e.stopPropagation(); props.onPrompt({ kind: "newdir", path: entry.path, placeholder: t("tree.newFolderPlaceholder") }); } }, icon("new-folder")),
						] : [
							h("button", { key: "dup", className: "dx-act", title: t("tree.duplicate"), onClick: function (e) { e.stopPropagation(); props.onPrompt({ kind: "duplicate", path: entry.path, placeholder: t("tree.newPlaceholder") }); } }, icon("copy")),
						],
						h("button", { key: "mv", className: "dx-act", title: t("tree.move"), onClick: function (e) { e.stopPropagation(); props.onPrompt({ kind: "move", path: entry.path, placeholder: t("tree.movePlaceholder") }); } }, icon("arrow-right")),
						h("button", { key: "rn", className: "dx-act", title: t("tree.rename"), onClick: function (e) { e.stopPropagation(); props.onPrompt({ kind: "rename", path: entry.path, placeholder: t("tree.renamePlaceholder"), value: entry.name }); } }, icon("edit")),
						h("button", { key: "del", className: "dx-act", title: t("tree.delete"), onClick: function (e) { e.stopPropagation(); props.onDelete(entry); } }, icon("trash")),
					),
				),
				isDir && expanded
					? (children === null ? null : children.map(function (c) { return h(TreeNode, { key: c.path, ...props, entry: c, depth: depth + 1 }); }))
					: null,
			);
		}

		// ───────────────────────── no-workspace view ─────────────────────────
		function NoWorkspaceView(props) {
			var t = props.t;
			var items = (props.workspacesSnap && props.workspacesSnap.items) || [];
			return h("div", { className: "dx-nosession" },
				h("div", { className: "dx-hint", children: t("tree.noWorkspace") }),
				h("button", { className: "dx-btn", onClick: props.onOpenFolder }, icon("folder-opened"), h("span", { children: t("tree.openFolder") })),
				items.length ? h("div", { className: "dx-hint", style: { marginTop: 8 }, children: t("tree.chooseWorkspace") }) : null,
				items.map(function (w) {
					return h("div", { key: w.workspaceId, className: "dx-wsrow", onClick: function () { props.onPick(w.workspaceId); } },
						h("span", { className: "dx-wsicon" }, GLYPH.folder),
						h("div", { style: { minWidth: 0, flex: 1 } },
							h("div", { children: w.title }),
							h("div", { className: "dx-path", children: w.path }),
						),
					);
				}),
			);
		}

		// ───────────────────────── editor pane ─────────────────────────
		function EditorPane(props) {
			var t = props.t, tab = props.tab;
			return h("div", { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative" } },
				h("div", { className: "dx-tabs" },
					props.tabs.map(function (tb) {
						return h("div", {
							key: tb.path,
							className: cx("dx-tab", tb.path === props.activePath && "dx-active", tb.dirty && "dx-dirty"),
							onClick: function () { props.onActivate(tb.path); },
							onAuxClick: function (e) { if (e.button === 1) props.onClose(tb.path); },
							title: tb.path,
						},
							h("span", { className: "dx-dot" }),
							h("span", { className: "dx-tabname", children: tb.name }),
							h("button", { className: "dx-tabclose", onClick: function (e) { e.stopPropagation(); props.onClose(tb.path); } }, icon("close")),
						);
					}),
				),
				h(MonacoHost, { tab: tab, colorScheme: props.colorScheme, onSave: props.onSave, readOnly: tab.readOnly, tooLarge: tab.tooLarge, onLoadLarge: function () { props.onLoadLarge(tab.path); }, wrap: props.wrap, t: t }),
				tab.tooLarge && !tab.readOnly ? h("div", { className: "dx-banner" },
					h("span", { children: t("editor.tooLarge", { size: fmtBytes(tab.size) }) }),
					h("span", { className: "dx-btns" },
						h("button", { className: "dx-btn", onClick: function () { props.onLoadLarge(tab.path); } }, h("span", { children: t("editor.loadAnyway") })),
					),
				) : null,
				h("div", { className: "dx-status" },
					h("span", { className: "dx-status-path", title: tab.path, children: tab.path }),
					tab.readOnly ? h("span", { className: "dx-tag", children: t("editor.readOnly") }) : null,
					tab.dirty ? h("span", { className: "dx-tag dx-warn", children: t("editor.unsaved") }) : null,
					h("button", { className: "dx-sbtn", disabled: !props.onSave || tab.readOnly, onClick: props.onSave }, h("span", { children: t("editor.save") }), h("span", { style: { opacity: .7, fontSize: 11 }, children: "Ctrl+S" })),
					h("button", { className: "dx-sbtn", disabled: !props.onAnalyze, onClick: props.onAnalyze }, h("span", { children: t("editor.analyze") })),
					h("button", { className: "dx-sbtn", disabled: !props.onFix, onClick: props.onFix }, h("span", { children: t("editor.fix") })),
					h("button", { className: cx("dx-sbtn", props.wrap && "dx-on"), title: t("editor.wrap"), onClick: props.onToggleWrap }, h("span", { children: t("editor.wrapShort") })),
				),
			);
		}

		function MonacoHost(props) {
			var containerRef = useRef(null);
			var editorRef = useRef(null);
			var [fail, setFail] = useState(null);
			var tab = props.tab;
			var themeName = props.colorScheme === "light" ? "dsh-explorer-light" : "dsh-explorer-dark";
			var schemeKey = props.colorScheme === "light" ? "light" : "dark";

			// dispose the editor when this host unmounts (tab closed / panel closed)
			useEffect(function () {
				return function () {
					if (editorRef.current) {
						try { editorRef.current.dispose(); } catch (e) { /* ignore */ }
						editorRef.current = null;
					}
				};
			}, []);

			// One flow: ensure monaco + themes, create the editor once, then bind
			// the active tab's model. Runs again on tab/readOnly/theme changes.
			// `disposed` guards against async completion after unmount (tab
			// closed mid-load); the container may also be gone, so both are
			// null-checked before touching the editor.
			useEffect(function () {
				var disposed = false;
				var effectiveTheme = function () {
					return themesDefined[schemeKey] ? themeName : (schemeKey === "light" ? "vs" : "vs-dark");
				};
				var run = function () {
					return requireMonaco().then(function () {
						return ensureThemes().catch(function (e) { console.error("[dsh-explorer] theme setup failed", e); });
					}).then(function () {
						if (disposed || !containerRef.current) return;
						var editor = editorRef.current;
						if (!editor) {
							editor = monaco.editor.create(containerRef.current, {
								value: "",
								language: "plaintext",
								theme: effectiveTheme(),
								automaticLayout: true,
								minimap: { enabled: false },
								lineNumbers: "on",
								scrollBeyondLastLine: false,
								readOnly: false,
								fontSize: 13,
								tabSize: 2,
								wordWrap: props.wrap ? "on" : "off",
								fixedOverflowWidgets: true,
								padding: { top: 6 },
							});
							editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () { if (props.onSave) props.onSave(); });
							editorRef.current = editor;
						}
						var t = props.tab;
						if (!t) return;
						var langId = t.langId || "plaintext";
						ensureLangRegistered(langId);
						installProvider(langId);
						var model;
						if (modelCache[t.path]) {
							model = modelCache[t.path].model;
						} else {
							model = getOrCreateModel(t.path, t.content || "", langId);
						}
						monaco.editor.setModelLanguage(model, langId);
						editor.setModel(model);
						editor.updateOptions({ readOnly: !!t.readOnly, theme: effectiveTheme(), wordWrap: props.wrap ? "on" : "off" });
					});
				};
				run().catch(function (e) { setFail(String((e && e.message) || e)); });
				return function () { disposed = true; };
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [tab && tab.path, tab && tab.readOnly, themeName]);

			// Toggle line wrapping live, without recreating the editor: apply
			// updateOptions directly when the global wrap preference changes.
			useEffect(function () {
				if (editorRef.current) {
					try { editorRef.current.updateOptions({ wordWrap: props.wrap ? "on" : "off" }); } catch (e) { /* ignore */ }
				}
			}, [props.wrap]);

			if (fail) {
				return h("div", { className: "dx-editor-fail" }, props.t("editor.loadFailed", { error: fail }));
			}
			return h("div", { className: "dx-editor" },
				h("div", { ref: containerRef, className: "dx-editor-root" }),
			);
		}

		// ───────────────────────── dialogs ─────────────────────────
		function ConfirmDialog(props) {
			var t = props.t, c = props.confirm;
			var title, body, okLabel, okClass = null, choices;
			if (c.kind === "delete") {
				title = t("tree.confirmDeleteTitle");
				body = t("tree.confirmDeleteBody", { name: c.name });
				okLabel = t("common.delete");
				okClass = "dx-danger";
				choices = ["cancel", "ok"];
			} else if (c.kind === "conflict") {
				title = t("editor.conflictTitle");
				body = t("editor.conflictBody", { name: c.name });
				okLabel = t("editor.overwrite");
				choices = ["cancel", "reload", "overwrite"];
			} else if (c.kind === "closeDirty") {
				title = t("editor.unsaved");
				body = t("editor.conflictBody", { name: c.name });
				okLabel = t("common.ok");
				choices = ["cancel", "ok"];
			} else {
				title = t("common.error");
				body = String(c.name || "");
				okLabel = t("common.ok");
				choices = ["ok"];
			}
			return h("div", { className: "dx-dialog" },
				h("div", { className: "dx-dialogbox" },
					h("div", { className: "dx-dlg-title", children: title }),
					h("div", { className: "dx-dlg-body", children: body }),
					h("div", { className: "dx-dlg-actions" },
						choices.indexOf("cancel") >= 0 ? h("button", { key: "cancel", className: "dx-btn", onClick: function () { props.onConfirm("cancel"); } }, h("span", { children: t("common.cancel") })) : null,
						choices.indexOf("reload") >= 0 ? h("button", { key: "reload", className: "dx-btn", onClick: function () { props.onConfirm("reload"); } }, h("span", { children: t("editor.reload") })) : null,
						choices.indexOf("ok") >= 0 ? h("button", { key: "ok", className: cx("dx-btn", okClass), onClick: function () { props.onConfirm("ok"); } }, h("span", { children: okLabel })) : null,
						choices.indexOf("overwrite") >= 0 ? h("button", { key: "overwrite", className: "dx-btn dx-danger", onClick: function () { props.onConfirm("overwrite"); } }, h("span", { children: t("editor.overwrite") })) : null,
					),
				),
			);
		}

		function PromptDialog(props) {
			var t = props.t, p = props.prompt;
			var inputRef = useRef(null);
			useEffect(function () { if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, []);
			var label, value = "";
			if (p.kind === "newfile") label = t("tree.newFile");
			else if (p.kind === "newdir") label = t("tree.newFolder");
			else if (p.kind === "rename") { label = t("tree.rename"); value = p.value || ""; }
			else if (p.kind === "move") label = t("tree.confirmMoveBody");
			else if (p.kind === "duplicate") label = t("tree.duplicate");
			return h("div", { className: "dx-dialog" },
				h("div", { className: "dx-dialogbox" },
					h("div", { className: "dx-dlg-title", children: label }),
					h("div", { style: { display: "flex", gap: 8 } },
						h("input", {
							ref: inputRef,
							defaultValue: value,
							placeholder: p.placeholder || "",
							onKeyDown: function (e) { if (e.key === "Enter") props.onSubmit(e.target.value.trim()); if (e.key === "Escape") props.onCancel(); },
						}),
					),
					h("div", { className: "dx-dlg-actions", style: { marginTop: 12 } },
						h("button", { className: "dx-btn", onClick: props.onCancel }, h("span", { children: t("common.cancel") })),
						h("button", { className: "dx-btn", onClick: function () { var inp = inputRef.current; props.onSubmit(inp ? inp.value.trim() : ""); } }, h("span", { children: t("common.ok") })),
					),
				),
			);
		}

		// ───────────────────────── plugin body ─────────────────────────
		function apply(ctx) {
			appCtx = ctx;
			ctx.effect(function () {
				return ctx.locale.register(NS, dict);
			}, "dsh-explorer: dictionaries");
			ctx.effect(function () {
				return ctx.slots.register({
					name: "shell.overlay",
					id: "dsh-explorer",
					locale: NS,
				}, ExplorerPanel);
			}, "dsh-explorer: slot registration");
		}

		exports.apply = apply;
		exports.inject = ["slots", "layout", "connection", "sessions", "workspaces", "locale", "theme"];
		return module.exports;
	}
});
