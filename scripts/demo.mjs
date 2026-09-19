#!/usr/bin/env node
/**
 * End-to-end demo against a generated fixture repository - zero real
 * agents, zero network. Exercises the actual CLI: init -> mine ->
 * review --all -> run -> grade -> report, prints the leaderboard, confirms
 * report.html exists, then cleans up all demo artifacts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'src', 'cli.js');

if (!fs.existsSync(cli)) {
  console.error('dist not built - run `npm run build` first.');
  process.exit(1);
}

function run(label, args) {
  console.log(`\n$ agentbench ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    // throw (do NOT process.exit) so the finally block still cleans up
    throw new Error(`demo step failed (${label}) with exit ${r.status}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-demo-'));
let failed = false;
try {
  const repo = path.join(tmp, 'fixture-repo');
  console.log('=== agentbench-local demo ===');
  console.log(`building fixture repository at ${repo} (3 merged PRs: one good, one chore, one no-test) ...`);

  const { buildFixtureRepo } = await import(pathToFileURL(path.join(root, 'dist', 'test', 'fixture.js')).href);
  await buildFixtureRepo(repo);

  run('init', ['init', repo]);
  run('mine', ['mine', '--repo', repo]);
  run('review', ['review', '--all', '--repo', repo]);
  run('review list', ['review', '--list', '--repo', repo]);
  run('run', ['run', '--repo', repo]);
  run('grade', ['grade', '--repo', repo]);
  run('report', ['report', '--repo', repo]);

  const htmlPath = path.join(repo, '.agentbench', 'report.html');
  const mdPath = path.join(repo, '.agentbench', 'report.md');
  if (!fs.existsSync(htmlPath)) throw new Error('report.html was not generated');
  const size = fs.statSync(htmlPath).size;
  console.log(`\nOK: report.html exists (${size} bytes) at ${htmlPath}`);
  console.log(`OK: report.md exists at ${mdPath}`);
} catch (e) {
  console.error(String(e));
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  console.log(`\ncleaned up demo artifacts (${tmp})`);
}
if (failed) process.exitCode = 1;
