# Changelog

## v0.2.1 (2026-10-10)

Fixes for the four defects found by the independent acceptance test of v0.2.0 (macOS and Linux, installed from the
public tag, on a copy of spring-framework).

- **Security: `kopt_read` served some git-ignored files.** A target with no `/` and no extension kopt knows
  (`debug.log`, `id_rsa`, `server.key`, `cert.pem`, `notes.swp`, `*.iml`, `credentials`), or written `./debug.log`,
  was taken for a symbol name, skipped the access rules and was then read from disk. The read tools are
  auto-approved, so an agent could read these files without asking. Now every file text kopt quotes goes through the
  same check (`loadSource()`): `kopt_read` by handle, name, path or range, outlines, `kopt_find` pack bodies,
  `kopt_refs` code lines, the source hints of a failing `kopt_run` and the background re-parse of changed files. A
  name that is also an ignored file resolves to the symbol or is refused. The check also covers the real location of
  the path (a symlink inside the project to an ignored file), `.GIT/config`, the `.gitignore` files and
  `info/exclude` of an enclosing repository (a project opened in a subfolder, linked worktrees), and the Windows
  spellings that open an ignored file (`debug.log.`, `id_rsa::$DATA`). `kopt_run` log handles only read the plain
  log files kopt wrote.
- **`kopt_run` with a minimal `PATH`.** A Kiro started from the Dock may give its MCP servers `PATH=/usr/bin:/bin`:
  `npm test` exited 127 with no hint. On Linux and macOS a command now gets the `PATH` kopt started with, then the
  folder of the Node running kopt, then the login shell's `PATH` (read once with `$SHELL -ilc`, in the background,
  output never shown; `KOPT_LOGIN_PATH=0` skips it), then `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and
  nvm's default Node when they exist. Windows keeps the inherited `PATH`. A command that is still not found (exit
  127, or cmd.exe's "is not recognized") ends with one line naming the missing program and where the `PATH` came from.
- **`kopt_run` summary of a failing node:test run.** A new filter for `node --test` (TAP, which node prints when the
  output is not a terminal, as under `kopt_run`; spec and dot reporters too) keeps each failing test as
  `FAIL <file> > <suite> > <name>`, the assertion message with its diff, the expected and actual values, and the
  file:line of the failure; the passing tests, YAML keys, runner frames and zero counters are dropped, and a passing
  run is one verdict line. Four real node:test outputs were added to the compression fixtures; the 50 earlier
  fixtures compress exactly as before. Paths under a macOS temp folder printed as `/private/var/...` are now made
  relative too.
- **Stale `kopt_find` right after a write.** When a full freshness check was running (after a git change) and the
  agent wrote a file, the next call answered from the old index. A call now waits, 2 s at most, for a refresh of the
  files the hooks reported, queued after the running one. When the full check is due on that very call (the agent
  was idle for 2 minutes, or git state moved), the written files are re-indexed first, in a pass the call waits for,
  and the full check runs after it.

Found by the verification of these fixes:

- **Security: files ignored only by the user's global git excludes were served.** `core.excludesFile` (global or
  repository config), else `$XDG_CONFIG_HOME/git/ignore` or `~/.config/git/ignore`, now apply, below `info/exclude`,
  as in git.
- **Security: a nested ignore file could re-include a file inside an excluded folder.** Folders are now checked
  from the top down and the first excluded one decides (git's rule), in the access check and in the indexer. A nested
  `.kiroignore` no longer re-includes what another one excludes (each Kiro ignore file is its own evaluator). A
  folder that a deeper `.gitignore` re-includes (`!/app/learn/build`) is readable again.
- **Login shell.** Its `PATH` is taken as soon as the shell prints it: a profile that leaves a background job on
  stdout no longer makes the read wait for the 3 s timeout and report the `PATH` as unreadable, and the job is left
  running. The MCP server reads it only when `kopt_run` is not turned off (`disabledTools`, `KOPT_DISABLE_RUN=1`),
  and `kopt run` in a terminal skips it (`KOPT_LOGIN_PATH=1` restores it).

## v0.2.0 (2026-10-10)

The first release after the v0.1 prototype, local-only: one `npx` command sets kopt up for Kiro IDE (0.12 and 1.x)
and Kiro CLI (2.x and V3) on Linux, macOS and Windows, with nothing written into repositories. Kiro lists 4 tools
(`kopt_find`, `kopt_read`, `kopt_refs`, `kopt_run`) and a routing-only steering file, which cut the fixed prompt
from 852 to 348 tokens; retrieval gained member reads and writes, callers with call lines, thin wrappers, interface
families and a completeness line; `kopt_run` lists every failing test and points at the source of a failure; big
repositories are indexed in a worker thread and answer during the first build; `kopt_read` refuses ignored files,
`.git` and paths that leave the project. Measured: one `kopt_find` pack call finds the answer in 108 of 138 offline
tasks in 11 languages (CodeGraph 79, a disciplined native agent 54), and real agents exploring code cost 23% less
([-38%, -8%]) with every answer correct. Kiro credits were not measured. Details: [docs/BENCHMARKS.md](docs/BENCHMARKS.md).
