import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rmrf } from '../src/util.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fakeAgent = path.join(pkgRoot, 'demo', 'fake-agent.js');

function runFakeAgent(workdir: string): { code: number; stdout: string } {
  const r = spawnSync(process.execPath, [fakeAgent, 'test prompt for the fake agent', '--workdir', workdir], {
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, stdout: r.stdout + r.stderr };
}

test('fake-agent: applies agentbench:fix directive (the loop-closing mode)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-fake1-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'greet.js'),
      'export function greet(name) {\n' +
        '  // agentbench:fix {"find": "return \\"TODO(bench)\\";", "replace": "return \\"hello \\" + name;"}\n' +
        '  return "TODO(bench)";\n' +
        '}\n',
    );
    const r = runFakeAgent(dir);
    assert.equal(r.code, 0);
    const after = fs.readFileSync(path.join(dir, 'src', 'greet.js'), 'utf8');
    assert.ok(after.includes('return "hello " + name;'), `directive not applied:\n${after}`);
    assert.ok(!after.includes('return "TODO(bench)";'));
  } finally {
    rmrf(dir);
  }
});

test('fake-agent: falls back to TODO(bench) marker replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-fake2-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const x = "TODO(bench)";\n');
    const r = runFakeAgent(dir);
    assert.equal(r.code, 0);
    const after = fs.readFileSync(path.join(dir, 'a.js'), 'utf8');
    assert.ok(after.includes('fixed-by-fake-agent'));
    assert.ok(!after.includes('TODO(bench)'));
  } finally {
    rmrf(dir);
  }
});

test('fake-agent: final fallback appends a note so a patch always exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-fake3-'));
  try {
    fs.writeFileSync(path.join(dir, 'plain.js'), 'export const y = 1;\n');
    const before = fs.readFileSync(path.join(dir, 'plain.js'), 'utf8');
    const r = runFakeAgent(dir);
    assert.equal(r.code, 0);
    const after = fs.readFileSync(path.join(dir, 'plain.js'), 'utf8');
    assert.ok(after.length > before.length, 'file should have grown');
    assert.ok(after.includes('fake agent'));
  } finally {
    rmrf(dir);
  }
});

test('fake-agent: skips .git and node_modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-fake4-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'TODO(bench)\n');
    fs.writeFileSync(path.join(dir, 'real.js'), 'const a = 1;\n');
    const r = runFakeAgent(dir);
    assert.equal(r.code, 0);
    assert.equal(fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'), '[core]\n');
    assert.ok(fs.readFileSync(path.join(dir, 'node_modules', 'dep.js'), 'utf8').includes('TODO(bench)'));
    // fallback appended a note to real.js
    assert.ok(fs.readFileSync(path.join(dir, 'real.js'), 'utf8').includes('fake agent'));
  } finally {
    rmrf(dir);
  }
});
