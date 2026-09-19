#!/usr/bin/env node
/**
 * agentbench-local demo agent - deterministic, offline, zero AI.
 *
 * Contract (matches the default agent template in agentbench.yaml):
 *   node fake-agent.js "<prompt>" --workdir <dir>
 *
 * It "solves" a task by making a plausible fix in the workdir:
 *   1. If any file contains an `agentbench:fix` directive comment, apply it.
 *      A directive is a JSON payload on one comment line:
 *        // agentbench:fix {"find": "...", "replace": "..."}
 *      (`#` and `--` comment prefixes also accepted). The first occurrence
 *      of `find` is replaced with `replace`.
 *   2. Else, if any file contains the marker `TODO(bench)`, replace the
 *      first occurrence with `fixed-by-fake-agent`.
 *   3. Else, append a harmless comment to the first source-looking file
 *      (or create a note file), so every attempt still yields a patch.
 *
 * Always exits 0 unless the workdir is unreadable. Designed to close the
 * loop end-to-end with the fixture repository built by the test suite.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let prompt = '';
let workdir = '.';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--workdir') workdir = args[++i] ?? '.';
  else if (a.startsWith('--workdir=')) workdir = a.slice('--workdir='.length);
  else if (a === '--prompt') prompt = args[++i] ?? '';
  else if (!a.startsWith('--') && prompt === '') prompt = a;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.agentbench']);
const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.scala', '.swift',
]);

function walk(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !(e.name.startsWith('.') && e.name !== '.github')) walk(p, files);
    } else if (e.isFile()) {
      files.push(p);
    }
  }
  return files;
}

function readText(p) {
  try {
    const st = fs.statSync(p);
    if (st.size > 1024 * 1024) return null;
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

const DIRECTIVE_RE = /(?:\/\/|#|--)\s*agentbench:fix\s+(\{.*\})\s*$/gm;

console.log(`[fake-agent] prompt: ${prompt.split('\n').find((l) => l.trim()) ?? '(empty)'}`);
console.log(`[fake-agent] workdir: ${workdir}`);

try {
  if (!fs.existsSync(workdir)) throw new Error(`workdir does not exist: ${workdir}`);
  const files = walk(path.resolve(workdir));
  const rel = (p) => path.relative(path.resolve(workdir), p).split(path.sep).join('/');

  // Mode 1: apply agentbench:fix directives.
  let directivesApplied = 0;
  for (const f of files) {
    const text = readText(f);
    if (text == null || !text.includes('agentbench:fix')) continue;
    let content = text;
    for (const m of text.matchAll(DIRECTIVE_RE)) {
      let payload;
      try {
        payload = JSON.parse(m[1]);
      } catch {
        console.log(`[fake-agent] warning: unparseable directive in ${rel(f)}: ${m[1].slice(0, 80)}`);
        continue;
      }
      if (typeof payload.find !== 'string' || typeof payload.replace !== 'string') continue;
      if (!content.includes(payload.find)) {
        console.log(`[fake-agent] warning: find-string not present in ${rel(f)}`);
        continue;
      }
      content = content.replace(payload.find, payload.replace);
      directivesApplied++;
      console.log(`[fake-agent] applied directive fix in ${rel(f)}`);
    }
    if (content !== text) fs.writeFileSync(f, content);
  }

  if (directivesApplied === 0) {
    // Mode 2: fix the first TODO(bench) marker.
    let fixed = false;
    for (const f of files) {
      const text = readText(f);
      if (text == null || !text.includes('TODO(bench)')) continue;
      fs.writeFileSync(f, text.replace('TODO(bench)', 'fixed-by-fake-agent'));
      console.log(`[fake-agent] replaced TODO(bench) marker in ${rel(f)}`);
      fixed = true;
      break;
    }
    if (!fixed) {
      // Mode 3: harmless comment appended to the first source file.
      const target =
        files.find((f) => SOURCE_EXT.has(path.extname(f).toLowerCase())) ?? files[0];
      if (target) {
        const text = readText(target) ?? '';
        const commentPrefix = ['#', '.py', '.rb', '.sh'].some((x) => target.endsWith(x)) ? '#' : '//';
        fs.writeFileSync(target, text.replace(/\n*$/, '\n') + `${commentPrefix} visited by the agentbench-local fake agent\n`);
        console.log(`[fake-agent] appended note to ${rel(target)}`);
      } else {
        fs.writeFileSync(path.join(path.resolve(workdir), 'fake-agent-note.txt'), 'visited by the agentbench-local fake agent\n');
        console.log('[fake-agent] created fake-agent-note.txt');
      }
    }
  }
  console.log('[fake-agent] done.');
  process.exit(0);
} catch (e) {
  console.log(`[fake-agent] failed: ${String(e)}`);
  process.exit(0);
}
