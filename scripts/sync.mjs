// Keeps lib/ in sync with src/ — the server and client bundles have a single
// source of truth under src/, and lib/ ships the same files (package main /
// exports point at lib/). Run `node scripts/sync.mjs` to copy, or with
// `--check` to fail when they differ (CI / prepack gate).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const FILES = ['index.js', 'client.js'];
let failed = false;

for (const file of FILES) {
  const srcPath = join(ROOT, 'src', file);
  const libPath = join(ROOT, 'lib', file);
  const content = readFileSync(srcPath, 'utf8');
  const inSync = existsSync(libPath) && readFileSync(libPath, 'utf8') === content;
  if (inSync) {
    if (!check) console.log(`sync: lib/${file} already in sync`);
    continue;
  }
  if (check) {
    console.error(`sync: lib/${file} differs from src/${file} — run "npm run sync"`);
    failed = true;
  } else {
    writeFileSync(libPath, content);
    console.log(`sync: copied src/${file} -> lib/${file}`);
  }
}

if (check && failed) process.exit(1);
