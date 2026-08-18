// VS Code theme-defaults ship as JSONC partials with an include chain
// (dark_plus -> dark_vs). The browser fetches strict JSON, so this merges
// each pair into one self-contained theme file the client can JSON.parse.
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'vendor', 'themes');

/**
 * Strip // and /* *\/ comments and trailing commas from JSONC.
 * String-aware: string literals are copied verbatim (escapes included), so a
 * `,}` sequence inside a string value is never mangled, and comments inside
 * strings are not stripped. A trailing comma is dropped only when it is the
 * last item before a closing `}` or `]` (whitespace between them allowed).
 */
export function stripJsonc(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '"') {
      // Copy the whole string literal verbatim, honoring backslash escapes.
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '"') break;
        j++;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === ',') {
      // Peek ahead (skipping whitespace): drop the comma only when the next
      // non-whitespace char closes the current object/array.
      let j = i + 1;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
      if (j < n && (s[j] === '}' || s[j] === ']')) {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function readJsonc(name) {
  return JSON.parse(stripJsonc(readFileSync(join(DIR, name), 'utf8')));
}

function merge(plusName, vsName) {
  const plus = readJsonc(plusName);
  const vs = readJsonc(vsName);
  const colors = { ...(vs.colors ?? {}), ...(plus.colors ?? {}) };
  const bg = colors['editor.background'] ?? '#1e1e1e';
  const lum = parseInt(bg.replace('#', ''), 16);
  const type = Number.isNaN(lum) ? 'dark' : (lum > 0x888888 ? 'light' : 'dark');
  const merged = {
    name: plus.name ?? vs.name,
    type: plus.type ?? vs.type ?? type,
    colors,
    tokenColors: [...(vs.tokenColors ?? []), ...(plus.tokenColors ?? [])],
    semanticTokenColors: { ...(vs.semanticTokenColors ?? {}), ...(plus.semanticTokenColors ?? {}) },
  };
  writeFileSync(join(DIR, plusName), JSON.stringify(merged, null, 2));
  console.log(`theme: merged ${plusName} (+${vsName}) -> ${merged.tokenColors.length} tokenColors, type=${merged.type}, bg=${bg}`);
}

merge('dark_plus.json', 'dark_vs.json');
merge('light_plus.json', 'light_vs.json');
// drop the intermediate base files
for (const f of ['dark_vs.json', 'light_vs.json']) {
  try {
    if (existsSync(join(DIR, f))) rmSync(join(DIR, f));
  } catch { /* ignore */ }
}
console.log('theme merge done.');
