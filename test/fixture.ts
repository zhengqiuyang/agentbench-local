/**
 * Programmatic fixture repository for tests and the demo.
 *
 * Fully isolated git: empty GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM=1,
 * fixed author/committer identity, core.autocrlf=false, LF files. No
 * network, no real agents.
 *
 * History:
 *   c0 initial           (broken greet + failing base test + package.json)
 *   PR #7  merge         good PR: 1 source + 1 test, long message  -> MINED
 *   PR #8  merge         source-only, no tests                     -> filtered
 *   PR #9  merge         version bump w/ test tweak                -> filtered (subject)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnCapture } from '../src/util.js';

export const FIXTURE_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture Committer',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

export async function fgit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await spawnCapture('git', args, { cwd, env: FIXTURE_ENV });
  return r;
}

export async function fgitOk(cwd: string, args: string[]): Promise<string> {
  const r = await fgit(cwd, args);
  if (r.code !== 0) throw new Error(`fixture git ${args.join(' ')} failed:\n${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

function write(dir: string, rel: string, content: string): void {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

export const GREET_BROKEN = `// Simple greeting module used by the agentbench-local fixture repository.
export function greet(name) {
  // agentbench:fix {"find": "return \\"TODO(bench)\\";", "replace": "return \\"hello \\" + name;"}
  return "TODO(bench)";
}
`;

export const GREET_FIXED = `// Simple greeting module used by the agentbench-local fixture repository.
export function greet(name) {
  return "hello " + name;
}
`;

export const GREET_TEST_BASE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from './greet.js';

test('greet returns a hello greeting', () => {
  assert.equal(greet('world'), 'hello world');
});
`;

// The PR-head (held-out) test: extended with more cases. The fake agent's
// directive fix must make THIS test pass - that closes the grading loop.
export const GREET_TEST_HEAD = `import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from './greet.js';

test('greet returns a hello greeting', () => {
  assert.equal(greet('world'), 'hello world');
});

test('greet greets any name', () => {
  assert.equal(greet('agent'), 'hello agent');
  assert.equal(greet('bench'), 'hello bench');
});
`;

const PACKAGE_JSON = `{
  "name": "fixture-repo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test src/greet.test.js"
  }
}
`;

export interface FixtureRepo {
  root: string;
  goodPr: number;
  goodBaseCommit: string;
  goodHeadCommit: string;
  headCommit: string;
  commitCount: number;
}

async function makePR(
  root: string,
  pr: number,
  branch: string,
  body: string,
  apply: () => void,
): Promise<string> {
  await fgitOk(root, ['checkout', '-q', '-b', branch]);
  apply();
  await fgitOk(root, ['add', '-A']);
  await fgitOk(root, ['commit', '-q', '-m', `work for PR #${pr}`, '-m', body]);
  await fgitOk(root, ['checkout', '-q', 'main']);
  const subject = `Merge pull request #${pr} from acme/${branch}`;
  await fgitOk(root, ['merge', '--no-ff', '-q', '-m', subject, '-m', body, branch]);
  return (await fgitOk(root, ['rev-parse', 'HEAD'])).trim();
}

export async function buildFixtureRepo(dir: string): Promise<FixtureRepo> {
  fs.mkdirSync(dir, { recursive: true });
  await fgitOk(dir, ['init', '-q', '-b', 'main']);
  await fgitOk(dir, ['config', 'core.autocrlf', 'false']);
  await fgitOk(dir, ['config', 'user.email', 'fixture@example.com']);
  await fgitOk(dir, ['config', 'user.name', 'Fixture Author']);

  // c0: initial import - the "bug present" base state.
  write(dir, 'package.json', PACKAGE_JSON);
  write(dir, 'src/greet.js', GREET_BROKEN);
  write(dir, 'src/greet.test.js', GREET_TEST_BASE);
  await fgitOk(dir, ['add', '-A']);
  await fgitOk(dir, ['commit', '-q', '-m', 'Initial import']);

  // PR #7: the good PR-shaped merge (source + test, real message).
  const goodBase = (await fgitOk(dir, ['rev-parse', 'HEAD'])).trim();
  const goodHead = await makePR(
    dir,
    7,
    'feature/greet',
    'Fix greet to return a proper greeting\n\nReplace the placeholder return value with a real hello greeting so callers get meaningful output, and extend the test to cover additional names.',
    () => {
      write(dir, 'src/greet.js', GREET_FIXED);
      write(dir, 'src/greet.test.js', GREET_TEST_HEAD);
    },
  );

  // PR #8: source-only change, no test files -> filtered by heuristics.
  await makePR(
    dir,
    8,
    'add-util',
    'Add shared utility helpers\n\nIntroduce a small utility module used by the build pipeline so multiple scripts can share common helper functions.',
    () => {
      write(dir, 'src/util.js', 'export function add(a, b) {\n  return a + b;\n}\n');
    },
  );

  // PR #9: version bump with a test tweak -> filtered by subject pattern.
  await makePR(
    dir,
    9,
    'release-bump',
    'chore(release): bump version to 0.2.0\n\nRoutine version bump after the dependency refresh, plus a comment tweak in the test file.',
    () => {
      write(dir, 'package.json', PACKAGE_JSON.replace('"version": "0.1.0"', '"version": "0.2.0"'));
      write(dir, 'src/greet.test.js', '// version bump sanity\n' + GREET_TEST_HEAD);
    },
  );

  // A remote so the anti-cheat test can assert it is never touched.
  await fgitOk(dir, ['remote', 'add', 'origin', '../dummy-remote-never-fetched']);

  const headCommit = (await fgitOk(dir, ['rev-parse', 'HEAD'])).trim();
  const commitCount = parseInt((await fgitOk(dir, ['rev-list', '--count', 'HEAD'])).trim(), 10);

  return { root: dir, goodPr: 7, goodBaseCommit: goodBase, goodHeadCommit: goodHead, headCommit, commitCount };
}
