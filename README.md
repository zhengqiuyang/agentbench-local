# agentbench-local

**SWE-bench, but for YOUR repo, on YOUR machine, with zero task authoring.**

One command mines benchmark tasks from your merged pull requests. A second replays them headless against any number of CLI coding agents. A third grades every attempt with the pull request's own tests. A fourth prints a local leaderboard. Nothing - not your code, not your prompts, not your results - ever leaves the machine.

> The only agent benchmark that never sends your code to anyone, and never asks you to write a task.

- MIT licensed, zero runtime dependencies beyond `yaml`
- Windows / macOS / Linux, Node 20+
- Built-in offline demo agent so the whole pipeline runs end-to-end with no API keys and no network

---

## Why this exists

Benchmarking coding agents on *your* repository is a solved problem at companies that can staff it, and an unsolved one everywhere else:

- **Databricks** built exactly this internally and published the blueprint (July 2026 blog) - including the hard-won lesson that agents will read the repository's git history to find future tests and answers if you let them. The blueprint was never open-sourced.
- **Superconductor** sells a cloud version of per-repo agent benchmarking. Great if your code can leave the building.
- **UiPath open-sourced coder-eval** - a solid runner layer, but you author every task by hand.
- **Microsoft's RepoLaunch** mines tasks automatically, but it is research-grade tooling, not a harness you adopt.

The un-owned cell in that landscape is the **integrated, local, private, zero-authoring package**: one command that mines tasks from your merged PRs, replays them headless against multiple agents, grades with the PR's own tests, and prints a leaderboard - entirely on your machine. That is agentbench-local.

If you are security- or IP-constrained (defense, finance, health, source you simply cannot ship to a scoring SaaS) and you have real PR history, this is the honest framing: your merged PRs are already a labeled dataset of (broken base, human-written fix, human-written tests). agentbench-local turns that dataset into a recurring measurement for the cost of a git clone.

## Quickstart

```bash
git clone <this repo> agentbench-local
cd agentbench-local
npm install
npm run build

# point it at any repository with merged PR history:
node dist/src/cli.js init /path/to/your-repo
# or, after `npm link`:
agentbench init /path/to/your-repo
```

`init` writes `agentbench.yaml`, mines your first tasks, and tells you what to do next:

```bash
agentbench review          # curate: approve / reject / skip each mined task
agentbench run             # every approved task x every configured agent
agentbench grade           # held-out tests decide pass / fail
agentbench report          # console leaderboard + report.md + report.html
```

Want to see the whole thing with zero setup and zero agents? `npm run demo` builds a fixture repository (three merged PRs: one real fix, one chore, one test-less change), runs the full pipeline with the built-in fake agent, prints the leaderboard, and cleans up after itself.

## Pipeline

```
              +---------+     +---------+     +---------+     +---------+     +---------+
 your repo -->|  mine   |---->| review  |---->|   run   |---->|  grade  |---->| report  |
              | merged  |     | human   |     | N agents|     | held-out|     | local   |
              | PRs to  |     | approve |     | x tasks |     | tests   |     | leader- |
              | tasks   |     | reject  |     | in      |     | from the|     | board   |
              |         |     |         |     | sealed  |     | PR head |     | md+html |
              |         |     |         |     | copies  |     | decide  |     |         |
              +---------+     +---------+     +---------+     +---------+     +---------+
                 git log        .agentbench/    worktrees       patches +       report.html
                 + diff          tasks/index    .agentbench/    test blobs      report.md
                                 yaml           work/
```

Everything agentbench-local writes lives in `<repo>/.agentbench/`:

```
.agentbench/
  tasks/<id>.yaml                 task definition (prompt, base commit, files, verification)
  tasks/<id>/head-tests/...       held-out test blobs snapshotted from the PR head
  tasks/index.yaml                curation decisions (approved / rejected / skipped / pending)
  work/<task>/<agent>/            sealed workspace per attempt (a standalone git repo)
  attempts/<task>/<agent>/        attempt.json, patch.diff, result.json
  report.md, report.html          the leaderboard
```

Add `.agentbench/` to the repository's `.gitignore`.

## Commands

| command | what it does |
| --- | --- |
| `init <repoPath>` | write `agentbench.yaml` (if absent), mine, print next steps |
| `mine [--max N] [--since 6mo]` | scan merged PRs, apply filters, write task YAMLs + held-out test blobs |
| `review [--all\|--list]` | interactive curation; `--all` approves everything pending; `--list` shows statuses |
| `run [--agent a,b] [--task id] [--force]` | seal a workspace per task x agent and execute the agent command |
| `grade [--agent a,b] [--task id]` | diff, apply to a verifier worktree, copy held-out tests, run verification |
| `report [--format table\|markdown\|html]` | write `report.md`/`report.html` and print the leaderboard |

All commands accept `--repo <path>` (default: current directory) and `--config <path>`.

## Mining heuristics (all documented, all overridable)

A merged PR becomes a task when, in order of checking:

1. **Subject exclusion** - subject matches none of `mining.excludeSubjectPatterns` (defaults: `^chore\b`, `^revert\b`, `\bbump(ed)?\b`, `^release\b`, `^deps\b`, `^dependabot\b`).
2. **Message length** - subject + body is at least `minMessageLength` (default 40) characters. The body becomes the task prompt (merge boilerplate, `Co-authored-by`, `Generated with ...` trailers stripped).
3. **Test changes** - the PR changes at least one file matching `mining.testGlobs` (defaults: `**/*.test.*`, `**/*_test.*`, `test/**`, `**/tests/**`).
4. **Source changes** - between `minSourceFiles` (default 1) and `maxSourceFiles` (default 12) non-test files changed, not counting `sourceExcludeGlobs` (lockfiles etc).

PR detection supports two strategies: `merge` (default) for merge commits whose subject matches `^Merge pull request #(\d+)`, with the base taken from the first parent; and `squash` for squash-merged commits whose subject ends in `(#N)`, with the base at `commit^`. A custom `mining.pattern` regex overrides either.

The verification command is auto-detected per task from the PR head tree: `package.json` with a `scripts.test` becomes `npm test`; a `Makefile` with a `test:` target becomes `make test`; a `pyproject.toml` mentioning pytest becomes `python -m pytest`. Set `verification.command` to force one for every task.

## Review is a feature, not a footnote

Auto-mining underdelivers without curation - the quality of what you approve is the moat. `agentbench review` walks every pending task showing its prompt, changed files and verification command, and records approve / reject / skip per task in `tasks/index.yaml`. Rejected tasks are never auto-run. `run` executes only approved tasks unless you name one explicitly with `--task`.

## Grading semantics

Each attempt is graded by:

1. Diffing the sealed workspace against its orphan base commit (untracked work is staged first, so new files count). Empty diff -> **no-change**.
2. Applying the patch to a fresh verifier worktree of *your* repo at the task's base commit. If it does not apply (strict, then `--ignore-whitespace` retry) -> **patch-conflict**.
3. Copying the task's **held-out test files** - snapshotted from the PR head at mine time, so grading needs no git history - over the verifier tree. These are the ground-truth tests; the agent never sees them at run time.
4. Running the verification command. Exit 0 -> **pass**, otherwise **fail**. Anything unexpected -> **error**.

One honest simplification: we require only **after-pass**, not a strict fail-to-pass proof. The base state is the pre-fix tree by construction, so tests that trivially pass at base were already filtered out upstream by nothing more than trust in your CI - if you want the stronger guarantee, run the verification at base yourself and reject tasks whose tests pass there (roadmap item).

Cost is best-effort: for claude-like agents the newest session transcript under `~/.claude/projects` overlapping the attempt window is parsed for its last usage record; codex-like agents are read from `~/.codex/sessions`; anything else shows `-`. Latency is always recorded.

## Anti-cheat and threat model

The Databricks blueprint's central lesson: an agent left alone with your real repository will read its git history, and the future fix or the future tests may be one `git log` away. agentbench-local's answer is the **sealed workspace**:

- The agent never runs in your repository. `run` materializes the base commit's tree through a temporary `git worktree`, copies it out, `git init`s a **brand-new standalone repository** there, and commits the tree as a single **orphan commit**.
- The sealed workspace has no remote, no reflog pointing at your repo, no branches, no prior history and no future commits - `git log` shows exactly one commit.
- Your original repository is never mutated. We deliberately avoid the tempting `git worktree add` + `git remote remove origin` dance: linked worktrees share `.git/config`, so removing a remote from a worktree would remove it from *your* repo. Copy-then-fresh-init needs no such surgery; the temporary worktree is removed and pruned immediately.
- The held-out tests are never in the workspace: they exist only as blobs under `.agentbench/tasks/` and are copied into the *verifier* worktree at grade time.
- Every attempt is graded from a patch applied to a pristine base - the agent cannot write into the verifier.

What this does **not** protect against, honestly:

- **Network egress.** The agent process is a normal process; nothing here sandboxes networking. If your threat model includes exfiltration, run the agent under your OS-level network sandbox (or air-gapped machine) - that is where this tool is designed to live anyway.
- **Guessing.** A sealed workspace is a copy of your source; an agent that "recognizes" a public repository may know its real history. For private code this is implausible; for public code, filter tasks by age (`--since`) or accept the bias equally across agents.
- **Flaky tests.** Fail-to-flaky is indistinguishable from fail-to-pass with after-only grading. Re-run `grade` to confirm.

## Configuration reference (`agentbench.yaml`)

```yaml
agents:
  claude:
    command: 'claude -p "{{prompt}}"'
  codex:
    command: 'codex exec "{{prompt}}"'
  fake:                                   # built-in offline demo agent
    command: 'node "{{agentbench}}/demo/fake-agent.js" "{{prompt}}" --workdir "{{workdir}}"'

mining:
  strategy: merge          # merge | squash
  # pattern: '^PR-(\d+)'   # custom subject regex
  since: 6mo               # 30d | 6mo | 2y | ISO date
  max: 50
  # branch: main
  testGlobs: ['**/*.test.*', '**/*_test.*', 'test/**', '**/tests/**']
  sourceExcludeGlobs: ['**/package-lock.json', '**/yarn.lock']
  minSourceFiles: 1
  maxSourceFiles: 12
  minMessageLength: 40
  excludeSubjectPatterns: ['^chore\b', '^revert\b', '\bbump(ed)?\b']

verification:
  # command: npm test      # omit to auto-detect per task
  env: {}
  timeoutSec: 600

run:
  timeoutSec: 900
```

Every key maps 1:1 to the documented heuristics above; unknown keys are ignored. `agents` entries are `name: command` (or `name: { command: ... }`).

## Agent template guide

A command template is a shell command line (it runs through the system shell, cwd = the sealed workspace) with three substitutions:

- `{{prompt}}` - the task prompt plus "Work in the current directory. Do not create a new repository."
- `{{workdir}}` - absolute path of the sealed workspace
- `{{agentbench}}` - absolute path of the agentbench-local install (used by the fake agent template)

The same values are always exported as environment variables: `AGENTBENCH_PROMPT`, `AGENTBENCH_WORKDIR`, `AGENTBENCH_TASK`, `AGENTBENCH_AGENT`.

Quoting caveats, earned the hard way on Windows:

- Substituted values are wrapped in double quotes with best-effort escaping of embedded quotes. On Windows the shell is `cmd.exe`, where quote escaping is famously not a real thing; prompts containing `"` may still confuse some CLIs.
- Multiline prompts survive `cmd.exe` inside quotes, but keep expectations modest: if an agent offers a stdin/file prompt mode, prefer it.
- On POSIX, `$`, backticks and backslashes inside the prompt are escaped; if a prompt contains shell-sensitive text you care about, prefer a wrapper script: `my-run.sh "$AGENTBENCH_WORKDIR"` with the prompt read from `$AGENTBENCH_PROMPT`.
- The timeout (`run.timeoutSec`) kills the whole process tree (`taskkill /T /F` on Windows, process-group kill on POSIX).

## Reports

`agentbench report` writes `.agentbench/report.md` and a self-contained `.agentbench/report.html` (no external assets, safe to open anywhere) and prints the console leaderboard: per-agent resolve rate, average best-effort token cost and wall-clock, a task x agent matrix, and per-task drill-in (prompt, patch stat, verification output tail).

## Development

```bash
npm install
npm run build     # tsc -> dist/
npm test          # node:test via run-tests.mjs (explicit dist/test/*.test.js, no glob args)
npm run demo      # full pipeline against a generated fixture repo, zero network, zero agents
```

The test suite builds a real fixture repository in the OS temp dir with isolated git config (`GIT_CONFIG_GLOBAL` empty, `GIT_CONFIG_NOSYSTEM=1`), then runs the entire pipeline against it - including the acceptance test that the fake agent's fix makes the PR's held-out tests pass, and the anti-cheat assertions that the original repository's remote and history are untouched while the sealed workspace contains exactly one orphan commit.

## Roadmap

- **Optional LLM-judge grading** alongside test-based grading, for tasks whose PR added no assertions (still local; you choose the model).
- **Before-run verification** to compute true fail-to-pass rates and auto-flag trivial tasks.
- **Scheduled refresh** via [cronagent](https://github.com/agentbench-local/cronagent) (our sibling project): nightly re-mine, re-run, and a rolling leaderboard in your team chat.
- **Cost tracking** beyond the current best-effort transcript parsing: per-agent cost adapters, cache-token weighting, and dollars in the report.
- **Sandbox hooks** so agent commands can be wrapped in a network-isolating runner per OS.

## License

MIT - see [LICENSE](LICENSE). (c) 2026 agentbench-local contributors.
