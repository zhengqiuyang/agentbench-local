import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildFixtureRepo, fgitOk, GREET_TEST_HEAD, type FixtureRepo } from './fixture.js';
import { cmdInit } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { headTestsDir, listTaskIds, loadIndex, loadTask, workDirFor } from '../src/tasks.js';
import { runAll } from '../src/run.js';
import { gradeAll } from '../src/grade.js';
import { report } from '../src/report.js';
import { readJson, rmrf } from '../src/util.js';
import type { AttemptRecord } from '../src/run.js';
import type { GradeResult } from '../src/grade.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('e2e: init -> mine -> review --all -> run -> grade -> report closes the loop', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-e2e-'));
  try {
    const fx: FixtureRepo = await buildFixtureRepo(path.join(tmp, 'repo'));

    // --- init (writes agentbench.yaml + mines) ---
    const initArgs = {
      command: 'init',
      positionals: [fx.root],
      flags: new Map<string, string | true>(),
    };
    const init = await cmdInit(fx.root, initArgs);
    assert.ok(init.created, 'agentbench.yaml should have been created');
    assert.ok(fs.existsSync(path.join(fx.root, 'agentbench.yaml')));

    // --- mine: exactly one good task; the other two PRs filtered for the right reasons ---
    assert.equal(init.mineSummary.kept.length, 1, `kept tasks: ${JSON.stringify(init.mineSummary.kept)}`);
    const kept = init.mineSummary.kept[0]!;
    assert.equal(kept.id, 'pr-7');
    assert.deepEqual(listTaskIds(loadConfigFor(fx)), ['pr-7']);

    const reasons = init.mineSummary.skipped.map((s) => ({ id: s.id, reason: s.reason }));
    assert.ok(
      reasons.some((r) => r.id === 'pr-8' && /no test files/.test(r.reason)),
      `pr-8 should be filtered for missing tests, got: ${JSON.stringify(reasons)}`,
    );
    assert.ok(
      reasons.some((r) => r.id === 'pr-9' && /exclude pattern/.test(r.reason)),
      `pr-9 should be filtered by subject pattern, got: ${JSON.stringify(reasons)}`,
    );

    const cfg = loadConfigFor(fx);
    const task = loadTask(cfg, 'pr-7')!;
    assert.ok(task, 'pr-7 task yaml must exist');
    assert.equal(task.baseCommit, fx.goodBaseCommit);
    assert.equal(task.headCommit, fx.goodHeadCommit);
    assert.deepEqual(task.testFiles, ['src/greet.test.js']);
    assert.deepEqual(task.sourceFiles, ['src/greet.js']);
    assert.equal(task.verification.command, 'npm test');
    assert.ok(task.prompt.includes('Fix greet to return a proper greeting'));
    assert.ok(!task.prompt.includes('Merge pull request'));

    // held-out test blob snapshotted from the PR head
    const heldOut = fs.readFileSync(path.join(headTestsDir(cfg, 'pr-7'), 'src', 'greet.test.js'), 'utf8');
    assert.equal(heldOut, GREET_TEST_HEAD);

    // mine is idempotent
    const { mine } = await import('../src/mine.js');
    const again = await mine(cfg);
    assert.equal(again.kept.length, 1);
    assert.equal(again.kept[0]!.existing, true);
    assert.deepEqual(listTaskIds(cfg), ['pr-7']);

    // --- review --all ---
    const { reviewAll } = await import('../src/review.js');
    const approvedCount = await reviewAll(cfg);
    assert.equal(approvedCount, 1);
    assert.equal(loadIndex(cfg).statuses['pr-7'], 'approved');

    // --- run (fake agent) ---
    const runSummary = await runAll(cfg, {});
    assert.equal(runSummary.ran, 1);
    assert.equal(runSummary.errors.length, 0);

    const attemptDir = path.join(fx.root, '.agentbench', 'attempts', 'pr-7', 'fake');
    const attempt = readJson<AttemptRecord>(path.join(attemptDir, 'attempt.json'))!;
    assert.ok(attempt, 'attempt.json must exist');
    assert.equal(attempt.exitCode, 0);
    assert.equal(attempt.timedOut, false);
    assert.ok(attempt.durationMs >= 0);
    assert.ok(attempt.outputTail.includes('[fake-agent]'), 'output tail should capture agent output');
    assert.ok(attempt.prompt.includes('Work in the current directory. Do not create a new repository.'));
    assert.ok(attempt.command.includes('fake-agent.js'), 'command template should reference the demo agent');

    // --- anti-cheat assertions ---
    const workdir = workDirFor(cfg, 'pr-7', 'fake');
    assert.ok(fs.existsSync(path.join(workdir, '.git')), 'sealed workspace must be a git repo');
    const orphanCount = (await fgitOk(workdir, ['rev-list', '--count', 'HEAD'])).trim();
    assert.equal(orphanCount, '1', 'sealed workspace must contain exactly one (orphan) commit');
    const sealedRemotes = (await fgitOk(workdir, ['remote'])).trim();
    assert.equal(sealedRemotes, '', 'sealed workspace must have no remotes');
    // and must NOT be a linked worktree of the original repo
    assert.ok(
      fs.statSync(path.join(workdir, '.git')).isDirectory() && !fs.existsSync(path.join(workdir, '.git', 'gitdir')),
      'sealed .git must be a real standalone repo, not a worktree pointer',
    );

    // original repo untouched: remote, tip, history length
    assert.equal((await fgitOk(fx.root, ['remote'])).trim(), 'origin');
    assert.equal((await fgitOk(fx.root, ['rev-parse', 'HEAD'])).trim(), fx.headCommit);
    assert.equal(parseInt((await fgitOk(fx.root, ['rev-list', '--count', 'HEAD'])).trim(), 10), fx.commitCount);
    const worktreeLines = (await fgitOk(fx.root, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((l) => l.startsWith('worktree '));
    assert.equal(worktreeLines.length, 1, 'no leftover worktrees in the original repo after run');

    // --- grade ---
    const results = await gradeAll(cfg, {});
    assert.equal(results.length, 1);
    const result = readJson<GradeResult>(path.join(attemptDir, 'result.json'))!;
    assert.ok(result, 'result.json must exist');
    assert.equal(
      result.status,
      'pass',
      `fake agent fix should make the held-out test pass (patch ${result.patchBytes}B, verifyExit ${result.verifyExit})\n${result.verifyTail}`,
    );
    assert.ok(result.patchBytes > 0, 'patch must be non-empty');
    assert.ok(fs.existsSync(path.join(attemptDir, 'patch.diff')));
    assert.equal(result.filesChanged, 1);
    assert.ok(result.insertions >= 1);
    assert.equal(result.verifyExit, 0);
    assert.ok(result.verifyDurationMs != null && result.verifyDurationMs > 0);
    assert.equal(result.costTokens, null, 'fake agent has no transcripts -> null cost');

    const patch = fs.readFileSync(path.join(attemptDir, 'patch.diff'), 'utf8');
    assert.ok(patch.includes('hello'), 'patch should carry the fake agent fix');

    // verifier worktrees cleaned up
    const worktreeLinesAfter = (await fgitOk(fx.root, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((l) => l.startsWith('worktree '));
    assert.equal(worktreeLinesAfter.length, 1, 'grade must remove its verifier worktrees');

    // --- report ---
    const outcome = report(cfg, {});
    assert.ok(fs.existsSync(outcome.htmlPath), 'report.html must exist');
    assert.ok(fs.existsSync(outcome.mdPath), 'report.md must exist');
    const html = fs.readFileSync(outcome.htmlPath, 'utf8');
    assert.ok(html.includes('pr-7'));
    assert.ok(html.includes('fake'));
    assert.ok(html.includes('PASS'));
    assert.ok(!/src=|href=|@import/.test(html), 'html must be self-contained (no external assets)');
    const md = fs.readFileSync(outcome.mdPath, 'utf8');
    assert.ok(md.includes('| fake |'));
    assert.ok(md.includes('100%'));
  } finally {
    rmrf(tmp);
  }
});

test('e2e: run refuses unreviewed tasks and reuses attempts without --force', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-e2e2-'));
  try {
    const fx = await buildFixtureRepo(path.join(tmp, 'repo'));
    await cmdInit(fx.root, { command: 'init', positionals: [fx.root], flags: new Map() });
    const cfg = loadConfigFor(fx);

    // No review yet -> nothing approved -> run does nothing.
    const empty = await runAll(cfg, {});
    assert.equal(empty.ran, 0);

    // Rejected tasks are never auto-run.
    const { saveIndex, loadIndex: li } = await import('../src/tasks.js');
    const idx = li(cfg);
    idx.statuses['pr-7'] = 'rejected';
    saveIndex(cfg, idx);
    const rejectedRun = await runAll(cfg, {});
    assert.equal(rejectedRun.ran, 0, 'rejected task must not run');

    // Approve, run, then run again -> skippedExisting.
    const idx2 = li(cfg);
    idx2.statuses['pr-7'] = 'approved';
    saveIndex(cfg, idx2);
    assert.equal((await runAll(cfg, {})).ran, 1);
    const rerun = await runAll(cfg, {});
    assert.equal(rerun.ran, 0);
    assert.equal(rerun.skippedExisting, 1);
    assert.equal((await runAll(cfg, { force: true })).ran, 1);
  } finally {
    rmrf(tmp);
  }
});

test('e2e: CLI help smoke test (built bin)', () => {
  const cli = path.join(pkgRoot, 'dist', 'src', 'cli.js');
  const r = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('agentbench'), r.stdout);
  assert.ok(r.stdout.includes('mine'));
  const bad = spawnSync(process.execPath, [cli, 'nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

test('e2e: cli main() grades a wrong-fix attempt as fail', async () => {
  // Simulate a "bad agent": overwrite the attempt so grading sees a patch
  // that does NOT fix the bug - verification must fail (not error).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-e2e3-'));
  try {
    const fx = await buildFixtureRepo(path.join(tmp, 'repo'));
    await cmdInit(fx.root, { command: 'init', positionals: [fx.root], flags: new Map() });
    const cfg = loadConfigFor(fx);
    const { reviewAll } = await import('../src/review.js');
    await reviewAll(cfg);

    // Run a "bad" agent: appends a comment (patch exists) but never fixes
    // the marker, so the held-out tests must fail.
    cfg.agents = [
      {
        name: 'fake',
        command: `node -e "require('node:fs').appendFileSync(process.argv[1], '\\n// no fix\\n')" {{workdir}}/src/greet.js`,
      },
    ];
    const runSummary = await runAll(cfg, {});
    assert.equal(runSummary.ran, 1);
    const results = await gradeAll(cfg, {});
    assert.equal(results.length, 1);
    const result0 = results[0]!;
    assert.equal(
      result0.status,
      'fail',
      `an attempt that leaves the bug unfixed must FAIL verification (verifyExit ${result0.verifyExit})\n${result0.verifyTail}`,
    );
    assert.notEqual(results[0]!.verifyExit, 0);
    assert.ok(results[0]!.patchBytes > 0);
  } finally {
    rmrf(tmp);
  }
});

function loadConfigFor(fx: FixtureRepo) {
  return loadConfig(fx.root);
}
