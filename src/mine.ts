/**
 * mine: extract benchmark tasks from a repository's merged PR history.
 *
 * Walks `git log` (NUL-separated machine format, renames not followed),
 * identifies merged PRs (merge-commit subjects by default, squash-merged
 * subjects "(#N)" via mining.strategy: squash), classifies changed files
 * into test vs source, applies documented overridable filters, and writes
 * one YAML task per kept PR plus the PR-head blobs of the held-out test
 * files (so grading later needs no repository history).
 */
import fs from 'node:fs';
import path from 'node:path';
import { gitRaw, gitText, gitBuffer } from './git.js';
import { matchAny } from './glob.js';
import type { BenchConfig, MiningConfig } from './config.js';
import {
  type TaskRecord,
  headTestsDir,
  loadIndex,
  loadTask,
  saveIndex,
  saveTask,
  taskYamlPath,
} from './tasks.js';
import { ensureDir, nowIso, toPosix } from './util.js';

// hash, parents, author-date-iso, subject, body - NUL separated, record
// terminated by a trailing NUL (body can never contain NUL).
const LOG_FORMAT = '%H%x00%P%x00%aI%x00%s%x00%b%x00';

export interface LogCommit {
  hash: string;
  parents: string[];
  authorDate: string;
  subject: string;
  body: string;
}

/** Parse the custom `git log --format` output. CRLF tolerant. */
export function parseGitLog(raw: string): LogCommit[] {
  const text = raw.replace(/\r\n/g, '\n');
  const parts = text.split('\x00');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  const commits: LogCommit[] = [];
  for (let i = 0; i + 4 < parts.length; i += 5) {
    const hash = parts[i]!.replace(/^\s+/, '').trim();
    if (!hash) continue;
    const parentsRaw = parts[i + 1]!.trim();
    commits.push({
      hash,
      parents: parentsRaw ? parentsRaw.split(/\s+/) : [],
      authorDate: parts[i + 2]!.trim(),
      subject: parts[i + 3]!.trim(),
      body: parts[i + 4]!.replace(/\s+$/, ''),
    });
  }
  return commits;
}

export interface Candidate {
  pr: number;
  head: string;
  base: string;
  subject: string;
  body: string;
  authorDate: string;
}

function subjectPattern(m: MiningConfig): RegExp {
  if (m.pattern) return new RegExp(m.pattern, 'i');
  return m.strategy === 'squash' ? /\(#(\d+)\)\s*$/ : /^Merge pull request #(\d+)/i;
}

/** Pick merge-commit (or squash-merged) candidates from parsed log entries. */
export function extractCandidates(commits: LogCommit[], m: MiningConfig): Candidate[] {
  const re = subjectPattern(m);
  const out: Candidate[] = [];
  for (const c of commits) {
    const match = c.subject.match(re);
    if (!match) continue;
    if (m.strategy === 'merge') {
      if (c.parents.length < 2) continue;
    } else {
      if (c.parents.length !== 1) continue;
    }
    const numStr = match[1] ?? c.subject.match(/#(\d+)/)?.[1];
    const pr = numStr ? parseInt(numStr, 10) : NaN;
    if (!Number.isFinite(pr)) continue;
    out.push({
      pr,
      head: c.hash,
      base: c.parents[0]!,
      subject: c.subject,
      body: c.body,
      authorDate: c.authorDate,
    });
  }
  return out;
}

const PROMPT_NOISE = [
  /^co-authored-by:/i,
  /^signed-off-by:/i,
  /^reviewed-by:/i,
  /^approved-by:/i,
  /^acked-by:/i,
  /^tested-by:/i,
  /^reported-by:/i,
  /^merge pull request #\d+/i,
  /^\s*generated (with|by)\b/i,
  /^---+$/,
];

/** Build the task prompt from subject+body, stripping trailers/boilerplate. */
export function cleanPrompt(subject: string, body: string): string {
  const combined = body.trim() ? `${subject}\n\n${body.trim()}` : subject;
  const lines = combined
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !PROMPT_NOISE.some((re) => re.test(line.trim())));
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!out) out = subject.trim();
  return out;
}

export interface FileClassification {
  testFiles: string[];
  sourceFiles: string[];
}

export function classifyFiles(files: string[], m: MiningConfig): FileClassification {
  const testFiles: string[] = [];
  const sourceFiles: string[] = [];
  for (const f of files) {
    if (matchAny(m.testGlobs, f)) testFiles.push(f);
    else if (!matchAny(m.sourceExcludeGlobs, f)) sourceFiles.push(f);
  }
  return { testFiles, sourceFiles };
}

export interface FilterInput {
  subject: string;
  message: string;
  testFiles: string[];
  sourceFiles: string[];
}

export interface FilterVerdict {
  ok: boolean;
  reason?: string;
}

/** Documented, overridable heuristics. Checked cheapest-first. */
export function evaluateFilters(input: FilterInput, m: MiningConfig): FilterVerdict {
  for (const pat of m.excludeSubjectPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(pat, 'i');
    } catch {
      continue;
    }
    if (re.test(input.subject)) {
      return { ok: false, reason: `subject matches exclude pattern /${pat}/` };
    }
  }
  if (input.message.trim().length < m.minMessageLength) {
    return { ok: false, reason: `message too short (<${m.minMessageLength} chars)` };
  }
  if (input.testFiles.length === 0) {
    return { ok: false, reason: 'no test files changed' };
  }
  if (input.sourceFiles.length < m.minSourceFiles) {
    return { ok: false, reason: `no non-test source changes (min ${m.minSourceFiles})` };
  }
  if (input.sourceFiles.length > m.maxSourceFiles) {
    return { ok: false, reason: `too many source files (${input.sourceFiles.length} > ${m.maxSourceFiles})` };
  }
  return { ok: true };
}

/** Parse `30d`, `6mo`, `2y`, `8w`, `2025-01-01`, bare number = days. */
export function parseSince(spec: string, now: Date = new Date()): Date {
  const s = spec.trim().toLowerCase();
  const m = s.match(/^(\d+)\s*(d|w|mo|m|y)?$/);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2] ?? 'd';
    if (unit === 'd') return new Date(now.getTime() - n * 86400_000);
    if (unit === 'w') return new Date(now.getTime() - n * 7 * 86400_000);
    if (unit === 'mo' || unit === 'm') {
      const d = new Date(now);
      d.setMonth(d.getMonth() - n);
      return d;
    }
    const d = new Date(now);
    d.setFullYear(d.getFullYear() - n);
    return d;
  }
  const parsed = Date.parse(spec);
  if (!Number.isNaN(parsed)) return new Date(parsed);
  throw new Error(`cannot parse --since value: ${JSON.stringify(spec)} (use 90d, 6mo, 2y, or an ISO date)`);
}

/**
 * Auto-detect the verification command from the repository at `head`:
 * package.json scripts.test -> "npm test"; Makefile `test:` -> "make test";
 * pyproject.toml mentioning pytest -> "python -m pytest".
 */
export async function detectVerificationCommand(repoRoot: string, head: string): Promise<string | null> {
  const pkg = await gitRaw(['show', `${head}:package.json`], { cwd: repoRoot });
  if (pkg.code === 0) {
    try {
      const parsed = JSON.parse(pkg.stdout) as { scripts?: Record<string, unknown> };
      if (parsed?.scripts && typeof parsed.scripts.test === 'string' && parsed.scripts.test.length > 0) {
        return 'npm test';
      }
    } catch {
      /* malformed package.json - fall through */
    }
  }
  const makefile = await gitRaw(['show', `${head}:Makefile`], { cwd: repoRoot });
  if (makefile.code === 0 && /^test\s*:[^\n]*/m.test(makefile.stdout)) {
    return 'make test';
  }
  const pyproject = await gitRaw(['show', `${head}:pyproject.toml`], { cwd: repoRoot });
  if (pyproject.code === 0 && /\bpytest\b/.test(pyproject.stdout)) {
    return 'python -m pytest';
  }
  return null;
}

export interface SkippedRecord {
  id: string;
  pr: number;
  subject: string;
  reason: string;
}

export interface MineSummary {
  sinceIso: string;
  candidates: number;
  kept: Array<{ id: string; pr: number; prompt: string; existing: boolean }>;
  skipped: SkippedRecord[];
}

export interface MineOpts {
  max?: number;
  since?: string;
}

export async function mine(cfg: BenchConfig, opts: MineOpts = {}): Promise<MineSummary> {
  const m = cfg.mining;
  const ref = m.branch ?? 'HEAD';
  const since = parseSince(opts.since ?? m.since);
  const max = opts.max ?? m.max;

  const raw = await gitText(
    ['log', ref, `--since=${since.toISOString()}`, '--max-count=10000', `--format=${LOG_FORMAT}`],
    { cwd: cfg.repoRoot },
  );
  const candidates = extractCandidates(parseGitLog(raw), m).slice(0, max);

  const summary: MineSummary = { sinceIso: since.toISOString(), candidates: candidates.length, kept: [], skipped: [] };
  const index = loadIndex(cfg);

  for (const c of candidates) {
    const baseId = `pr-${c.pr}`;
    const dres = await gitRaw(
      ['-c', 'core.quotepath=false', 'diff', '--name-only', '--no-renames', c.base, c.head],
      { cwd: cfg.repoRoot },
    );
    if (dres.code !== 0) {
      summary.skipped.push({ id: baseId, pr: c.pr, subject: c.subject, reason: 'git diff failed' });
      continue;
    }
    const files = dres.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(toPosix);

    const { testFiles: rawTests, sourceFiles } = classifyFiles(files, m);
    const message = `${c.subject}\n\n${c.body}`.trim();
    const verdict = evaluateFilters({ subject: c.subject, message, testFiles: rawTests, sourceFiles }, m);
    if (!verdict.ok) {
      summary.skipped.push({ id: baseId, pr: c.pr, subject: c.subject, reason: verdict.reason! });
      continue;
    }

    // Snapshot the held-out test files from the PR head. Files deleted by
    // the PR (unreadable at head) are dropped; if nothing readable remains,
    // the task cannot be graded.
    const testFiles: string[] = [];
    const blobs: Array<{ file: string; data: Buffer }> = [];
    for (const f of rawTests) {
      const b = await gitBuffer(['show', `${c.head}:${f}`], { cwd: cfg.repoRoot });
      if (b.code === 0) {
        testFiles.push(f);
        blobs.push({ file: f, data: b.stdout });
      }
    }
    if (testFiles.length === 0) {
      summary.skipped.push({ id: baseId, pr: c.pr, subject: c.subject, reason: 'no readable test files at PR head' });
      continue;
    }

    const command = cfg.verification.command ?? (await detectVerificationCommand(cfg.repoRoot, c.head));
    if (!command) {
      summary.skipped.push({
        id: baseId,
        pr: c.pr,
        subject: c.subject,
        reason: 'no verification command detected (set verification.command in agentbench.yaml)',
      });
      continue;
    }

    const existing = loadTask(cfg, baseId);
    let id = baseId;
    if (existing && existing.headCommit === c.head) {
      summary.kept.push({ id, pr: c.pr, prompt: existing.prompt, existing: true });
    } else {
      let n = 2;
      while (fs.existsSync(taskYamlPath(cfg, id))) id = `${baseId}-${n++}`;
      const task: TaskRecord = {
        id,
        prNumber: c.pr,
        prompt: cleanPrompt(c.subject, c.body),
        baseCommit: c.base,
        headCommit: c.head,
        testFiles,
        sourceFiles,
        verification: { command, env: { ...cfg.verification.env } },
        minedAt: nowIso(),
      };
      saveTask(cfg, task);
      for (const blob of blobs) {
        const dest = safeJoin(headTestsDir(cfg, id), blob.file);
        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, blob.data);
      }
      summary.kept.push({ id, pr: c.pr, prompt: task.prompt, existing: false });
    }
    if (!index.statuses[id]) index.statuses[id] = 'pending';
  }

  // Tasks that exist on disk but are missing from the index default to pending.
  saveIndex(cfg, index);
  return summary;
}

/** Join a repo-relative path under root, rejecting traversal/absolute paths. */
export function safeJoin(root: string, rel: string): string {
  const p = toPosix(rel).replace(/^\.\//, '');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) {
    throw new Error(`unsafe path in repository: ${rel}`);
  }
  return path.join(root, ...p.split('/'));
}
