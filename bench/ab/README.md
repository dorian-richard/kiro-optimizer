# Online A/B: does kopt reduce YOUR Kiro credits?

`kopt bench ab` runs the same questions about your own repository through the real Kiro CLI, with and without kopt,
and compares the credits Kiro bills. It runs on Linux, macOS and Windows, on your machine, with your Kiro account.

| arm | what Kiro sees |
|---|---|
| **A** (baseline) | stock Kiro: no kopt MCP server, no kopt hook, no kopt steering, no kopt index |
| **B** | kopt installed the way `kopt init` installs it: MCP server + hooks + steering (+ `.kiroignore`) |
| **C** (optional, `--arms A,B,C`) | the kopt MCP server only: no hooks, no steering. Tells whether the tools or the prompt-side changes do the work |

Every run is a fresh, non-interactive `kiro-cli chat` session with the same prompt, the same model and the same
built-in tools in every arm. The harness counts the credits of each run, proves that the kopt arms really called kopt,
grades the answers, and writes a report with a verdict.

It costs real credits. Read [Budget](#budget-and-a-first-probe) before the first run, and always pass `--max-credits`.

## Read this first: your Kiro account

Kiro runs anti-abuse checks on accounts, and **they can suspend an account** that looks automated. This happened while
this harness was being built: a developer's **Free** account (Builder ID) was temporarily suspended on its very first
automated headless request. Shortly before, and the likely trigger, a `kiro-cli chat` command run by a script in a
temporary home directory had started a browser login on its own, the browser (already signed in) had completed it,
and a logout and a new manual login followed. Kiro answered the headless request with *"Your User ID is temporarily
suspended. We detected unusual user activity and locked it as a security precaution"*. No credit was spent;
restoring access goes through Kiro support.

Before you run `kopt bench ab`:

- **Log in yourself, with the normal Kiro login**: `kiro-cli login` in your own terminal (or the Kiro IDE's sign-in),
  then check it with `kiro-cli whoami`. Never let a script or an agent log in for you.
- **Never let a script trigger a login.** Do not run `kiro-cli` commands from scripts in a temporary or sandboxed home
  directory: there kiro-cli is logged out, and a logged-out `kiro-cli chat ...` (even `--list-models` or
  `--list-sessions`) can open a browser login by itself. `kopt bench ab` never logs in: it reads your login with
  `kiro-cli whoami` and stops when there is none.
- **Avoid repeated logins and logouts, and many headless sessions in a short time**, especially on a Free account.
  Start with one small probe (one task, one repetition), keep campaigns small, never run two campaigns at once, and
  do not retry in a loop after an error.
- **If Kiro suspends or locks the account**, stop: do not retry, do not resume. Contact Kiro support at
  <https://support.aws.amazon.com/#/contacts/kiro>. The harness stops at the first such error (`account_blocked`) and
  sends nothing more from that output directory until you pass `--resume --account-restored`.
- **Prefer a paid account (Pro or above) for A/B campaigns.** Kiro's headless documentation is written for API keys
  (`KIRO_API_KEY`), which only paid plans can create, and a campaign is, by design, many automated sessions.

What the harness does to keep its own footprint small:

- `--check` sends no prompt. Of kiro-cli it runs `--version`, **one** `whoami`, and, only once you are logged in,
  `agent validate` and `mcp list` per arm (local commands). Logged out, it runs nothing else.
- Reading your account's model list (`kiro-cli chat --list-models`, a request to Kiro) is **opt-in**: `--list-models`.
- The smoke run (one tiny prompt per arm) is **opt-in**: `--smoke`. It is never run automatically.
- Before every run it reads the login again (`whoami`): a run never starts logged out.

## 1. Prerequisites

- **A Kiro account with credits.** Free (50 credits a month, and only some models: see the
  [Kiro model list](https://kiro.dev/docs/models/)), Pro, Pro+, Pro Max or Power. Every run is billed like a normal chat.
- **Kiro CLI 2.28 or later, logged in by you** (see the warning above). Kiro's headless documentation says a
  non-interactive run needs an API key (`KIRO_API_KEY`), which only Pro, Pro+, Pro Max and Power can create. A
  browser login (`kiro-cli login`: Builder ID, GitHub or Google; check it with `kiro-cli whoami`) reached Kiro's
  backend in the one headless request made so far (Kiro answered it with an account error, not a login error), but a
  complete headless answer on a browser login is not verified. The harness reuses your login and never logs in for
  you.
- **Node.js 22.13 or later.**
- **kopt**, one of:
  - installed: `npx -y github:dorian-richard/kiro-optimizer setup` installs it globally (the package is not on the
    npm registry); then `kopt bench ab ...`;
  - from a checkout: `npm ci && npm run build`, then run it with an absolute Node 22.13+:
    `/path/to/node dist/bin.js bench ab ...` (`--node <path>` picks the Node that runs kopt for the arms; the default is
    the Node running the command, never a `node` found on `PATH`).
- **The repository you want to test, committed.** Each arm gets a `git worktree` of `HEAD`: uncommitted changes are
  not part of the test.
- **Disk and time.** `--check` already creates one worktree per arm (the size of a checkout of your repository,
  three times with `--arms A,B,C`) and builds one kopt index per kopt arm (up to `--index-timeout`, 30 minutes by
  default, on a large repository; the index takes about the size of the source code). A campaign takes roughly
  `tasks x arms x reps` times the length of one Kiro answer (1 to 5 minutes each), plus the smoke runs with `--smoke`.

## 2. Write your tasks (5 or more)

Copy [`tasks.example.json`](tasks.example.json) and replace its tasks with questions about your repository:

```json
{
  "tasks": [
    {
      "id": "refund-amount",
      "kind": "locate",
      "prompt": "Where is the amount of a refund computed, and what caps it?",
      "gold": { "files": ["src/billing/refunds.py"], "symbols": ["compute_refund", "RefundPolicy"] }
    },
    { "id": "rename-impact", "kind": "impact", "prompt": "If I rename Order.total_amount, what has to change?" }
  ]
}
```

YAML works too (`tasks.yaml`, same fields). Field by field:

- `id`: letters, digits, `.`, `_`, `-`.
- `prompt`: the question, as you would type it in Kiro.
- `kind` (optional): a label to group results (`locate`, `usage`, `impact`...).
- `gold` (optional): what a correct answer must name. `files` are repo-relative paths, `symbols` are function, class or
  method names. With a gold, the answer is graded automatically: it passes when it names at least 60% of the files
  and 60% of the symbols (`--pass-ratio` changes the threshold). `--check` warns when a gold file is not in the
  repository or a gold symbol appears nowhere in its code.
- Without a gold, you grade the answers yourself (step 5). Until you do, that task is **left out of the main view** of
  the report (the pairs both arms answered correctly); the report names it.

Good tasks:

- are questions developers on this repository really ask, ideally ones that need several files to answer;
- have a gold you checked in the code before the first run;
- are written down **before** you see any result. Do not tune them afterwards.

A conclusive verdict needs **5 tasks and 10 pairs** (pairs = tasks x reps), or a sign test below 0.05 over at least
3 tasks. Fewer gives "promising" or "not conclusive" at best.

The harness appends one sentence to every prompt, in every arm: "Do not modify any file. Answer concisely and name the
exact files (repo-relative paths) and the functions, classes or methods involved." It keeps the agent read-only and
makes answers gradable. `--no-prompt-suffix` turns it off.

The offline benchmark's task files (`bench/tasks/<repo>.json`) load as they are.

## 3. Check everything without sending a prompt

```bash
kopt bench ab --check --repo ~/src/my-repo --tasks my-tasks.json
```

`--check` prepares the arms and checks, in the exact environment of the runs:

- the Node used for kopt (absolute path, 22.13 or later);
- kiro-cli: found, version, engine; self-update off in every arm;
- the login (one `kiro-cli whoami`). If you are not logged in, it says how to log in yourself and runs no other
  kiro-cli command. The login is read again before every run: a logged-out `kiro-cli chat` can start a browser login
  on its own, so none is ever started without a valid login;
- the agent of each arm, with the real `kiro-cli agent validate` (it only checks the JSON shape: a wrong tool name
  passes it; only a run proves the tools are visible and trusted: the smoke run with `--smoke`, else the first
  planned run of each arm);
- the MCP servers kiro-cli sees for each arm (`kiro-cli mcp list`): kopt in B and C, nothing of kopt in A;
- that arm A is kopt-free: no kopt MCP entry, hook, steering, agent or index visible to it. It fails otherwise;
- in the kopt arms: the size of the kopt index (it fails when kopt found no symbol: kopt must support your
  repository's languages), the kopt hook prints nothing on its allow path, the kopt MCP server starts and lists its
  tools;
- the model, only with `--list-models`: `--model` must be in your account's model list (`kiro-cli chat --list-models`
  sends no prompt, but it is a request to Kiro; it only runs once you are known to be logged in). Without it the model
  id is not checked, and a model your plan does not have stops the campaign at its first run (`model_unavailable`);
- the tasks (gold against `HEAD`), what your repository commits that affects the arms, and the estimated cost.

`--check` exits with status 1 when a check fails.

## Budget and a first probe

`--max-credits` is a **budget**, not an exact hard cap:

- a task block (one task and repetition in every arm) only starts when the credits counted so far plus the estimated
  cost of every arm of the block fit in it, so the budget never pays for half a pair;
- while a run goes, the harness reads the credits Kiro streams. A run is killed as soon as they reach what is left of
  the budget (or `--max-run-credits`), and a runaway run (already 1.5 times its expected cost) is killed before a
  next request would cross the budget. This needs per-request metering in the stream (the V2 `_kiro.dev/metadata`
  events); on V3 the credits only arrive when the run is over;
- so one run can still go over: by at most the request that crossed the budget, or by a whole run when Kiro does
  not stream its metering. The estimate is the arm's measured cost once there is one, `--credits-per-run` before.

On a small plan, measure before you spend:

1. Pick the cheapest model your plan has from the [Kiro model list](https://kiro.dev/docs/models/) (on Free that is
   Qwen3 Coder Next, 0.05x), or let `--check --list-models` print your account's list with the exact ids.
2. Optional: `kopt bench ab --check --smoke --smoke-model <cheapest id> --max-credits 1 --repo ... --tasks ...` runs
   the smoke alone (one tiny prompt per arm, a few hundredths of a credit). It proves tool trust and kopt usage before
   anything else; the probe below proves the same with one real task, so on a Free account you can skip it.
3. A probe of one task, one repetition, both arms, in a scratch output directory:

   ```bash
   kopt bench ab --repo ~/src/my-repo --tasks my-tasks.json --out /tmp/kopt-ab-probe \
     --only <one task id> --reps 1 --model <cheapest id> --timeout 120 \
     --credits-per-run <your guess> --max-credits <at least twice one pair>
   ```

4. Read the measured credits in `/tmp/kopt-ab-probe/runs.csv`, then start the real campaign in its own `--out`, with
   `--credits-per-run` set to what you measured.

Example of a campaign: 5 tasks, arms A and B, 2 repetitions = 20 runs. At 0.5 to 3 credits a question (it depends on
the model's multiplier), that is 10 to 60 credits. `--check` prints the estimate.

## 4. Run

```bash
kopt bench ab --repo ~/src/my-repo --tasks my-tasks.json --max-credits 60 --credits-per-run 2
```

What happens:

1. Preflight: the checks of step 3. Nothing runs if one fails.
2. **Smoke run, only with `--smoke`** (opt-in), before the first real run: one tiny prompt per arm, on `--smoke-model`
   (default: `--model`; with `--list-models`, the cheapest model of your list), with exactly **one tool call**: arm A
   reads a small file of the repository with its built-in read tool, the kopt arms call `kopt_read` on it with `mode: "outline"`. Each arm
   must produce credits and an answer, its tool call must complete in the stream, kopt's own telemetry must show the
   call in the kopt arms, arm B must show its kopt hooks ran, and arm A must not touch kopt. At the first anomaly it
   stops and prints a diagnosis: which arm, the error, every tool call with its status, the stderr tail, which credit
   sources were found, and the files to look at. Once it passed in an output directory it is not run again. Without
   `--smoke`, the first planned run of each arm is its first headless request, and the stops below apply to it.
3. The planned runs: every task, in every arm, `--reps` times (default 2). The order is seeded and counterbalanced: for
   each task and repetition, the arms run back to back, and the arm that goes first alternates (A B, B A, B A, A B...).
   Slow drift (time of day, backend load) then hits every arm equally.
4. The report.

The campaign stops early, and still writes the report:

- at the budget (see above);
- at the first fatal error: account blocked by Kiro, not logged in, expired login, quota reached, model not
  available, kopt MCP server not starting, agent not found, a read-only tool denied, arm A reaching kopt, a run killed
  at the budget;
- when kiro-cli changes version (an update): results would mix two versions;
- when the first 2 valid runs of arm B never called a kopt tool according to kopt's telemetry (kopt is then most
  likely not reachable, not allowed, or failing);
- after `--max-consecutive-failures` invalid runs in a row (default 3).

Ctrl-C (or a closed terminal) stops the current run, records the campaign as interrupted and writes the report. To
continue a stopped or interrupted campaign, run the same command with `--resume`:

- finished runs are kept;
- runs a killed harness left unfinished are run again. A kiro-cli it left running is stopped first, the session
  files it wrote are collected, and the attempt is counted for what Kiro measured (at least the estimate);
- runs that failed for reasons outside the arm (login, quota, throttling, a model or MCP startup problem, the budget)
  are run again; a timed-out run is run again when `--timeout` is larger than it was;
- after Kiro blocked the account (`account_blocked`), nothing is sent until you add `--account-restored`, once Kiro
  support has restored access; the blocked run is then run again;
- every replaced attempt is kept under `<out>/attempts/` and its credits keep counting toward the budget.

`--resume` refuses other settings than the original ones, and another kiro-cli version. Results go to `--out`, by
default `<repo>/../<repo-name>-kopt-ab`, which must be outside the repository. One harness process at a time can use
an output directory (`<out>/lock.json`).

Exit status: `0` done (the check passed, the campaign completed), `1` an error, a failed check, preflight or smoke
run, `2` the campaign stopped early (resume it), `130` interrupted.

Main options (all of them: `kopt bench ab --help`):

| option | default | |
|---|---|---|
| `--arms A,B` | `A,B` | add `C` for the MCP-only arm |
| `--reps N` | `2` | repetitions per task and arm |
| `--model ID` | `claude-sonnet-4.5` | pinned for every run. Do not use Auto: it routes requests to different models |
| `--engine v2\|v3` | `v2` | kiro-cli agent engine (see [Isolation](#isolation)) |
| `--max-credits N` | required | the budget of the whole campaign, smoke runs included |
| `--max-run-credits N` | | kill a single run whose metered credits reach N |
| `--credits-per-run N` | `2` | cost guess used until real runs are measured |
| `--timeout S` | `600` | a run is killed after S seconds and counted as invalid |
| `--tools read[,write,shell]` | `read` | built-in tools given to every arm (see the warning below) |
| `--setting key=value` | | Kiro CLI setting written for every arm, e.g. `chat.enableKnowledge=false` |
| `--smoke` | off | the smoke run before the first real run (or with `--check`); a few headless requests more |
| `--list-models` | off | read your account's model list in the preflight (one request to Kiro): checks `--model`, picks the cheapest smoke model |
| `--account-restored` | | with `--resume`, after Kiro support restored an account the campaign found blocked |

**`--tools write` and `--tools shell`** trust `fs_write` and `execute_bash` without asking, in every arm, with your
real home directory and credentials (the home directory is not replaced: the login lives there). A shell tool can also
commit, switch branches or stash in the repository the worktrees share. The harness resets the worktree's `HEAD` and
files after every run, but it cannot undo what a command did outside the worktree. Keep the default (`read`) unless the
questions need more.

## 5. Read the report

`report.md` starts with the verdict for each kopt arm, then gives:

- per arm: runs, valid runs, invalid runs of the arm's own doing, median and mean credits, credits spent, answers
  correct, median wall time, tool calls, and kopt calls per run;
- per comparison: pairs (same task, same repetition), the relative difference in credits
  (`sum(B) / sum(A) - 1`, negative = B cheaper) with its bootstrap 95% CI, the median per-pair difference, how often
  each arm was cheaper, and a sign test. It shows two views: runs **both arms answered correctly** (the main one)
  and all valid runs;
- per task: median credits and correct answers per arm;
- data quality: the credits counted against the budget (the same total the console prints: measured, estimated,
  archived attempts), every invalid run with its reason, tasks left out of the main view, kopt-arm runs that never
  called a kopt tool, and runs where the stream and session credits disagree.

**Decision rule**, fixed before the runs: an arm is **worth rolling out** when, on the pairs both arms answered
correctly,

- it saves at least 20% of the credits, the 95% CI of that saving excludes 0, and it is cheaper on more pairs than not;
- the evidence is large enough: 5 tasks and 10 pairs, or a sign test below 0.05 over at least 3 tasks;
- it is not less often correct than stock Kiro (one run of slack), counting its timeouts, missing answers, crashes and
  errors as wrong answers;
- it does not fail (those same invalid runs) more often than stock Kiro, one run of slack.

Otherwise the verdict says which condition failed: correctness drop, reliability drop, costs more, "mixed" (the total
saving comes from a minority of pairs: one large task carries it), "promising but not conclusive" (the CI includes no
saving, or the evidence is too small), "not conclusive", no saving, or fewer than 3 usable pairs.

`runs.csv` has one row per run: credits and their source, tool calls by name, kopt calls (telemetry, stream, failed),
the automatic grade with what the answer missed, and the path of the answer text. To grade answers by hand, open each
`runs/<run>/answer.md`, put `1` (correct) or `0` (wrong) in the `manual_grade` column, then rebuild the report:

```bash
kopt bench ab report --out ~/src/my-repo-kopt-ab
```

Your grades are kept:

- `runs.csv` can be saved with `,`, `;` (Excel in locales with a decimal comma) or tabs, with or without a `sep=` line;
- every grade is also copied to `manual-grades.json`, and the previous `runs.csv` is kept as `runs.csv.bak` before each
  rebuild. If `runs.csv` cannot be read at all, the grades come from `manual-grades.json`;
- a file held open by another program (Excel on Windows) is not overwritten: the new version is written next to it
  with a timestamp, and the report says so.

`report --reparse --tasks my-tasks.json` also rebuilds every run record from the raw files (stream, session files,
telemetry), which helps after a harness fix. `report.json` holds the same numbers for scripts.

## How to interpret the noise

- The same prompt costs a different amount from run to run: sampling, tool choices, backend routing. One pair proves
  nothing. The CI shows how far the result could move with other runs of the same tasks.
- A CI that crosses 0 means "not enough evidence", not "no effect". Add repetitions or tasks.
- A cheap wrong answer is not a saving. That is why the main view only keeps pairs both arms got right, and why an
  arm's own failures count against it.
- The tasks are yours, so the result is about your repository and your questions. Another repository can give
  another answer.

## Isolation

Each arm gets:

- **its own git worktree** of `HEAD` (`<out>/arms/<arm>/repo`). Before and after every run, the worktree is put back
  to exactly its prepared state: `HEAD` (a commit or branch switch by a run is undone), files the run changed are
  restored, staged and new files are removed. Kiro configuration files that a `.gitignore` hides are covered too.
  Your repository's own git hooks (husky, lefthook...) never run in the harness's git commands;
- **its own `KIRO_HOME`** (`<out>/arms/<arm>/kiro-home`): the agents, `settings/cli.json` (the same settings in
  every arm, with `app.disableAutoupdates` on), the global `mcp.json` and the V2 sessions of the arm;
- **a `KOPT_HOME` per run** (`<out>/runs/<run>/kopt-home`): kopt's telemetry of that run only;
- **a prebuilt kopt index** per kopt arm under `<out>/kopt-cache` (`KOPT_CACHE_DIR`, `KOPT_DATA_DIR`): kopt arms index
  once, before the runs, so indexing time is not charged to them, and nothing is written to your own kopt cache;
- **its own agent**, `abarm-a`, `abarm-b` or `abarm-c`, in the worktree. Every arm has the same system prompt and the
  same built-in tools; B and C add `@kopt` and trust kopt's read-only tools (`kopt_run`, which runs commands, stays
  untrusted).

The harness strips every `KOPT_*` variable you may have set, forces kopt's telemetry on (`KOPT_TELEMETRY=1`: it is the
proof that kopt was used), sets `KIRO_NO_AUTO_UPDATE`, and puts the chosen Node first on `PATH`.

**What your repository commits.**

- `.kiro/` files that mention kopt (steering, hooks, MCP entries, agents) make `--check` fail: arm A must be stock Kiro.
- MCP servers in a committed `.kiro/settings/mcp.json` are removed from every arm's worktree (arm B keeps kopt only):
  arm B's agent loads that file and arm A's does not, and a server that needs a token would make every B run fail
  with `--require-mcp-startup`. `--check` lists them.
- Other committed `.kiro/` files (steering, agents) are in every worktree alike.
- A committed `kopt.config.json` applies to the kopt arms as part of the treatment (budgets, governor), except
  `dataDir`, `userDir` and `telemetry`, which the harness overrides. `--check` says what it found.

**Your home directory is never replaced.** kiro-cli keeps its login in its data directory under your home, not
under `KIRO_HOME`: `~/Library/Application Support/kiro-cli/data.sqlite3` on macOS (verified), and per the Kiro
documentation's data directory, `~/.local/share/kiro-cli` on Linux and `%LOCALAPPDATA%\kiro-cli` on Windows.
A temporary `HOME` would log kiro-cli out, and a logged-out `kiro-cli chat` can start a browser login on its own.
The harness never reads, copies or prints credential files.

**Engines.**

- **V2** (the 2.28 default, `--engine v2`) reads its agents, MCP servers and settings from `KIRO_HOME`. Custom agents
  inherit default resources, global steering included, and whether V2 still reads `~/.kiro/steering` with
  `KIRO_HOME` set is not verified: `--check` warns when a file there mentions kopt (after `kopt setup`, for example);
  move it away during the campaign.
- **V3** (`--engine v3`) reads `~/.kiro` (hooks, steering, agents, skills, MCP servers, `settings/permissions.yaml`)
  whatever `KIRO_HOME` says: the engine resolves `<home>/.kiro` from the OS home directory and has no `KIRO_HOME`
  support. What your `~/.kiro` contains then loads in **both** arms. `--check` lists it (names only), and fails when
  it mentions kopt (a `kopt setup` install would contaminate arm A: run `kopt uninstall --user` first, or use V2).
  `kiro-cli mcp list` shows the `KIRO_HOME` view, not what V3 loads. V3 also writes its sessions under
  `~/.kiro/sessions/<hash of the worktree path>/`. The harness copies them into the run directory and leaves the
  originals in place until `clean`.

**Proof that kopt was used.** For a kopt arm, the proof is kopt's own telemetry in the run's `KOPT_HOME`: one line per
MCP tool call kopt served, plus hook events. The Kiro stream is a cross-check: only **completed** calls of a kopt tool
count there (a failed or refused call never reached kopt), named exactly `@kopt/kopt_*`, `mcp_kopt_kopt_*` or
`kopt_*` (a grep titled "Searching for kopt_find" is not a kopt call). A kopt-arm run without kopt telemetry is
flagged in the report, with the reason (no call, every call failed, or calls in the stream that kopt never logged).
For arm A, any kopt telemetry or completed kopt call makes the run invalid and stops the campaign.

**Version pinning.** The harness turns kiro-cli's self-update off in every arm and checks the version before every
run: a change stops the campaign, and `--resume` refuses it. Do not upgrade kiro-cli during a campaign; start a new
one in another `--out` after an upgrade.

## Where the credits come from

| engine | session file (preferred) | stream (cross-check, and the live budget meter) |
|---|---|---|
| V2 | `<KIRO_HOME>/sessions/cli/<id>.json`: sum of `user_turn_metadatas[].metering_usage[].value` | `_kiro.dev/metadata` `meteringUsage`, one per request, if kiro-cli forwards it |
| V3 | `~/.kiro/sessions/<bucket>/<sess_id>/messages.jsonl`: sum of `usage_summary.promptTurnSummaries[].usage` | sum of every `turn_completion` `promptTurnSummaries[].usage` (one per turn, not cumulative) |

Only entries whose unit is `credit` or `credits` count, the same filter as Kiro's own UI. Both values are kept in
`runs.csv`, with a warning when they differ by more than 5%. A run without a credit value in either place is
**invalid** (`no_credits`); a run Kiro metered at exactly 0 is invalid too (`zero_credits`), except the smoke run,
where a one-word answer on a 0.05x model can round to 0: the metering was found, which is what the smoke checks.

The final answer is `finalText` from the stream's run-finished record, otherwise the agent message chunks of the last
turn, otherwise the last assistant message of the V3 session.

## Output directory

```
<out>/
  config.json  plan.json  state.json  lock.json  report.md  report.json
  runs.csv  runs.csv.bak  manual-grades.json  aborted.jsonl
  arms/<arm>/repo/            git worktree of the arm
  arms/<arm>/kiro-home/       KIRO_HOME of the arm
  kopt-cache/                 kopt indexes of the kopt arms
  smoke/<arm>/                the smoke runs
  runs/<task>__<arm>__r<rep>/
    command.json  started.json  child.json  exit.json  record.json  answer.md
    stream.jsonl  stderr.log  kiro-chat.log  session/  kopt-home/
  attempts/<run>/<n>/         replaced attempts (aborted, retried, superseded); counted in aborted.jsonl
```

`kopt bench ab clean --out <dir>` removes the worktrees, the arms' `KIRO_HOME`s, the kopt indexes, the V3 session
folders of the worktrees under `~/.kiro/sessions`, and a kopt index an earlier version of the harness left in your own
kopt cache. The results (`runs/`, `smoke/`, `attempts/`, the reports) are kept.

## Windows

Not run on Windows yet (written from code reading); please report what differs.

- PowerShell: `$env:KIRO_API_KEY = "..."`, then `kopt bench ab --check --repo C:\src\my-repo --tasks my-tasks.json`.
  Point `--kiro-cli` (or `$env:KIRO_CLI`) at `kiro-cli-chat.exe` if it is not found: its install location on Windows is
  not verified, and a `.cmd` shim cannot carry a multi-line prompt.
- Long paths: the output directory makes every path of the worktrees longer. The harness passes
  `core.longpaths=true` to its own git commands; for Kiro and kopt, enable long paths in Windows
  (`LongPathsEnabled`) or use a short `--out` such as `C:\kab`.
- File locks: close `runs.csv` in Excel before `report` (a locked file is written next to it instead). Processes a run
  leaves behind (MCP servers) are looked up and killed after each run.
- Hooks: `--check` runs the kopt hook through cmd.exe and through PowerShell, since Kiro's choice is not verified.
- `%USERPROFILE%` and the account's profile folder are both searched for `~/.kiro` when they differ.

## What was verified against the real kiro-cli, and what was not

No credit has been measured yet: no headless run against the real Kiro has completed. Exactly this was verified live,
with kiro-cli **2.28.0** on macOS and a logged-in Free account (Builder ID), in one session:

- **`--check`, all green**: kiro-cli logged in (`whoami`); the agents of arms A and B accepted by
  `kiro-cli agent validate`; `kiro-cli mcp list` showing the kopt MCP server in arm B only; the kopt hook silent on its
  allow path.
- **The first headless request** (the smoke run of arm A, V2 engine): Kiro refused it, the account having just been
  suspended by its anti-abuse checks (see the warning at the top). The harness surfaced Kiro's error cleanly (the
  `runError` message of the stream, exit 1, about 4 seconds), stopped before arm B, and **0 credits** were spent (the
  run's V2 session file, which the harness found under the arm's `KIRO_HOME` and collected, has no metering). That run
  also showed the real stream-json envelope of a failed run (`runStarted`, `metadata` and `runError` records with
  their fields under `data`) and the V2 session file of a run without metering. At the time the error was classified
  as a generic `run_error`, counted at the smoke estimate; it is now `account_blocked`: fatal, free, and never retried
  without `--account-restored`. The recorded stream is a unit test, and the simulator's `suspended` mode reproduces
  that run.

Everything else was verified with the simulator (below) or offline: the table lists what was checked against the real
2.28.0 binary without a prompt, or against its own code. The parsers deliberately walk every JSON object and key on
Kiro's field names, so a different envelope does not silently zero the credits (the real `data` envelope above parsed
as is), and `report --reparse` can rebuild every record after a parser fix.

| fact | how it was checked |
|---|---|
| `KIRO_HOME` moves agents, global `mcp.json` and `settings/cli.json`; the login stays under `HOME`; `KIRO_DATA_DIR` does not move the login | real 2.28 (`agent list`, `mcp list`, `settings`, `whoami`) with `HOME` and `KIRO_HOME` in different temporary directories, network blocked; `whoami` with the real `HOME` and a temporary `KIRO_HOME` stays logged in |
| `whoami` exits 0 when logged in, 1 with `Not logged in` (JSON `{"account":null}`) | real 2.28, logged out |
| `agent validate` exits 0 and reports problems only on stderr; it accepts unknown tool names and permission capabilities | real 2.28 |
| `mcp list` writes its listing to stderr, one block per agent | real 2.28 |
| the agents the harness writes for arms A, B and C (V2 and V3 flavours) pass `agent validate`; `mcp list` shows kopt for B and C only; a logged-out `--check` stops at the login check without any `chat` call | `kopt bench ab --check` against the real 2.28 binary, temporary logged-out `HOME`, network blocked |
| the `kiro-cli` launcher fails with a temporary `HOME`; `kiro-cli-chat` works anywhere | real 2.28 |
| the V3 session bucket is the first 16 hex digits of sha256(working directory) | real 2.28 engine log |
| the chat flags (`--no-interactive`, `--agent-engine`, `--output-format stream-json`, `--trust-tools`, `--require-mcp-startup`, `--list-models --format json`); no per-session credit limit flag | real 2.28 `--help` |
| a refused tool in a non-interactive run prints `[denied] tool permission approval is not supported in non-interactive mode` on stderr; `toolCallFailureReason` / `permission_denied` exist in the V2 agent | strings of the 2.28 binary |
| `app.disableAutoupdates` and `KIRO_NO_AUTO_UPDATE` disable self-update | Kiro documentation |
| the V3 engine ignores `KIRO_HOME` and reads `<OS home>/.kiro` | V3 engine source shipped in the 2.28 binary; the launcher has no `--home-dir` argument |
| V3 `turn_completion` / `usage_summary` field names, `tool_call` titles `@server/tool`, MCP names `mcp_<server>_<tool>` | V3 engine source shipped in the binary |
| V2 `_kiro.dev/metadata` fields | the terminal UI code shipped in the binary |
| V2 session file field names (`user_turn_metadatas`, `metering_usage`) | names in the binary; their nesting is not known (the parser does not depend on it) |
| exit codes 3 (MCP startup) and 4 (agent not found) | Kiro documentation |

**Simulator only, to be confirmed by the first real run that completes:**

- the stream-json records of a successful run (`sessionUpdate`, `runFinished` with `finalText`), whether V2 forwards
  per-request metering into the stream (without it, the live budget meter sees nothing until the run ends), and the
  `completed` / `failed` statuses of tool calls;
- the metering entries of the V2 session file (its nesting without metering is verified), and `turn_completion`
  arriving through the stream on V3;
- that headless runs complete on a browser login (Builder ID, GitHub, Google): the headless documentation asks for
  `KIRO_API_KEY`. The one request made on a Builder ID login was authenticated (Kiro answered with an account error);
  a refused login stops the campaign with `not_logged_in` at the first run;
- the `--trust-tools` names (V2 `fs_read,grep,glob,@kopt/kopt_find,...`; V3 `read` plus the agent's permission rules
  for `kopt/*`): the first tool calls prove them (the smoke run's with `--smoke`), and a refused call stops the
  campaign;
- how a refused call shows in the stream (the parser accepts `failureReason`, `failure_reason`,
  `toolCallFailureReason`, a permission request, Kiro's refusal wording, and `[denied]` lines on stderr);
- that hooks receive Kiro's environment (the smoke run checks arm B's hooks wrote to the run's `KOPT_HOME`), and that
  MCP servers get the `env` of their entry (kopt's telemetry shows it: the smoke run checks it, and the campaign stops
  when the first 2 valid runs of arm B have none);
- whether V2 reads `~/.kiro/steering` with `KIRO_HOME` set;
- the model ids of your account (`--check --list-models` reads them from `kiro-cli chat --list-models`);
- everything specific to Windows.

## The simulator

[`fake-kiro-cli.mjs`](fake-kiro-cli.mjs) emulates kiro-cli 2.28 for the tests: `--version`, `whoami`,
`agent validate|list`, `mcp list`, `settings`, `chat --list-models` and `chat --no-interactive` with the V2 and V3
stream formats and session files above, per-request metering streamed as the run goes, and tool trust (a tool the run
does not trust is refused the way 2.28 does). It runs the real kopt hooks and starts the agent's MCP servers the way
Kiro does (all enabled servers, with a reduced environment), so kopt's telemetry in the tests is real. Its answers come
from a grep of the workspace and its credits from a formula. `fake-kiro-cli.cmd` is the Windows shim; the harness runs
the `.mjs` next to it directly.

```bash
KIRO_CLI=$PWD/bench/ab/fake-kiro-cli.mjs kopt bench ab --check --repo <repo> --tasks bench/ab/tasks.example.json
```

`KIRO_CLI` (or `--kiro-cli`) points the harness at any kiro-cli executable; without it, the harness looks for
`kiro-cli-chat` on `PATH`, in `~/.local/bin` and in the macOS app, then for the `kiro-cli` launcher. Failure modes
are selected with `FAKE_KIRO_MODE` (every run), `FAKE_KIRO_MODE_AT=<n>:<mode>` (the n-th chat run) or
`FAKE_KIRO_MODE_FOR=<agent>:<mode>`: `not-logged-in`, `hang`, `slow`, `no-stream-credits`, `no-session`,
`no-credits`, `zero-credits`, `quota`, `malformed`, `bad-model`, `mcp-fail`, `deny-kopt`, `fail-kopt`, `crash`,
`dirty` (edit, delete and stage files), `commit`, `suspended` (the stream, exit code and session file the real 2.28
wrote for a suspended account). `FAKE_KIRO_AUTH=none` logs it out, `FAKE_KIRO_LOGOUT_AFTER=<n>`
after n chat runs; `FAKE_KIRO_USE_KOPT=0` makes it ignore the kopt tools; `FAKE_KIRO_CREDITS`, `FAKE_KIRO_REQUEST_MS`
and `FAKE_KIRO_VERSION_AFTER=<n>:<version>` drive the budget and update tests. The end-to-end tests are in
`test/bench-ab-e2e.test.ts`. Under the test runner the harness starts no kiro-cli but the simulator (or a fixture
script under the OS temporary directory), and the one test of the suite that runs the real binary (offline commands in
a temporary home) is opt-in: `KOPT_TEST_REAL_KIRO_CLI=1`.

## Troubleshooting

| reason in the report | what it means | what to do |
|---|---|---|
| `account_blocked` | Kiro refused the request: the account is suspended or locked (anti-abuse) | stop; do not retry. Contact Kiro support (<https://support.aws.amazon.com/#/contacts/kiro>); once access is restored, `--resume --account-restored` |
| `not_logged_in`, `auth_expired` | kiro-cli has no valid login in the run environment | log in yourself (`kiro-cli login`, or `KIRO_API_KEY`), `kiro-cli whoami`, then `--resume`: the failed run is run again |
| `quota` | the plan's limit is reached | wait for the reset, or add credits; `--resume` then runs the failed run again (its credits still count) |
| `throttled` | the backend asked to slow down | `--resume` later: those runs are run again |
| `budget_exceeded` | the run was killed at the budget | raise `--max-credits` (or `--max-run-credits`), then `--resume` |
| `aborted` | the harness stopped before the run finished | `--resume`: the run is run again, its credits still count |
| `model_unavailable` | the model id is not available to the account | pick one from the Kiro model list, or from `--check --list-models` |
| `mcp_startup` | an MCP server of the arm did not start | run the command shown by `--check` by hand |
| `tool_denied` | a tool call was refused: the trust settings do not cover it | open an issue with `stream.jsonl` and `stderr.log` of the run |
| `no_credits`, `zero_credits` | no credit value (or 0) in the stream and the session files | look at `stream.jsonl` and `session/` of the run; after a fix, `report --reparse` |
| `timeout` | the run exceeded `--timeout` (it counts as a wrong answer) | `--resume` with a larger `--timeout` runs timed-out runs again |
| `kopt_leak` | arm A called kopt | remove kopt from the places `--check` lists |
| verdict "mixed" | the saving comes from a minority of pairs | look at the per-task table; add tasks |
