/**
 * Thin, safe wrapper around spawning git. Every read command runs with
 * `--no-pager` so nothing blocks on a TTY, and output is captured (never
 * inherited) so the harness stays scriptable.
 */
import { spawnCapture, spawnCaptureBuffer, type ProcResult, type RunOpts } from './util.js';

export interface GitOpts extends RunOpts {}

export interface GitBufferResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Run git; never throws - inspect `.code`. */
export async function gitRaw(args: string[], opts: GitOpts = {}): Promise<ProcResult> {
  return spawnCapture('git', ['--no-pager', ...args], opts);
}

/** Run git expecting raw bytes back (e.g. `git show <rev>:<file>`). */
export async function gitBuffer(args: string[], opts: GitOpts = {}): Promise<GitBufferResult> {
  return spawnCaptureBuffer('git', ['--no-pager', ...args], opts);
}

/** Run git and return stdout; throws a descriptive Error on nonzero exit. */
export async function gitText(args: string[], opts: GitOpts = {}): Promise<string> {
  const r = await gitRaw(args, opts);
  if (r.code !== 0) {
    const detail = (r.stderr.trim() || r.stdout.trim() || '(no output)').split('\n').slice(0, 6).join('\n');
    throw new Error(`git ${args.join(' ')} failed (exit ${r.code}):\n${detail}`);
  }
  return r.stdout;
}

/** Resolve the top-level working tree of the repo containing `cwd`. */
export async function repoRootAt(cwd: string): Promise<string> {
  const out = await gitText(['rev-parse', '--show-toplevel'], { cwd });
  return out.trim();
}
