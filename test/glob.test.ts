import test from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob, matchAny } from '../src/glob.js';

test('glob: **/*.test.* matches nested and root test files', () => {
  assert.ok(matchGlob('**/*.test.*', 'src/greet.test.js'));
  assert.ok(matchGlob('**/*.test.*', 'greet.test.ts'));
  assert.ok(matchGlob('**/*.test.*', 'deep/a/b/c.spec.test.py'));
  assert.ok(!matchGlob('**/*.test.*', 'src/greet.js'));
  assert.ok(!matchGlob('**/*.test.*', 'src/testhelper.js'));
});

test('glob: *_test.* matches suffix convention', () => {
  assert.ok(matchGlob('**/*_test.*', 'src/greet_test.go'));
  assert.ok(!matchGlob('**/*_test.*', 'src/greet.tests.js'));
});

test('glob: test/** and **/tests/** match directory conventions', () => {
  assert.ok(matchGlob('test/**', 'test/foo.js'));
  assert.ok(matchGlob('test/**', 'test/a/b.js'));
  assert.ok(!matchGlob('test/**', 'src/test/foo.js'));
  assert.ok(matchGlob('**/tests/**', 'tests/x.js'));
  assert.ok(matchGlob('**/tests/**', 'pkg/tests/deep/y.js'));
  assert.ok(!matchGlob('**/tests/**', 'testsuite/x.js'));
});

test('glob: unanchored patterns match the basename at any depth', () => {
  assert.ok(matchGlob('*.test.*', 'a/b/c/deep.test.js'));
  assert.ok(!matchGlob('*.test.*', 'a/b/c/deep.js'));
});

test('glob: backslash paths and leading ./ are normalized', () => {
  assert.ok(matchGlob('**/*.test.*', 'src\\greet.test.js'));
  assert.ok(matchGlob('test/**', './test/x.js'));
});

test('glob: lockfile excludes', () => {
  assert.ok(matchGlob('**/package-lock.json', 'package-lock.json'));
  assert.ok(matchGlob('**/package-lock.json', 'packages/a/package-lock.json'));
  assert.ok(!matchGlob('**/package-lock.json', 'package-lock.json.bak'));
});

test('glob: matchAny scans lists', () => {
  const globs = ['**/*.test.*', 'test/**'];
  assert.ok(matchAny(globs, 'src/x.test.js'));
  assert.ok(matchAny(globs, 'test/y.js'));
  assert.ok(!matchAny(globs, 'src/y.js'));
});

test('glob: ? matches exactly one path character', () => {
  assert.ok(matchGlob('a?c.js', 'abc.js'));
  assert.ok(!matchGlob('a?c.js', 'ac.js'));
  assert.ok(!matchGlob('a?c.js', 'a/bc.js'));
});
