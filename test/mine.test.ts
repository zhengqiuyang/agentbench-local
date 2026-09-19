import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitLog,
  extractCandidates,
  cleanPrompt,
  classifyFiles,
  evaluateFilters,
  parseSince,
} from '../src/mine.js';
import { DEFAULT_MINING, DEFAULT_TEST_GLOBS } from '../src/config.js';
import { parseDiffStat as parseStat } from '../src/grade.js';

function fmt(o: { hash: string; parents: string[]; date: string; subject: string; body: string }): string {
  return `${o.hash}\x00${o.parents.join(' ')}\x00${o.date}\x00${o.subject}\x00${o.body}\x00`;
}

test('parseGitLog: NUL format, multiple records, empty parents', () => {
  const raw = [
    fmt({ hash: 'aaa', parents: ['bbb', 'ccc'], date: '2026-01-02T03:04:05+00:00', subject: 'Merge pull request #7 from x/y', body: 'Fix the thing\n\nBody here.' }),
    fmt({ hash: 'ddd', parents: [], date: '2026-01-03T03:04:05+00:00', subject: 'Initial import', body: '' }),
  ].join('');
  const commits = parseGitLog(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]!.hash, 'aaa');
  assert.deepEqual(commits[0]!.parents, ['bbb', 'ccc']);
  assert.equal(commits[0]!.subject, 'Merge pull request #7 from x/y');
  assert.equal(commits[0]!.body, 'Fix the thing\n\nBody here.');
  assert.deepEqual(commits[1]!.parents, []);
  assert.equal(commits[1]!.subject, 'Initial import');
});

test('parseGitLog: CRLF in body is tolerated and trailing NUL dropped', () => {
  const raw = 'h1\x00p1\x00d\x00subject one\r\n\x00body line\r\nsecond line\r\n\x00';
  const commits = parseGitLog(raw);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]!.subject, 'subject one');
  assert.equal(commits[0]!.body, 'body line\nsecond line');
});

test('extractCandidates: merge strategy requires 2 parents and pattern', () => {
  const commits = parseGitLog(
    [
      fmt({ hash: 'm1', parents: ['b1', 'f1'], date: 'd', subject: 'Merge pull request #7 from acme/feature', body: 'body' }),
      fmt({ hash: 'm2', parents: ['b2'], date: 'd', subject: 'Merge pull request #8 from acme/x', body: 'body' }), // not a merge commit
      fmt({ hash: 'm3', parents: ['b3', 'f3'], date: 'd', subject: 'no pattern here', body: 'body' }),
    ].join(''),
  );
  const cands = extractCandidates(commits, DEFAULT_MINING);
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.pr, 7);
  assert.equal(cands[0]!.base, 'b1');
  assert.equal(cands[0]!.head, 'm1');
});

test('extractCandidates: squash strategy takes single-parent subjects ending in (#N)', () => {
  const commits = parseGitLog(
    [
      fmt({ hash: 's1', parents: ['p1'], date: 'd', subject: 'Fix the parser (#42)', body: 'body' }),
      fmt({ hash: 's2', parents: ['p2', 'p3'], date: 'd', subject: 'Merge pull request #9 from x/y (#9)', body: 'body' }),
    ].join(''),
  );
  const cands = extractCandidates(commits, { ...DEFAULT_MINING, strategy: 'squash' });
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.pr, 42);
  assert.equal(cands[0]!.base, 'p1');
});

test('cleanPrompt: strips trailers and merge boilerplate, keeps content', () => {
  const subject = 'Merge pull request #7 from acme/feature/greet';
  const body = 'Fix greet to return a proper greeting\n\nReplace the placeholder.\n\nCo-authored-by: Someone <s@example.com>\nGenerated with Claude Code';
  const prompt = cleanPrompt(subject, body);
  assert.ok(!prompt.includes('Merge pull request'));
  assert.ok(!prompt.includes('Co-authored-by'));
  assert.ok(!prompt.includes('Generated with'));
  assert.ok(prompt.includes('Fix greet to return a proper greeting'));
  assert.ok(prompt.includes('Replace the placeholder.'));
});

test('cleanPrompt: empty body falls back to subject', () => {
  assert.equal(cleanPrompt('Fix the thing', ''), 'Fix the thing');
});

test('classifyFiles: splits tests vs source, drops lockfiles from source', () => {
  const m = { ...DEFAULT_MINING, testGlobs: DEFAULT_TEST_GLOBS };
  const { testFiles, sourceFiles } = classifyFiles(
    ['src/greet.js', 'src/greet.test.js', 'test/run.js', 'package-lock.json', 'README.md'],
    m,
  );
  assert.deepEqual(testFiles, ['src/greet.test.js', 'test/run.js']);
  assert.deepEqual(sourceFiles, ['src/greet.js', 'README.md']);
});

function okFilters(testFiles: string[], sourceFiles: string[]) {
  return { subject: 'A perfectly reasonable PR subject line', message: 'A perfectly reasonable PR subject line\n\nwith a body long enough', testFiles, sourceFiles };
}

test('evaluateFilters: every documented reason', () => {
  const m = DEFAULT_MINING;
  assert.equal(evaluateFilters({ ...okFilters(['a.test.js'], ['a.js']), subject: 'chore: tidy things up finally ok' }, m).ok, false);
  assert.match(evaluateFilters({ ...okFilters(['a.test.js'], ['a.js']), subject: 'chore: tidy' }, m).reason!, /exclude pattern/);
  assert.match(evaluateFilters({ ...okFilters([], ['a.js']), subject: 'Add a feature with tests missing' }, m).reason!, /no test files/);
  assert.match(evaluateFilters({ ...okFilters(['a.test.js'], []), subject: 'Only tests changed here' }, m).reason!, /no non-test source/);
  assert.match(evaluateFilters({ ...okFilters(['a.test.js'], ['a.js']), message: 'too short' }, m).reason!, /too short/);
  const many = Array.from({ length: 13 }, (_, i) => `s${i}.js`);
  assert.match(evaluateFilters({ ...okFilters(['a.test.js'], many), subject: 'Big refactor of everything at once ok' }, m).reason!, /too many source files/);
  assert.equal(evaluateFilters({ ...okFilters(['a.test.js'], ['a.js']), subject: 'Add greeting cache for repeat callers' }, m).ok, true);
});

test('evaluateFilters: bump exclusion is case-insensitive and matches subjects', () => {
  const m = DEFAULT_MINING;
  const v = evaluateFilters({ ...okFilters(['a.test.js'], ['a.js']), subject: 'Merge pull request #9 from acme/release-bump' }, m);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /bump/);
});

test('parseSince: units and ISO dates', () => {
  const now = new Date('2026-09-19T00:00:00Z');
  assert.equal(Math.round((now.getTime() - parseSince('30d', now).getTime()) / 86400000), 30);
  assert.equal(Math.round((now.getTime() - parseSince('2w', now).getTime()) / (7 * 86400000)), 2);
  const mo = parseSince('6mo', now);
  assert.equal(mo.getUTCMonth(), 2); // March
  const y = parseSince('1y', now);
  assert.equal(y.getUTCFullYear(), 2025);
  assert.equal(parseSince('2026-01-01', now).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.throws(() => parseSince('soon', now));
  // bare number = days
  assert.equal(Math.round((now.getTime() - parseSince('7', now).getTime()) / 86400000), 7);
});

test('parseDiffStat: standard git stat line', () => {
  const s = parseStat(' src/greet.js | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)\n');
  assert.deepEqual(s, { files: 1, insertions: 2, deletions: 1 });
  const multi = parseStat(' a.js | 1 +\n b.test.js | 10 ++++++++++\n 2 files changed, 11 insertions(+)\n');
  assert.deepEqual(multi, { files: 2, insertions: 11, deletions: 0 });
  assert.deepEqual(parseStat(''), { files: 0, insertions: 0, deletions: 0 });
});
