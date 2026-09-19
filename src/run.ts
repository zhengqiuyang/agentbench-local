/**
 * run: execute every approved task against every configured agent inside a
 * SEALED workspace.
 *
 * Sealing (anti-cheat, per the Databricks git-history lesson): the agent
 * never works in your real repository. We materialize the base commit's
 * tree via a temporary `git worktree`, copy it out into an independent
 * directory, `git init` a fresh repository there and make a single orphan
 * commit of the tree. The agent sees: no remote, no reflog, no prior
 * history, no future commits - just "a repo with one commit". Your original
 * repository is never mutated (a linked worktree shares .git/config, so we
 * deliberately do NOT run `git remote remove` inside one - that would edit
 * YOUR repo's config; the copy-then-fresh-init approach needs no such
 * mutation). Residual risk is documented in the README threat model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRaw, gitText } from './git.js';
import type { BenchConfig } from './config.js';
import { type TaskRecord, attemptDirFor, approvedTaskIds, loadTask, workDirFor } from './tasks.js';
import { ensureDir, escapeInDoubleQuotes, nowIso, pkgRoot, quoteArg, rmrf, runShell, tail, writeJsonAtomic } from './util.js';

export const WORKDIR_INSTRUCTION = 'Work in the current directory. Do not create a new repository.';

export interface AttemptRecord {
  taskId: string;
  agent: string;
  command: string;
  baseCommit: string;
  /** SHA of the orphan base commit inside the sealed workspace. */
  baseSha: string;
  workdir: string;
  prompt: string;
  startedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  outputTail: string;
}

export interface RunOpts {
  agents?: string[];
  tasks?: string[];
  force?: boolean;
}

export interface RunSummary {
  ran: number;
  skippedExisting: number;
  errors: Array<{ taskId: string; agent: string; error: string }>;
}

/** Substitute template variables into an agent command line. */
export function renderCommand(
  template: string,
  vars: { prompt: string; workdir: string },
): string {
  // A multi-line prompt cannot ride inside a command line: newlines terminate
  // the command on every shell. The full prompt is always available to the
  // agent via the AGENTBENCH_PROMPT env var.
  const prompt = vars.prompt.replace(/\r?\n/g, ' ');
  return subVar(subVar(subVar(template, 'agentbench', pkgRoot()), 'workdir', vars.workdir), 'prompt', prompt);
}

/**
 * Substitute one variable, quote-context aware: `"{{var}}"` (placeholder
 * already inside double quotes) is escaped in place, a bare `{{var}}` is
 * wrapped in quotes. Blindly re-quoting produced `""path""`, which POSIX sh
 * reads as an unquoted path — a multi-line prompt then split the command
 * line and its tail executed as commands (Linux CI exit 127).
 */
function subVar(template: string, name: string, value: string): string {
  const quoted = new RegExp(`"\\{\\{${name}\\}\\}"`, 'g');
  const bare = new RegExp(`\\{\\{${name}\\}\\}`, 'g');
  return template.replace(quoted, escapeInDoubleQuotes(value)).replace(bare, quoteArg(value));
}

/**
 * Build the sealed workspace at `workdir` containing exactly the tree of
 * `baseCommit` as one orphan commit in a brand-new repository. Returns the
 * orphan commit SHA (the diff base used later by grade).
 */
export async function sealWorkspace(repoRoot: string, baseCommit: string, workdir: string): Promise<string> {
  const stagingParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-seal-'));
  const staging = path.join(stagingParent, 'wt');
  try {
    await gitText(['worktree', 'add', '--detach', staging, baseCommit], { cwd: repoRoot });

    rmrf(workdir);
    ensureDir(path.dirname(workdir));
    fs.cpSync(staging, workdir, {
      recursive: true,
      filter: (src: string) => path.basename(src) !== '.git',
    });
  } finally {
    // Remove the temporary worktree and its bookkeeping from the ORIGINAL
    // repo. `worktree remove` + `prune` restore the repo to its prior state.
    await gitRaw(['worktree', 'remove', '--force', staging], { cwd: repoRoot });
    await gitRaw(['worktree', 'prune'], { cwd: repoRoot });
    rmrf(stagingParent);
  }

  // Fresh, history-free repository containing exactly the base tree.
  await gitText(['init', '-q', '-b', 'main'], { cwd: workdir });
  await gitText(['config', 'user.email', 'agentbench@local'], { cwd: workdir });
  await gitText(['config', 'user.name', 'agentbench-local'], { cwd: workdir });
  await gitText(['config', 'core.autocrlf', 'false'], { cwd: workdir });
  await gitText(['config', 'core.filemode', 'false'], { cwd: workdir });
  await gitText(['add', '-A'], { cwd: workdir });
  await gitText(['commit', '-q', '-m', `agentbench sealed base (${baseCommit.slice(0, 12)})`], { cwd: workdir });
  return (await gitText(['rev-parse', 'HEAD'], { cwd: workdir })).trim();
}

async function runAttempt(
  cfg: BenchConfig,
  task: TaskRecord,
  agentName: string,
  agentCommand: string,
): Promise<'ran' | 'error'> {
  const workdir = workDirFor(cfg, task.id, agentName);
  const attemptDir = attemptDirFor(cfg, task.id, agentName);
  const attemptFile = path.join(attemptDir, 'attempt.json');

  let baseSha: string;
  try {
    baseSha = await sealWorkspace(cfg.repoRoot, task.baseCommit, workdir);
  } catch (e) {
    writeJsonAtomic(attemptFile, {
      taskId: task.id,
      agent: agentName,
      error: `sealing failed: ${String(e)}`,
      startedAt: nowIso(),
    } as Record<string, unknown>);
    return 'error';
  }

  const prompt = `${task.prompt.trim()}\n\n${WORKDIR_INSTRUCTION}`;
  const command = renderCommand(agentCommand, { prompt, workdir });
  const startedAt = new Date();
  const t0 = Date.now();

  const res = await runShell(command, {
    cwd: workdir,
    timeoutMs: cfg.run.timeoutSec * 1000,
    env: {
      AGENTBENCH: '1',
      AGENTBENCH_TASK: task.id,
      AGENTBENCH_AGENT: agentName,
      AGENTBENCH_PROMPT: prompt,
      AGENTBENCH_WORKDIR: workdir,
    },
  });

  const record: AttemptRecord = {
    taskId: task.id,
    agent: agentName,
    command,
    baseCommit: task.baseCommit,
    baseSha,
    workdir,
    prompt,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
    exitCode: res.code,
    timedOut: res.timedOut,
    outputTail: tail(res.stdout + (res.stderr ? '\n[stderr]\n' + res.stderr : ''), cfg.run.outputTailBytes),
  };
  writeJsonAtomic(attemptFile, record);
  console.log(
    `  [${task.id}/${agentName}] exit ${res.code}${res.timedOut ? ' (TIMEOUT)' : ''} in ${(record.durationMs / 1000).toFixed(1)}s`,
  );
  return 'ran';
}

export async function runAll(cfg: BenchConfig, opts: RunOpts = {}): Promise<RunSummary> {
  const wanted = opts.agents && opts.agents.length > 0 ? opts.agents : null;
  const agents = cfg.agents.filter((a) => !wanted || wanted.includes(a.name));
  if (agents.length === 0) throw new Error('no agents selected (check --agent names or agents: in agentbench.yaml)');

  // Default: only approved tasks are ever auto-run (review is the gate).
  // An explicit --task is deliberate human intent and overrides approval.
  const taskIds =
    opts.tasks && opts.tasks.length > 0 ? opts.tasks : approvedTaskIds(cfg);

  const summary: RunSummary = { ran: 0, skippedExisting: 0, errors: [] };
  const selected = taskIds
    .map((id) => loadTask(cfg, id))
    .filter((t): t is TaskRecord => t !== null);

  if (selected.length === 0) {
    console.log('no tasks to run. Mine first (`agentbench mine`), then approve (`agentbench review`).');
    return summary;
  }

  for (const task of selected) {
    for (const agent of agents) {
      const attemptFile = path.join(attemptDirFor(cfg, task.id, agent.name), 'attempt.json');
      if (!opts.force && fs.existsSync(attemptFile)) {
        summary.skippedExisting++;
        console.log(`  [${task.id}/${agent.name}] already run (use --force to redo)`);
        continue;
      }
      console.log(`  [${task.id}/${agent.name}] sealing base ${task.baseCommit.slice(0, 8)} and running...`);
      const outcome = await runAttempt(cfg, task, agent.name, agent.command);
      if (outcome === 'ran') summary.ran++;
      else summary.errors.push({ taskId: task.id, agent: agent.name, error: 'sealing failed' });
    }
  }
  return summary;
}
