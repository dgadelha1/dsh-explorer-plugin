// Vendors the browser assets the File Explorer serves at runtime:
//   vendor/monaco    - monaco-editor AMD build (min/vs)
//   vendor/onig      - vscode-oniguruma (onig.wasm + loader)
//   vendor/textmate  - vscode-textmate CJS release
//   vendor/grammars  - TextMate grammars from microsoft/vscode (pinned commit)
//   vendor/themes    - VS Code Dark+/Light+ themes
// Run: node scripts/vendor.mjs
//
// Reproducibility: every npm dependency is pinned to an exact version and the
// VS Code grammar sources are pinned to one commit SHA, so re-running this
// script produces the same assets (no floating `latest` / `main`).
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const TMP = join(VENDOR, '.tmp');

// Pinned dependency versions (must match what is currently vendored).
const MONACO_VERSION = '0.56.0';
const ONIG_VERSION = '2.0.1';
const TEXTMATE_VERSION = '9.3.2';
// Pinned microsoft/vscode commit (grammars + themes are fetched from it).
const VSCODE_REF = '2c0f00a6017866a92ca066889e719067d4351469';
const RAW = (p) => `https://raw.githubusercontent.com/microsoft/vscode/${VSCODE_REF}/${p}`;

// The npm cache in $HOME may sit on a read-only mount (EROFS); keep it inside
// the workspace so `npm pack` can write tarballs.
process.env.npm_config_cache = join(ROOT, '.npm-cache');

mkdirSync(VENDOR, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function npmPack(name, files, dest) {
  console.log(`vendor: packing ${name}...`);
  execSync(`npm pack ${name} --pack-destination ${TMP} --silent`, { stdio: 'inherit' });
  const tgz = readdirSync(TMP).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack ${name}: no tarball produced`);
  execSync(`tar -xzf ${join(TMP, tgz)} -C ${TMP}`);
  const pkgDir = join(TMP, 'package');
  mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const src = join(pkgDir, f);
    if (!existsSync(src)) throw new Error(`${name}: missing file ${f}`);
    copyFileSync(src, join(dest, f.split('/').pop()));
  }
  rmSync(join(TMP, tgz));
  rmSync(pkgDir, { recursive: true });
}

async function fetchTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(`vendor: ${dest.replace(ROOT + '/', '')} (${(buf.length / 1024).toFixed(0)} KiB)`);
}

// 1. Monaco AMD build (pinned version)
{
  console.log(`vendor: packing monaco-editor@${MONACO_VERSION}...`);
  execSync(`npm pack monaco-editor@${MONACO_VERSION} --pack-destination ${TMP} --silent`, { stdio: 'inherit' });
  const tgz = readdirSync(TMP).find((f) => f.endsWith('.tgz'));
  execSync(`tar -xzf ${join(TMP, tgz)} -C ${TMP}`);
  await cp(join(TMP, 'package/min/vs'), join(VENDOR, 'monaco', 'vs'), { recursive: true });
  rmSync(join(TMP, tgz));
  rmSync(join(TMP, 'package'), { recursive: true });
  console.log('vendor: monaco/vs copied');
}

// 2. vscode-oniguruma (onig.wasm + CJS loader)
npmPack(`vscode-oniguruma@${ONIG_VERSION}`, ['release/onig.wasm', 'release/main.js'], join(VENDOR, 'onig'));

// 3. vscode-textmate (CJS release, self-contained)
npmPack(`vscode-textmate@${TEXTMATE_VERSION}`, ['release/main.js'], join(VENDOR, 'textmate'));

// 4. TextMate grammars from microsoft/vscode (pinned VSCODE_REF commit)
const GRAMMARS = {
  'JavaScript.tmLanguage.json': 'source.js',
  'JavaScriptReact.tmLanguage.json': 'source.js.jsx',
  'TypeScript.tmLanguage.json': 'source.ts',
  'TypeScriptReact.tmLanguage.json': 'source.tsx',
  'python.tmLanguage.json': 'source.python',
  'html.tmLanguage.json': 'text.html.basic',
  'css.tmLanguage.json': 'source.css',
  'scss.tmLanguage.json': 'source.css.scss',
  'less.tmLanguage.json': 'source.css.less',
  'json.tmLanguage.json': 'source.json',
  'jsonc.tmLanguage.json': 'source.json.comments',
  'markdown.tmLanguage.json': 'text.html.markdown',
  'yaml.tmLanguage.json': 'source.yaml',
  'shell-unix-bash.tmLanguage.json': 'source.shell',
  'cpp.tmLanguage.json': 'source.cpp',
  'go.tmLanguage.json': 'source.go',
  'rust.tmLanguage.json': 'source.rust',
  'java.tmLanguage.json': 'source.java',
  'xml.tmLanguage.json': 'text.xml',
  'php.tmLanguage.json': 'source.php',
  'sql.tmLanguage.json': 'source.sql',
  'ini.tmLanguage.json': 'source.ini',
  'csharp.tmLanguage.json': 'source.cs',
  'ruby.tmLanguage.json': 'source.ruby',
  'lua.tmLanguage.json': 'source.lua',
  'swift.tmLanguage.json': 'source.swift',
  'bat.tmLanguage.json': 'source.bat',
  'powershell.tmLanguage.json': 'source.powershell',
};
const GRAMMAR_PATHS = {
  'JavaScript.tmLanguage.json': 'extensions/javascript/syntaxes/JavaScript.tmLanguage.json',
  'JavaScriptReact.tmLanguage.json': 'extensions/javascript/syntaxes/JavaScriptReact.tmLanguage.json',
  'TypeScript.tmLanguage.json': 'extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json',
  'TypeScriptReact.tmLanguage.json': 'extensions/typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json',
  'python.tmLanguage.json': 'extensions/python/syntaxes/MagicPython.tmLanguage.json',
  'html.tmLanguage.json': 'extensions/html/syntaxes/html.tmLanguage.json',
  'css.tmLanguage.json': 'extensions/css/syntaxes/css.tmLanguage.json',
  'scss.tmLanguage.json': 'extensions/scss/syntaxes/scss.tmLanguage.json',
  'less.tmLanguage.json': 'extensions/less/syntaxes/less.tmLanguage.json',
  'json.tmLanguage.json': 'extensions/json/syntaxes/JSON.tmLanguage.json',
  'jsonc.tmLanguage.json': 'extensions/json/syntaxes/JSONC.tmLanguage.json',
  'markdown.tmLanguage.json': 'extensions/markdown-basics/syntaxes/markdown.tmLanguage.json',
  'yaml.tmLanguage.json': 'extensions/yaml/syntaxes/yaml.tmLanguage.json',
  'shell-unix-bash.tmLanguage.json': 'extensions/shellscript/syntaxes/shell-unix-bash.tmLanguage.json',
  'cpp.tmLanguage.json': 'extensions/cpp/syntaxes/cpp.tmLanguage.json',
  'go.tmLanguage.json': 'extensions/go/syntaxes/go.tmLanguage.json',
  'rust.tmLanguage.json': 'extensions/rust/syntaxes/rust.tmLanguage.json',
  'java.tmLanguage.json': 'extensions/java/syntaxes/java.tmLanguage.json',
  'xml.tmLanguage.json': 'extensions/xml/syntaxes/xml.tmLanguage.json',
  'php.tmLanguage.json': 'extensions/php/syntaxes/php.tmLanguage.json',
  'sql.tmLanguage.json': 'extensions/sql/syntaxes/sql.tmLanguage.json',
  'ini.tmLanguage.json': 'extensions/ini/syntaxes/ini.tmLanguage.json',
  'csharp.tmLanguage.json': 'extensions/csharp/syntaxes/csharp.tmLanguage.json',
  'ruby.tmLanguage.json': 'extensions/ruby/syntaxes/ruby.tmLanguage.json',
  'lua.tmLanguage.json': 'extensions/lua/syntaxes/lua.tmLanguage.json',
  'swift.tmLanguage.json': 'extensions/swift/syntaxes/swift.tmLanguage.json',
  'bat.tmLanguage.json': 'extensions/bat/syntaxes/batchfile.tmLanguage.json',
  'powershell.tmLanguage.json': 'extensions/powershell/syntaxes/powershell.tmLanguage.json',
};
const grammarsDest = join(VENDOR, 'grammars');
mkdirSync(grammarsDest, { recursive: true });
for (const [file, scope] of Object.entries(GRAMMARS)) {
  await fetchTo(RAW(GRAMMAR_PATHS[file]), join(grammarsDest, file));
}
writeFileSync(join(grammarsDest, 'manifest.json'), JSON.stringify(GRAMMARS, null, 2));

// 5. VS Code themes (JSONC partials; merged into self-contained strict JSON)
const themesDest = join(VENDOR, 'themes');
mkdirSync(themesDest, { recursive: true });
for (const name of ['dark_plus', 'light_plus', 'dark_vs', 'light_vs']) {
  await fetchTo(RAW(`extensions/theme-defaults/themes/${name}.json`), join(themesDest, `${name}.json`));
}
execSync(`node ${join(ROOT, 'scripts', 'merge-themes.mjs')}`, { stdio: 'inherit' });

rmSync(TMP, { recursive: true, force: true });
console.log('vendor: done.');
