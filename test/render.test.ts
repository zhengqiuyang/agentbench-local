import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCommand } from '../src/run.js';

test('renderCommand: placeholder inside existing quotes is escaped, not re-quoted', () => {
  const cmd = renderCommand('node "{{agentbench}}/demo/fake-agent.js" "{{prompt}}" --workdir "{{workdir}}"', {
    prompt: 'line one\nline "two"',
    workdir: '/tmp/wd',
  });
  // The regression this guards: `""path""` from double-quoting, which POSIX
  // sh splits so the prompt's newlines executed as commands (Linux CI exit 127).
  assert.ok(!cmd.includes('""'), `no double-double quotes, got: ${cmd}`);
  assert.ok(cmd.includes('line one line \\"two\\"'), `newlines collapsed, quotes escaped in place: ${cmd}`);
  assert.ok(cmd.endsWith('--workdir "/tmp/wd"'), `workdir still a single quoted arg: ${cmd}`);
});

test('renderCommand: bare placeholder still gets wrapped in quotes', () => {
  const cmd = renderCommand('claude -p {{prompt}}', { prompt: 'do "it"', workdir: '/tmp/x' });
  assert.ok(cmd.includes('"do'), `bare prompt is wrapped: ${cmd}`);
});

test('renderCommand: POSIX special characters in a quoted placeholder are neutralised', { skip: process.platform === 'win32' }, () => {
  const cmd = renderCommand('run "{{prompt}}"', { prompt: 'echo $(whoami) `id` \\home', workdir: '/w' });
  const substituted = cmd.slice('run "'.length, cmd.length - 1);
  assert.ok(!substituted.includes('$(whoami)'), `command substitution escaped: ${cmd}`);
  assert.ok(!substituted.includes('`id`'), `backticks escaped: ${cmd}`);
});
