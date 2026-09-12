// Test runner for `npm test`.
//
// Runs every suite even when one fails. The previous `node server-test.mjs &&
// node smoke-client.cjs` chain stopped at the first non-zero exit, so a crash
// in the server suite silently hid the client smoke test — the suite reported
// one failure while never running the other half. Aggregating here keeps the
// output honest on every platform (no shell-specific chaining).
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = ['scripts/server-test.mjs', 'scripts/smoke-client.cjs'];

const failed = [];
for (const suite of SUITES) {
  console.log(`\n── ${suite} ──`);
  const result = spawnSync(process.execPath, [join(ROOT, suite)], { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0) failed.push(suite);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} suite(s) failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nall suites passed');
