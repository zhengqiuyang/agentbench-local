#!/usr/bin/env node
/**
 * agentbench - local, per-repository benchmark harness for CLI coding agents.
 *
 *   agentbench init <repoPath>   write agentbench.yaml and mine tasks
 *   agentbench mine              mine tasks from merged PRs
 *   agentbench review            curate mined tasks (--all / --list)
 *   agentbench run               run agents on approved tasks in sealed workspaces
 *   agentbench grade             grade attempts with held-out tests
 *   agentbench report            leaderboard (console + report.md + report.html)
 *
 * Global flags: --repo <path> (default: cwd), --config <path>.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { repoRootAt } from './git.js';
import {
  type BenchConfig,
  configPathFor,
  defaultConfigText,
  loadConfig,
} from './config.js';
import { mine } from './mine.js';
import { reviewAll, reviewInteractive, reviewList } from './review.js';
import { runAll } from './run.js';
import { gradeAll } from './grade.js';
import { report } from './report.js';

export const VERSION = '0.1.0';

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--repo', '--config', '--max', '--since', '--agent', '--task', '--format']);

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      parsed.flags.set('--help', true);
    } else if (a === '--version' || a === '-v') {
      parsed.flags.set('--version', true);
    } else if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) {
        parsed.flags.set(a, argv[++i] ?? '');
      } else {
        parsed.flags.set(a, true);
      }
    } else if (a === 'help') {
      parsed.command = 'help';
    } else if (!parsed.command) {
      parsed.command = a;
    } else {
      parsed.positionals.push(a);
    }
  }
  return parsed;
}

function repeated(flags: Map<string, string | true>, name: string): string[] {
  // The simple parser keeps the last value; support comma-separated too.
  const v = flags.get(name);
  if (typeof v !== 'string' || v === '') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function flagNum(flags: Map<string, string | true>, name: string): number | undefined {
  const v = flags.get(name);
  if (typeof v !== 'string' || v === '') return undefined;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) throw new Error(`${name} expects a positive integer, got "${v}"`);
  return n;
}

export function usage(): string {
  return `agentbench ${VERSION} - SWE-bench, but for YOUR repo, on YOUR machine, zero task authoring.

usage:
  agentbench init <repoPath>          write agentbench.yaml into a repo, then mine
  agentbench mine [--max N] [--since 6mo]
                                      turn merged PRs into tasks/<id>.yaml
  agentbench review [--all | --list]  curate: approve / reject / skip each task
  agentbench run [--agent a,b] [--task id] [--force]
                                      run agents on approved tasks (sealed workspaces)
  agentbench grade [--agent a,b] [--task id]
                                      apply patches, run held-out tests, verdicts
  agentbench report [--format table|markdown|html]
                                      leaderboard -> .agentbench/report.{md,html}

global flags:
  --repo <path>     target repository (default: current directory)
  --config <path>   explicit agentbench.yaml path
  --help, --version

state lives in <repo>/.agentbench/ (tasks, workspaces, attempts, reports).
add ".agentbench/" to the repo's .gitignore.`;
}

async function resolveConfig(args: ParsedArgs, explicitRepo?: string): Promise<BenchConfig> {
  const repoFlag = typeof args.flags.get('--repo') === 'string' ? (args.flags.get('--repo') as string) : undefined;
  const cwd = explicitRepo ?? repoFlag ?? process.cwd();
  const repoRoot = await repoRootAt(cwd);
  const configFlag = typeof args.flags.get('--config') === 'string' ? (args.flags.get('--config') as string) : undefined;
  return loadConfig(repoRoot, { configPath: configFlag });
}

export interface InitOutcome {
  repoRoot: string;
  configPath: string;
  created: boolean;
  mineSummary: Awaited<ReturnType<typeof mine>>;
}

export async function cmdInit(repoPath: string, args: ParsedArgs): Promise<InitOutcome> {
  const abs = path.resolve(repoPath);
  if (!fs.existsSync(abs)) throw new Error(`path does not exist: ${abs}`);
  const repoRoot = await repoRootAt(abs);
  const configPath = configPathFor(repoRoot);
  let created = false;
  if (fs.existsSync(configPath)) {
    console.log(`agentbench.yaml already exists at ${configPath} - keeping it.`);
  } else {
    fs.writeFileSync(configPath, defaultConfigText());
    created = true;
    console.log(`wrote ${configPath}`);
  }
  console.log('next: consider adding ".agentbench/" to this repo\'s .gitignore.');
  console.log('');
  const cfg = await resolveConfig(args, repoRoot);
  const summary = await mineWithBanner(cfg, args);
  console.log('');
  console.log('next steps:');
  console.log('  1. agentbench review          # curate tasks (or: agentbench review --all)');
  console.log('  2. agentbench run             # run every approved task x every agent');
  console.log('  3. agentbench grade           # held-out tests decide pass/fail');
  console.log('  4. agentbench report          # local leaderboard');
  return { repoRoot, configPath, created, mineSummary: summary };
}

async function mineWithBanner(cfg: BenchConfig, args: ParsedArgs): Promise<Awaited<ReturnType<typeof mine>>> {
  console.log(`mining ${cfg.mining.strategy}-style PRs in ${cfg.repoRoot} ...`);
  const summary = await mine(cfg, {
    max: flagNum(args.flags, '--max'),
    since: typeof args.flags.get('--since') === 'string' ? (args.flags.get('--since') as string) : undefined,
  });
  for (const k of summary.kept) {
    console.log(`  kept    ${k.id}  ${k.existing ? '(already mined)' : '(new)'} - ${firstLine(k.prompt)}`);
  }
  for (const s of summary.skipped) {
    console.log(`  skipped ${s.id}  (${s.reason})`);
  }
  console.log(
    `${summary.kept.length} task(s) mined, ${summary.skipped.length} filtered (candidates scanned: ${summary.candidates}).`,
  );
  return summary;
}

function firstLine(s: string, max = 72): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '\u2026' : line;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has('--version')) {
    console.log(VERSION);
    return 0;
  }
  const command = args.command ?? (args.flags.has('--help') ? 'help' : undefined);
  try {
    switch (command) {
      case undefined:
      case 'help': {
        console.log(usage());
        return command === undefined ? 1 : 0;
      }
      case 'init': {
        const repoPath = args.positionals[0];
        if (!repoPath) {
          console.error('usage: agentbench init <repoPath>');
          return 1;
        }
        await cmdInit(repoPath, args);
        return 0;
      }
      case 'mine': {
        const cfg = await resolveConfig(args);
        await mineWithBanner(cfg, args);
        return 0;
      }
      case 'review': {
        const cfg = await resolveConfig(args);
        if (args.flags.has('--list')) {
          console.log(reviewList(cfg).join('\n'));
          return 0;
        }
        if (args.flags.has('--all')) {
          const n = await reviewAll(cfg);
          console.log(`approved ${n} pending task(s).`);
          return 0;
        }
        await reviewInteractive(cfg);
        return 0;
      }
      case 'run': {
        const cfg = await resolveConfig(args);
        console.log(`running ${cfg.agents.length} agent(s) on approved tasks (timeout ${cfg.run.timeoutSec}s each) ...`);
        const summary = await runAll(cfg, {
          agents: repeated(args.flags, '--agent'),
          tasks: repeated(args.flags, '--task'),
          force: args.flags.has('--force'),
        });
        console.log(
          `ran ${summary.ran}, skipped ${summary.skippedExisting} already-run${summary.errors.length ? `, ${summary.errors.length} error(s)` : ''}.`,
        );
        return summary.errors.length > 0 ? 1 : 0;
      }
      case 'grade': {
        const cfg = await resolveConfig(args);
        console.log('grading attempts against held-out tests ...');
        const results = await gradeAll(cfg, {
          agents: repeated(args.flags, '--agent'),
          tasks: repeated(args.flags, '--task'),
        });
        const pass = results.filter((r) => r.status === 'pass').length;
        console.log(`${pass}/${results.length} attempt(s) passed.`);
        return 0;
      }
      case 'report': {
        const cfg = await resolveConfig(args);
        const raw = args.flags.get('--format');
        const format = raw === 'markdown' || raw === 'html' ? raw : 'table';
        const outcome = report(cfg, { format });
        console.log('');
        console.log(`wrote ${outcome.htmlPath}`);
        console.log(`wrote ${outcome.mdPath}`);
        return 0;
      }
      default: {
        console.error(`unknown command: ${command}\n`);
        console.log(usage());
        return 1;
      }
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// Bin entry: only run when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (e) => {
      console.error('fatal:', e);
      process.exit(1);
    },
  );
}
