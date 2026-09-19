#!/usr/bin/env node
/**
 * Portable test launcher (house pattern).
 *
 * Enumerates dist/test/*.test.js explicitly and execs `node --test <files>`.
 * Never passes glob arguments to node --test, because glob expansion is a
 * shell feature and behaves differently across cmd.exe, PowerShell and sh.
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(here, 'dist', 'test');

if (!existsSync(testDir)) {
  console.error('dist/test not found - run `npm run build` first.');
  process.exit(1);
}

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(testDir, f));

if (files.length === 0) {
  console.error('no *.test.js files found in dist/test.');
  process.exit(1);
}

console.log(`running ${files.length} test file(s):`);
for (const f of files) console.log('  ' + path.relative(here, f));
console.log('');

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
});
process.exit(result.status === null ? 1 : result.status);
