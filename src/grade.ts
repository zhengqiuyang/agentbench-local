/**
 * grade: turn each attempt into a verdict.
 *
 * 1. Diff the sealed workspace against its orphan base commit (staging any
 *    untracked work first, so new files count as part of the patch).
 *    Empty diff -> "no-change".
 * 2. Apply the patch to a fresh verifier worktree of the ORIGINAL repo at
 *    the task's base commit. If it does not apply -> "patch-conflict".
 * 3. Copy the task's HELD-OUT test files (snapshotted from the PR head at
 *    mine time - the ground-truth tests) over the verifier tree.
 * 4. Run the task's verification command. Exit 0 -> "pass", else "fail".
 *
 * We require only after-pass (not a strict fail-to-pass proof): the base
 * state is the pre-fix tree by construction, and the before-run was
 * deliberately omitted to halve grading cost. See README "Grading
 * semantics".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRaw, gitText } from './git.js';
import type { BenchConfig } from './config.js';
import {
  type TaskRecord,
  attemptDirFor,
  headTestsDir,
  loadTask,
} from './tasks.js';
import type { AttemptRecord } from './run.js';
import { estimateTokens } from './cost.js';
import { copyTree, nowIso, readJson, rmrf, runShell, tail, writeJsonAtomic, ensureDir } from './util.js';

export type GradeStatus = 'pass' | 'fail' | 'no-change' | 'patch-conflict' | 'error';

export interface GradeResult {
  taskId: string;
  agent: string;
  status: GradeStatus;
  filesChanged: number;
  insertions: number;
  deletions: number;
  patchBytes: number;
  applyMode: 'strict' | 'whitespace' | null;
  verifyExit: number | null;
  verifyDurationMs: number | null;
  verifyTail: string;
  agentDurationMs: number | null;
  costTokens: number | null;
  error?: string;
  gradedAt: string;
}

export interface GradeOpts {
  tasks?: string[];
  agents?: string[];
}

function emptyResult(taskId: string, agent: string, status: GradeStatus, error?: string): GradeResult {
  return {
    taskId,
    agent,
    status,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    patchBytes: 0,
    applyMode: null,
    verifyExit: null,
    verifyDurationMs: null,
    verifyTail: '',
    agentDurationMs: null,
    costTokens: null,
    error,
    gradedAt: nowIso(),
  };
}

export function listAttemptDirs(cfg: BenchConfig): Array<{ taskId: string; agent: string; dir: string }> {
  const root = path.join(cfg.repoRoot, '.agentbench', 'attempts');
  const out: Array<{ taskId: string; agent: string; dir: string }> = [];
  if (!fs.existsSync(root)) return out;
  for (const taskId of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!taskId.isDirectory()) continue;
    for (const agent of fs.readdirSync(path.join(root, taskId.name), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!agent.isDirectory()) continue;
      out.push({ taskId: taskId.name, agent: agent.name, dir: path.join(root, taskId.name, agent.name) });
    }
  }
  return out;
}

export function parseDiffStat(stat: string): { files: number; insertions: number; deletions: number } {
  const line = stat.trim().split('\n').filter(Boolean).pop() ?? '';
  const files = line.match(/^\s*(\d+) files? changed/);
  const ins = line.match(/(\d+) insertions?\(\+\)/);
  const del = line.match(/(\d+) deletions?\(-\)/);
  return {
    files: files ? parseInt(files[1]!, 10) : 0,
    insertions: ins ? parseInt(ins[1]!, 10) : 0,
    deletions: del ? parseInt(del[1]!, 10) : 0,
  };
}

export async function gradeAll(cfg: BenchConfig, opts: GradeOpts = {}): Promise<GradeResult[]> {
  const results: GradeResult[] = [];
  for (const { taskId, agent, dir } of listAttemptDirs(cfg)) {
    if (opts.tasks && opts.tasks.length > 0 && !opts.tasks.includes(taskId)) continue;
    if (opts.agents && opts.agents.length > 0 && !opts.agents.includes(agent)) continue;
    const result = await gradeAttempt(cfg, taskId, agent, dir);
    writeJsonAtomic(path.join(dir, 'result.json'), result);
    const label = result.status.toUpperCase().padEnd(13);
    console.log(`  [${taskId}/${agent}] ${label}${result.error ? result.error : ''}`);
    results.push(result);
  }
  if (results.length === 0) console.log('no attempts to grade. run `agentbench run` first.');
  return results;
}

async function gradeAttempt(
  cfg: BenchConfig,
  taskId: string,
  agent: string,
  dir: string,
): Promise<GradeResult> {
  const attempt = readJson<AttemptRecord>(path.join(dir, 'attempt.json'));
  if (!attempt || !attempt.workdir) {
    return emptyResult(taskId, agent, 'error', 'attempt.json missing or unreadable');
  }
  const task: TaskRecord | null = loadTask(cfg, taskId);
  if (!task) return emptyResult(taskId, agent, 'error', 'task yaml missing');
  const cost = estimateTokens(agent, attempt);
  const base: Omit<GradeResult, 'status' | 'applyMode' | 'verifyExit' | 'verifyDurationMs' | 'verifyTail'> = {
    taskId,
    agent,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    patchBytes: 0,
    agentDurationMs: attempt.durationMs ?? null,
    costTokens: cost,
    gradedAt: nowIso(),
  };

  if (!fs.existsSync(attempt.workdir)) {
    return { ...emptyResult(taskId, agent, 'error', 'sealed work dir missing'), ...base };
  }

  // 1. Capture the patch: stage untracked work, then diff working tree vs
  //    the orphan base commit (covers both committed and uncommitted work).
  await gitRaw(['add', '-A'], { cwd: attempt.workdir });
  const diff = await gitRaw(['diff', '--binary', '--full-index', attempt.baseSha], { cwd: attempt.workdir });
  if (diff.code !== 0) {
    return { ...emptyResult(taskId, agent, 'error', `git diff failed: ${diff.stderr.trim().slice(0, 200)}`), ...base };
  }
  const patch = diff.stdout;
  const statRes = await gitRaw(['diff', '--stat', attempt.baseSha], { cwd: attempt.workdir });
  const stat = parseDiffStat(statRes.stdout);
  base.filesChanged = stat.files;
  base.insertions = stat.insertions;
  base.deletions = stat.deletions;
  base.patchBytes = Buffer.byteLength(patch, 'utf8');

  if (patch.trim().length === 0) {
    return { ...base, status: 'no-change', applyMode: null, verifyExit: null, verifyDurationMs: null, verifyTail: '' };
  }

  const patchFile = path.join(dir, 'patch.diff');
  ensureDir(dir);
  fs.writeFileSync(patchFile, patch);

  // 2-4. Fresh verifier worktree of the ORIGINAL repo at the task base.
  const verParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-grade-'));
  const ver = path.join(verParent, 'wt');
  try {
    try {
      await gitText(['worktree', 'add', '--detach', ver, task.baseCommit], { cwd: cfg.repoRoot });
    } catch (e) {
      return { ...base, status: 'error', applyMode: null, verifyExit: null, verifyDurationMs: null, verifyTail: '', error: `verifier worktree failed: ${String(e).slice(0, 200)}` };
    }
    // Normalize line endings for reproducible patch application.
    await gitRaw(['config', 'core.autocrlf', 'false'], { cwd: ver });
    await gitRaw(['checkout', '-f', '--', '.'], { cwd: ver });

    let applyMode: 'strict' | 'whitespace' | null = null;
    if ((await gitRaw(['apply', '--check', patchFile], { cwd: ver })).code === 0) {
      applyMode = 'strict';
    } else if ((await gitRaw(['apply', '--check', '--ignore-whitespace', patchFile], { cwd: ver })).code === 0) {
      applyMode = 'whitespace';
    }
    if (!applyMode) {
      return { ...base, status: 'patch-conflict', applyMode: null, verifyExit: null, verifyDurationMs: null, verifyTail: '' };
    }
    const applied = await gitRaw(
      ['apply', ...(applyMode === 'whitespace' ? ['--ignore-whitespace'] : []), patchFile],
      { cwd: ver },
    );
    if (applied.code !== 0) {
      return { ...base, status: 'patch-conflict', applyMode: null, verifyExit: null, verifyDurationMs: null, verifyTail: applied.stderr.slice(0, 2000) };
    }

    // Held-out tests from the PR head overwrite the base versions.
    const htRoot = headTestsDir(cfg, taskId);
    if (fs.existsSync(htRoot)) copyTree(htRoot, ver);

    const t0 = Date.now();
    const vres = await runShell(task.verification.command, {
      cwd: ver,
      timeoutMs: cfg.verification.timeoutSec * 1000,
      env: {
        AGENTBENCH: '1',
        AGENTBENCH_TASK: taskId,
        AGENTBENCH_AGENT: agent,
        ...task.verification.env,
      },
    });
    const combined = vres.stdout + (vres.stderr ? '\n[stderr]\n' + vres.stderr : '');
    return {
      ...base,
      status: vres.code === 0 ? 'pass' : 'fail',
      applyMode,
      verifyExit: vres.code,
      verifyDurationMs: Date.now() - t0,
      verifyTail: tail(combined, 32 * 1024),
    };
  } finally {
    await gitRaw(['worktree', 'remove', '--force', ver], { cwd: cfg.repoRoot });
    await gitRaw(['worktree', 'prune'], { cwd: cfg.repoRoot });
    rmrf(verParent);
  }
}
