/**
 * review: the curation step. Auto-mined tasks are never run blindly -
 * a human approves, rejects or skips each one, and the decisions live in
 * tasks/index.yaml. Rejected tasks are never executed.
 */
import readline from 'node:readline/promises';
import type { BenchConfig } from './config.js';
import { type TaskIndex, type TaskStatus, loadIndex, listTasks, saveIndex } from './tasks.js';

function firstLine(s: string, max = 88): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '(empty prompt)';
  return line.length > max ? line.slice(0, max - 1) + '\u2026' : line;
}

export async function reviewAll(cfg: BenchConfig): Promise<number> {
  const index = loadIndex(cfg);
  const tasks = listTasks(cfg);
  let n = 0;
  for (const t of tasks) {
    if (index.statuses[t.id] !== 'approved') {
      index.statuses[t.id] = 'approved';
      n++;
    }
  }
  saveIndex(cfg, index);
  return n;
}

export function reviewList(cfg: BenchConfig): string[] {
  const index = loadIndex(cfg);
  const tasks = listTasks(cfg);
  if (tasks.length === 0) return ['no mined tasks - run `agentbench mine` first.'];
  const lines: string[] = [];
  const width = Math.max(...tasks.map((t) => t.id.length), 'task'.length);
  lines.push(`${'task'.padEnd(width)}  status    prompt`);
  lines.push(`${'-'.repeat(width)}  --------  ${'-'.repeat(60)}`);
  for (const t of tasks) {
    const status = (index.statuses[t.id] ?? 'pending').padEnd(8);
    lines.push(`${t.id.padEnd(width)}  ${status}  ${firstLine(t.prompt)}`);
  }
  const counts = countByStatus(index, tasks);
  lines.push('');
  lines.push(
    `approved: ${counts.approved ?? 0}  rejected: ${counts.rejected ?? 0}  skipped: ${counts.skipped ?? 0}  pending: ${counts.pending ?? 0}`,
  );
  return lines;
}

function countByStatus(index: TaskIndex, tasks: { id: string }[]): Partial<Record<TaskStatus, number>> {
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const t of tasks) {
    const s: TaskStatus = index.statuses[t.id] ?? 'pending';
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

export interface ReviewOutcome {
  approved: number;
  rejected: number;
  skipped: number;
}

export async function reviewInteractive(cfg: BenchConfig): Promise<ReviewOutcome> {
  const index = loadIndex(cfg);
  const tasks = listTasks(cfg).filter((t) => (index.statuses[t.id] ?? 'pending') === 'pending');
  const outcome: ReviewOutcome = { approved: 0, rejected: 0, skipped: 0 };
  if (tasks.length === 0) {
    console.log('no pending tasks. use --list to see current statuses.');
    return outcome;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const t of tasks) {
      console.log('');
      console.log(`--- ${t.id} (PR #${t.prNumber}) ---`);
      console.log(`prompt   : ${firstLine(t.prompt, 110)}`);
      console.log(`source   : ${t.sourceFiles.slice(0, 8).join(', ')}${t.sourceFiles.length > 8 ? ' (+more)' : ''}`);
      console.log(`tests    : ${t.testFiles.slice(0, 8).join(', ')}${t.testFiles.length > 8 ? ' (+more)' : ''}`);
      console.log(`verify   : ${t.verification.command}`);
      let showDetails = true;
      while (showDetails) {
        showDetails = false;
        const answer = (await rl.question('[a]pprove / [r]eject / [s]kip / [d]etails / [q]uit (Enter = approve): ')).trim().toLowerCase();
        if (answer === '' || answer === 'a' || answer === 'y') {
          index.statuses[t.id] = 'approved';
          outcome.approved++;
        } else if (answer === 'r' || answer === 'n') {
          index.statuses[t.id] = 'rejected';
          outcome.rejected++;
        } else if (answer === 's') {
          index.statuses[t.id] = 'skipped';
          outcome.skipped++;
        } else if (answer === 'd') {
          console.log('');
          console.log(t.prompt);
          console.log('');
          console.log(`all source files: ${t.sourceFiles.join(', ')}`);
          console.log(`all test files  : ${t.testFiles.join(', ')}`);
          showDetails = true;
        } else if (answer === 'q') {
          saveIndex(cfg, index);
          return outcome;
        } else {
          console.log('unrecognized answer, try again.');
          showDetails = true;
        }
        saveIndex(cfg, index);
      }
    }
  } finally {
    rl.close();
  }
  return outcome;
}
