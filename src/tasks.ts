/**
 * Task store: per-task YAML files plus the review index, all under
 * <repo>/.agentbench/. The index records curation decisions; only tasks
 * marked `approved` are ever executed by `run`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { BenchConfig } from './config.js';
import { ensureDir, writeFileAtomic } from './util.js';

export interface TaskVerification {
  command: string;
  env: Record<string, string>;
}

export interface TaskRecord {
  id: string;
  prNumber: number;
  prompt: string;
  baseCommit: string;
  headCommit: string;
  testFiles: string[];
  sourceFiles: string[];
  verification: TaskVerification;
  minedAt: string;
}

export type TaskStatus = 'pending' | 'approved' | 'rejected' | 'skipped';

export interface TaskIndex {
  statuses: Record<string, TaskStatus>;
}

export function abDir(cfg: BenchConfig): string {
  return path.join(cfg.repoRoot, '.agentbench');
}

export function tasksDir(cfg: BenchConfig): string {
  return path.join(abDir(cfg), 'tasks');
}

export function taskYamlPath(cfg: BenchConfig, id: string): string {
  return path.join(tasksDir(cfg), `${id}.yaml`);
}

/** Directory holding the PR-head blobs of the held-out test files. */
export function headTestsDir(cfg: BenchConfig, id: string): string {
  return path.join(tasksDir(cfg), id, 'head-tests');
}

export function workDirFor(cfg: BenchConfig, taskId: string, agent: string): string {
  return path.join(abDir(cfg), 'work', taskId, agent);
}

export function attemptDirFor(cfg: BenchConfig, taskId: string, agent: string): string {
  return path.join(abDir(cfg), 'attempts', taskId, agent);
}

export function listTaskIds(cfg: BenchConfig): string[] {
  const dir = tasksDir(cfg);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && f !== 'index.yaml')
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

export function loadTask(cfg: BenchConfig, id: string): TaskRecord | null {
  const p = taskYamlPath(cfg, id);
  if (!fs.existsSync(p)) return null;
  try {
    const t = parseYaml(fs.readFileSync(p, 'utf8')) as TaskRecord;
    if (!t || typeof t.id !== 'string') return null;
    return t;
  } catch {
    return null;
  }
}

export function listTasks(cfg: BenchConfig): TaskRecord[] {
  return listTaskIds(cfg)
    .map((id) => loadTask(cfg, id))
    .filter((t): t is TaskRecord => t !== null);
}

export function saveTask(cfg: BenchConfig, task: TaskRecord): void {
  const ordered: Record<string, unknown> = {
    id: task.id,
    prNumber: task.prNumber,
    prompt: task.prompt,
    baseCommit: task.baseCommit,
    headCommit: task.headCommit,
    testFiles: task.testFiles,
    sourceFiles: task.sourceFiles,
    verification: { command: task.verification.command, env: task.verification.env },
    minedAt: task.minedAt,
  };
  writeFileAtomic(taskYamlPath(cfg, task.id), stringifyYaml(ordered, { lineWidth: 120 }));
}

export function indexPath(cfg: BenchConfig): string {
  return path.join(tasksDir(cfg), 'index.yaml');
}

export function loadIndex(cfg: BenchConfig): TaskIndex {
  const p = indexPath(cfg);
  if (!fs.existsSync(p)) return { statuses: {} };
  try {
    const raw = parseYaml(fs.readFileSync(p, 'utf8')) as { statuses?: Record<string, string> } | null;
    const statuses: Record<string, TaskStatus> = {};
    for (const [k, v] of Object.entries(raw?.statuses ?? {})) {
      if (v === 'pending' || v === 'approved' || v === 'rejected' || v === 'skipped') {
        statuses[k] = v;
      }
    }
    return { statuses };
  } catch {
    return { statuses: {} };
  }
}

export function saveIndex(cfg: BenchConfig, index: TaskIndex): void {
  ensureDir(tasksDir(cfg));
  writeFileAtomic(indexPath(cfg), stringifyYaml({ statuses: index.statuses }, { lineWidth: 120 }));
}

/** Task ids that exist on disk and are approved for execution. */
export function approvedTaskIds(cfg: BenchConfig): string[] {
  const index = loadIndex(cfg);
  return listTaskIds(cfg).filter((id) => index.statuses[id] === 'approved');
}
