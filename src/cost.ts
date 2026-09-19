/**
 * Best-effort token usage from agent transcript files on the local machine.
 * Never throws; returns null ("-" in reports) when nothing is found.
 * Heuristics: for claude-like agents scan ~/.claude/projects for the newest
 * session .jsonl whose mtime falls inside the attempt window and read its
 * last `usage` record; for codex-like agents scan ~/.codex/sessions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CostWindow {
  startedAt: string;
  durationMs: number;
}

export function estimateTokens(agent: string, win: CostWindow): number | null {
  try {
    const start = Date.parse(win.startedAt);
    if (!Number.isFinite(start)) return null;
    const from = start - 5 * 60_000;
    const to = start + win.durationMs + 5 * 60_000;
    const home = os.homedir();
    if (/claude/i.test(agent)) {
      return scanNewestUsage(path.join(home, '.claude', 'projects'), from, to, claudeUsage);
    }
    if (/codex/i.test(agent)) {
      return scanNewestUsage(path.join(home, '.codex', 'sessions'), from, to, codexUsage);
    }
    return null;
  } catch {
    return null;
  }
}

type UsageExtractor = (obj: Record<string, unknown>) => number | null;

function claudeUsage(obj: Record<string, unknown>): number | null {
  const msg = obj['message'] as Record<string, unknown> | undefined;
  const usage = (msg?.['usage'] ?? obj['usage']) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;
  return sumNumeric(usage, [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ]);
}

function codexUsage(obj: Record<string, unknown>): number | null {
  const info = obj['info'] as Record<string, unknown> | undefined;
  const total = info?.['total_token_usage'] as Record<string, unknown> | undefined;
  if (total && typeof total === 'object') {
    return sumNumeric(total, ['input_tokens', 'cached_input_tokens', 'output_tokens']);
  }
  const usage = obj['token_count'] as Record<string, unknown> | undefined;
  if (usage && typeof usage === 'object') return sumNumeric(usage, ['input', 'cached', 'output']);
  return null;
}

function sumNumeric(rec: Record<string, unknown>, keys: string[]): number | null {
  let sum = 0;
  let any = false;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

function scanNewestUsage(dir: string, from: number, to: number, extract: UsageExtractor): number | null {
  if (!fs.existsSync(dir)) return null;
  let newest: { file: string; mtime: number } | null = null;
  walkJsonl(dir, (file, stat) => {
    if (stat.mtimeMs >= from && stat.mtimeMs <= to) {
      if (!newest || stat.mtimeMs > newest.mtime) newest = { file, mtime: stat.mtimeMs };
    }
  });
  if (!newest) return null;
  const hit = newest as { file: string; mtime: number };
  let text: string;
  try {
    text = fs.readFileSync(hit.file, 'utf8');
  } catch {
    return null;
  }
  // Take the LAST usage record in the session file.
  let found: number | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const usage = extract(obj);
      if (usage != null) found = usage;
    } catch {
      /* skip malformed line */
    }
  }
  return found;
}

function walkJsonl(dir: string, visit: (file: string, stat: fs.Stats) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, visit);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        visit(p, fs.statSync(p));
      } catch {
        /* raced away */
      }
    }
  }
}
