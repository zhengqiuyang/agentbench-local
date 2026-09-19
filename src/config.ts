/**
 * Configuration: defaults, loading and merging of agentbench.yaml.
 * All mining heuristics are config keys so every filter is overridable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export const AB_DIR = '.agentbench';

export interface AgentEntry {
  name: string;
  /** Command template; may contain {{prompt}}, {{workdir}}, {{agentbench}}. */
  command: string;
}

export interface MiningConfig {
  /** `merge` = merge commits ("Merge pull request #N"), `squash` = squash-merged subjects ending in "(#N)". */
  strategy: 'merge' | 'squash';
  /** Custom subject regex; capture group 1 or the first #N wins for the PR number. */
  pattern?: string;
  /** Globs identifying test files. */
  testGlobs: string[];
  /** Changed files matching these are not counted as source (lockfiles etc). */
  sourceExcludeGlobs: string[];
  minSourceFiles: number;
  maxSourceFiles: number;
  /** Minimum subject+body length in characters for the prompt template. */
  minMessageLength: number;
  /** Case-insensitive regexes; a matching subject excludes the PR. */
  excludeSubjectPatterns: string[];
  /** Age window, e.g. `6mo`, `90d`, `2y`, or an ISO date. */
  since: string;
  /** Max tasks mined per run. */
  max: number;
  /** Ref to walk; default HEAD. */
  branch?: string;
}

export interface VerificationConfig {
  /** Force a verification command; otherwise auto-detected per task. */
  command?: string;
  env: Record<string, string>;
  timeoutSec: number;
}

export interface RunConfig {
  /** Per-agent-command timeout. */
  timeoutSec: number;
  /** Stored agent output tail. */
  outputTailBytes: number;
}

export interface BenchConfig {
  repoRoot: string;
  configPath: string | null;
  agents: AgentEntry[];
  mining: MiningConfig;
  verification: VerificationConfig;
  run: RunConfig;
}

export const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*_test.*', 'test/**', '**/tests/**'];

export const DEFAULT_SOURCE_EXCLUDE_GLOBS = [
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/go.sum',
  '**/*.min.js',
];

export const DEFAULT_EXCLUDE_SUBJECT_PATTERNS = [
  '^chore\\b',
  '^revert\\b',
  '\\bbump(ed)?\\b',
  '^release\\b',
  '^deps\\b',
  '^dependabot\\b',
];

export const DEFAULT_MINING: MiningConfig = {
  strategy: 'merge',
  testGlobs: [...DEFAULT_TEST_GLOBS],
  sourceExcludeGlobs: [...DEFAULT_SOURCE_EXCLUDE_GLOBS],
  minSourceFiles: 1,
  maxSourceFiles: 12,
  minMessageLength: 40,
  excludeSubjectPatterns: [...DEFAULT_EXCLUDE_SUBJECT_PATTERNS],
  since: '6mo',
  max: 50,
};

export const DEFAULT_VERIFICATION: VerificationConfig = {
  env: {},
  timeoutSec: 600,
};

export const DEFAULT_RUN: RunConfig = {
  timeoutSec: 900,
  outputTailBytes: 64 * 1024,
};

export function defaultAgents(): AgentEntry[] {
  return [
    {
      name: 'fake',
      command: 'node "{{agentbench}}/demo/fake-agent.js" "{{prompt}}" --workdir "{{workdir}}"',
    },
  ];
}

export function defaultConfig(repoRoot: string): BenchConfig {
  return {
    repoRoot,
    configPath: null,
    agents: defaultAgents(),
    mining: { ...DEFAULT_MINING, testGlobs: [...DEFAULT_MINING.testGlobs] },
    verification: { ...DEFAULT_VERIFICATION, env: {} },
    run: { ...DEFAULT_RUN },
  };
}

export function configPathFor(repoRoot: string): string {
  return path.join(repoRoot, 'agentbench.yaml');
}

/** Default agentbench.yaml text written by `agentbench init`. */
export function defaultConfigText(): string {
  return `# agentbench-local configuration
# Docs: https://github.com/agentbench-local/agentbench-local (README "Configuration reference")
agents:
  # Built-in offline demo agent. Replace/add real agents, e.g.:
  #   claude:
  #     command: 'claude -p "{{prompt}}"'
  #   codex:
  #     command: 'codex exec "{{prompt}}"'
  fake:
    command: 'node "{{agentbench}}/demo/fake-agent.js" "{{prompt}}" --workdir "{{workdir}}"'

mining:
  strategy: merge          # merge | squash (squash-merged subjects ending in "(#N)")
  # pattern: '^Merge pull request #(\\d+)'   # custom subject regex (optional)
  since: 6mo               # 30d | 6mo | 2y | 2025-01-01
  max: 50
  # branch: main           # ref to walk; default HEAD
  testGlobs: ['**/*.test.*', '**/*_test.*', 'test/**', '**/tests/**']
  sourceExcludeGlobs:
    - '**/package-lock.json'
    - '**/yarn.lock'
    - '**/pnpm-lock.yaml'
  minSourceFiles: 1
  maxSourceFiles: 12
  minMessageLength: 40     # min subject+body chars for a usable task prompt
  excludeSubjectPatterns:  # case-insensitive regexes
    - '^chore\\b'
    - '^revert\\b'
    - '\\bbump(ed)?\\b'

verification:
  # Auto-detected per task: package.json scripts.test -> npm test,
  # Makefile "test:" target -> make test, pyproject.toml pytest -> python -m pytest.
  # command: npm test      # uncomment to force a command for every task
  env: {}
  timeoutSec: 600

run:
  timeoutSec: 900          # per agent attempt
`;
}

export interface LoadOpts {
  configPath?: string;
}

/** Load config for a repo: agentbench.yaml merged over defaults. */
export function loadConfig(repoRoot: string, opts: LoadOpts = {}): BenchConfig {
  const cfgPath = opts.configPath ?? configPathFor(repoRoot);
  const base = defaultConfig(repoRoot);
  if (!fs.existsSync(cfgPath)) {
    return base;
  }
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    throw new Error(`failed to parse ${cfgPath}: ${String(e)}`);
  }
  if (raw == null) return { ...base, configPath: cfgPath };
  if (typeof raw !== 'object') throw new Error(`${cfgPath}: top level must be a mapping`);
  const doc = raw as Record<string, unknown>;
  const cfg: BenchConfig = { ...base, configPath: cfgPath };

  if (doc.agents != null) {
    if (typeof doc.agents !== 'object') throw new Error(`${cfgPath}: agents must be a mapping`);
    const agents: AgentEntry[] = [];
    for (const [name, value] of Object.entries(doc.agents as Record<string, unknown>)) {
      const command = typeof value === 'string' ? value : (value as Record<string, unknown>)?.command;
      if (typeof command !== 'string' || command.length === 0) {
        throw new Error(`${cfgPath}: agent "${name}" needs a command (string or { command: ... })`);
      }
      agents.push({ name, command });
    }
    cfg.agents = agents;
  }

  if (doc.mining != null) {
    const m = doc.mining as Record<string, unknown>;
    cfg.mining = {
      ...cfg.mining,
      ...(pick(m, 'strategy') as Partial<MiningConfig>),
      ...(pick(m, 'pattern') as Partial<MiningConfig>),
      ...(pick(m, 'branch') as Partial<MiningConfig>),
      ...(pickNum(m, 'minSourceFiles') as Partial<MiningConfig>),
      ...(pickNum(m, 'maxSourceFiles') as Partial<MiningConfig>),
      ...(pickNum(m, 'minMessageLength') as Partial<MiningConfig>),
      ...(pickNum(m, 'max') as Partial<MiningConfig>),
      ...(pickStr(m, 'since') as Partial<MiningConfig>),
    };
    if (Array.isArray(m.testGlobs)) cfg.mining.testGlobs = m.testGlobs.map(String);
    if (Array.isArray(m.sourceExcludeGlobs)) cfg.mining.sourceExcludeGlobs = m.sourceExcludeGlobs.map(String);
    if (Array.isArray(m.excludeSubjectPatterns)) cfg.mining.excludeSubjectPatterns = m.excludeSubjectPatterns.map(String);
    if (cfg.mining.strategy !== 'merge' && cfg.mining.strategy !== 'squash') {
      throw new Error(`${cfgPath}: mining.strategy must be "merge" or "squash"`);
    }
  }

  if (doc.verification != null) {
    const v = doc.verification as Record<string, unknown>;
    cfg.verification = { ...cfg.verification };
    if (typeof v.command === 'string' && v.command.length > 0) cfg.verification.command = v.command;
    if (typeof v.timeoutSec === 'number') cfg.verification.timeoutSec = v.timeoutSec;
    if (v.env != null && typeof v.env === 'object') {
      cfg.verification.env = Object.fromEntries(
        Object.entries(v.env as Record<string, unknown>).map(([k, val]) => [k, String(val)]),
      );
    }
  }

  if (doc.run != null) {
    const r = doc.run as Record<string, unknown>;
    if (typeof r.timeoutSec === 'number') cfg.run.timeoutSec = r.timeoutSec;
    if (typeof r.outputTailBytes === 'number') cfg.run.outputTailBytes = r.outputTailBytes;
  }

  return cfg;
}

function pick(m: Record<string, unknown>, key: string): Record<string, unknown> {
  return m[key] === undefined ? {} : { [key]: m[key] };
}
function pickNum(m: Record<string, unknown>, key: string): Record<string, unknown> {
  return typeof m[key] === 'number' ? { [key]: m[key] } : {};
}
function pickStr(m: Record<string, unknown>, key: string): Record<string, unknown> {
  return typeof m[key] === 'string' ? { [key]: m[key] } : {};
}
