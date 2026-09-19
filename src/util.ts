/**
 * Shared process/fs utilities. Windows-safe: paths are used as-is, all
 * recursive deletions retry on Windows file-lock errors, and output
 * capture is capped so a runaway agent cannot exhaust memory.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface BufferResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

export interface RunOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Max bytes captured per stream; anything beyond is dropped with a marker. */
  capBytes?: number;
}

const DEFAULT_CAP = 2 * 1024 * 1024;

/** Root of the agentbench-local package (dist/src/util.js -> ../../). */
export function pkgRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Kill a process and (best effort on every platform) its whole tree. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL'); // negative pid = process group (spawned detached)
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

interface RawCapture {
  code: number;
  out: Buffer;
  err: string;
  timedOut: boolean;
}

function runProcess(
  file: string,
  args: string[] | undefined,
  shell: boolean,
  opts: RunOpts,
): Promise<RawCapture> {
  return new Promise((resolve) => {
    const cap = opts.capBytes ?? DEFAULT_CAP;
    // Never leak the node:test runner context into child processes: a
    // verification command like `node --test` would otherwise think it is
    // being run recursively and silently skip every file (exit 0).
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_TMP_DIR;
    const spawnOpts: Parameters<typeof spawn>[2] = {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32', // group kill on POSIX
    };
    const child = shell ? spawn(file, { ...spawnOpts, shell: true }) : spawn(file, args ?? [], spawnOpts);

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let outTrunc = false;
    let errTrunc = false;
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (c: Buffer) => {
      if (outLen < cap) {
        out.push(c);
        outLen += c.length;
      } else {
        outTrunc = true;
      }
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (errLen < cap) {
        err.push(c);
        errLen += c.length;
      } else {
        errTrunc = true;
      }
    });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : null;

    const finish = (code: number, errMsg?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let errText = Buffer.concat(err).toString('utf8');
      if (errMsg) errText += (errText ? '\n' : '') + errMsg;
      if (errTrunc) errText += '\n[agentbench: output truncated]';
      resolve({
        code,
        out: Buffer.concat(outTrunc ? [...out, Buffer.from('\n[agentbench: output truncated]')] : out),
        err: errText,
        timedOut,
      });
    };

    child.on('error', (e: Error) => finish(-1, String(e)));
    child.on('close', (code: number | null) => finish(code ?? -1));
  });
}

/** Spawn a command (no shell) and capture text output. */
export async function spawnCapture(cmd: string, args: string[], opts: RunOpts = {}): Promise<ProcResult> {
  const r = await runProcess(cmd, args, false, opts);
  return { code: r.code, stdout: r.out.toString('utf8'), stderr: r.err, timedOut: r.timedOut };
}

/** Spawn a command (no shell) and capture raw bytes (for `git show` blobs). */
export async function spawnCaptureBuffer(cmd: string, args: string[], opts: RunOpts = {}): Promise<BufferResult> {
  const r = await runProcess(cmd, args, false, opts);
  return { code: r.code, stdout: r.out, stderr: r.err, timedOut: r.timedOut };
}

/**
 * Run a command line through the shell (cronagent runner pattern).
 * Used for agent commands and verification commands, both of which are
 * user-supplied command lines rather than argv arrays.
 */
export async function runShell(command: string, opts: RunOpts = {}): Promise<ProcResult> {
  const r = await runProcess(command, undefined, true, opts);
  return { code: r.code, stdout: r.out.toString('utf8'), stderr: r.err, timedOut: r.timedOut };
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function rmrf(p: string): void {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
}

export function writeFileAtomic(p: string, data: string): void {
  ensureDir(path.dirname(p));
  const tmp = p + '.agentbench-tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

export function writeJsonAtomic(p: string, value: unknown): void {
  writeFileAtomic(p, JSON.stringify(value, null, 2) + '\n');
}

export function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Keep the last `bytes` bytes of a utf8 string. */
export function tail(s: string, bytes: number): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= bytes) return s;
  return b.subarray(b.length - bytes).toString('utf8');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '-';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m${String(rest).padStart(2, '0')}s`;
}

/**
 * Best-effort double-quote escaping for one argument that is substituted
 * into a shell command line. Windows (cmd.exe): only `"` needs handling and
 * backslashes in paths must be left alone. POSIX: also neutralise `$`, `` ` ``
 * and `\` before quotes. This is deliberately conservative - see the agent
 * template guide in the README for the real-world caveats.
 */
export function quoteArg(v: string): string {
  if (process.platform === 'win32') {
    return '"' + v.replace(/"/g, '\\"') + '"';
  }
  return '"' + v.replace(/([\\"`$])/g, '\\$1') + '"';
}

/** True if `p` is inside `base` (or equal), after normalization. */
export function isWithin(base: string, p: string): boolean {
  const rel = path.relative(base, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Recursively copy a directory tree. Skips any entry named `.git`. */
export function copyTree(src: string, dest: string): void {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}
