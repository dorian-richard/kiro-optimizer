# Installation guide

The [README](../README.md) one-liner is all most people need:

```bash
npx -y github:dorian-richard/kiro-optimizer setup
```

Restart Kiro afterwards. Until v0.2 is merged into `main`, this command installs v0.1 (the head of `main`); to
install v0.2, run `npm ci && npm run build && node dist/bin.js setup --global` from a checkout of it.

This page explains what `setup` does, which files it writes on each OS and for each Kiro surface, the optional
per-project mode, and troubleshooting. kopt runs entirely on your machine: there is no server to deploy and nothing
is sent over the network.

## 1. Prerequisites

| | Linux | macOS | Windows |
|---|---|---|---|
| Node.js ≥ 22.13 | `nvm install 22` ([nvm](https://github.com/nvm-sh/nvm)) or your distro's package | `brew install node@22` or `nvm install 22` | `winget install OpenJS.NodeJS.LTS` or [nvm-windows](https://github.com/coreybutler/nvm-windows) |
| git | required (npm fetches kopt from GitHub with git) | required (Xcode CLT) | [Git for Windows](https://git-scm.com/download/win) |
| Kiro | IDE 0.12+ and/or Kiro CLI 2.x / V3 | same | same |
| PowerShell 7 (recommended) | n/a | n/a | `winget install Microsoft.PowerShell`: `kopt_run` uses it when present (it accepts `&&`); otherwise Windows PowerShell 5.1, then cmd.exe |

Check your Node version with `node --version`. There are no native modules: no compiler or build tools are needed.

## 2. What `kopt setup` does

`kopt setup` is idempotent: run it again at any time (after a Kiro upgrade, for example). It:

1. **Installs `kopt` globally** when it runs from the npx cache. The copy npx already built is packed and installed
   with `npm install -g <tarball>`: nothing is downloaded or compiled a second time, and the global copy does not
   depend on the npx cache (which npm purges). Skip this with `--no-global`; install another build with
   `KOPT_INSTALL_SPEC=<npm spec>` (packed the same way). A development checkout is left alone unless you pass
   `--global`.

   Kiro never runs kopt from the npx cache. When the global install is skipped (`--no-global`) or fails (for
   example `EACCES` with a system Node on Linux), setup installs a private copy in `~/.kopt/runtime` instead (same
   tarball, `npm install -g --prefix ~/.kopt/runtime`); if that fails too, setup writes nothing and tells you how to
   fix npm.

   To install by hand without `setup`, do not run `npm install -g github:dorian-richard/kiro-optimizer`: npm cannot
   build a git dependency that has a `prepare` step in global mode (it fails with `tsc: command not found`). Use
   `npm pack github:dorian-richard/kiro-optimizer`, then `npm install -g ./kiro-optimizer-<version>.tgz`.
2. **Detects the Kiro surfaces** installed: the Kiro IDE version (from its `resources/app/package.json`) and the
   Kiro CLI version and agent engine (`kiro-cli --version`, `chat.agentEngine`). `--surface ide|cli|all` overrides the
   detection. When nothing is detected, every surface is configured.
3. **Writes user-level Kiro configuration only** (next section). Nothing is written into your projects.
4. **Runs `kopt doctor`** and prints a short summary, for example:
   `kopt is active for every project in Kiro IDE 1.2.56 and Kiro CLI 2.28.0. Restart Kiro.`

Other options: `--dry-run` shows what would be written, `--force` overwrites kopt files you edited by hand and makes
`kopt` the Kiro CLI default agent even if you chose another one (your own fields of the `kopt` entry in `mcp.json`,
such as `env`, `disabled`, `disabledTools` or `autoApprove`, are always kept), `--no-doctor` skips the final checks.

### Why absolute paths

Kiro IDE started from the macOS Dock, the Windows Start menu or a Linux desktop launcher does not get the `PATH` of
your shell profile, where nvm, volta, fnm, asdf or Homebrew put `node` and `kopt`. So nothing setup writes into
Kiro's configuration is looked up on `PATH`:

- the MCP server is started as `<absolute Node> <absolute kopt>/dist/bin.js mcp`, without a shell. The Node is the
  one setup ran with (22.13 or later); a Homebrew Node is referenced through its stable `opt/<formula>` alias, which
  `brew upgrade` keeps;
- every hook runs a small launcher by absolute path: `~/.kopt/bin/kopt` (a `sh` script) on Linux and macOS,
  `%USERPROFILE%\.kopt\bin\kopt.cmd` on Windows. It holds the absolute Node and kopt paths. A bare path with no quotes
  runs unchanged in `sh`, `cmd.exe` and PowerShell; on Windows, a profile path with spaces is written in its 8.3
  short form (or quoted for `cmd.exe`, which Kiro IDE uses for hooks). For `kopt hook` the launcher turns every
  failure into a silent exit 0, and passes exit 2 (block) through: a missing Node or package never prints into a
  Kiro session, and a Stop hook can never exit 1 (in Kiro IDE 1.x that means "continue the agent").

**Upgrades.** Run `kopt setup` again (or the `npx` one-liner) after upgrading kopt, after switching to another Node
version manager or major version (`nvm install 24`, then `nvm use 24` and setup), or after `nvm uninstall` of the
version setup used: it rewrites the launcher, `mcp.json` and the hook files. `kopt doctor` reports a configured Node
or kopt that is gone.

`KOPT_HOOK_COMMAND=shim` keeps the portable bare `kopt` form (only for a Kiro that inherits a `PATH` with kopt on
it, for example teams that commit `kopt init` files); `KOPT_HOOK_COMMAND=node` writes `<node> <bin.js>` into the hook
files instead of the launcher.

## 3. Files written

`~/.kiro` is `%USERPROFILE%\.kiro` on Windows. Kiro's `KIRO_HOME` variable relocates it, and kopt follows it.

| File | Read by | Content |
|---|---|---|
| `~/.kopt/bin/kopt` (`kopt.cmd` on Windows) | the hooks | the launcher described above (absolute Node and kopt paths) |
| `~/.kiro/settings/mcp.json` | IDE, CLI | adds the `kopt` server: `{"command": "<absolute node>", "args": ["<absolute kopt>/dist/bin.js", "mcp"]}`, the read-only tools auto-approved (`kopt_run` still asks), and `timeout` / `requestTimeout` of 900000 ms when missing (Kiro CLI cuts MCP calls at 120 s by default, too short for a Maven or Gradle run through `kopt_run`). Other servers and keys are kept. |
| `~/.kiro/hooks/kopt.json` | IDE 1.x, CLI V3 | the session governor as global v1 hooks (`~/.kopt/bin/kopt hook --source global`) |
| `~/.kiro/agents/kopt.json` | CLI 2.x | an agent with the same hooks in the 2.x object form, `includeMcpJson: true` and the read-only kopt tools trusted. The IDE ignores agents that embed hooks. |
| `~/.kiro/settings/cli.json` | CLI 2.x | `"chat.defaultAgent": "kopt"`, only when no default agent was set (or with `--force`) |
| `~/.kiro/agents/kopt-explorer.json` | CLI | read-only exploration sub-agent on a cheaper model. Kiro IDE skips agent files with CLI-only fields such as `allowedTools` (from a reading of the IDE bundles), so only Kiro CLI uses it |
| `~/.kiro/steering/kopt.md`, `kopt-specs.md` | IDE, CLI | under 50 words always loaded (which kopt tool for which question), plus code-change and spec guidance loaded on demand |
| `~/.kiro/settings/kiroignore` | IDE | a marked block of build artifacts nobody edits by hand: minified bundles (`*.min.js`, `*.min.css`...), source maps, `*.bundle.js` / `*.chunk.js`. Kiro IDE denies both reads and writes of matched files, in every project, and a project cannot re-include them: lockfiles and test snapshots, which an agent may have to read or rewrite, are only suggested per project (`kopt init`). |
| Kiro IDE user `settings.json` | IDE | adds `.kiroignore` to `kiroAgent.agentIgnoreFiles` (default `[]`), so the IDE honours project `.kiroignore` files. macOS: `~/Library/Application Support/Kiro/User/settings.json`; Linux: `$XDG_CONFIG_HOME/Kiro/User/settings.json` (default `~/.config/...`); Windows: `%APPDATA%\Kiro\User\settings.json`. Comments are kept. |

Data kopt writes at run time:

| Location | Content |
|---|---|
| macOS `~/Library/Caches/kopt/`, Linux `$XDG_CACHE_HOME/kopt/` (default `~/.cache/kopt/`), Windows `%LOCALAPPDATA%\kopt\` | one folder per project (`<name>-<hash>`): the index (`index.db`) and the raw logs of `kopt_run` |
| `~/.kopt/` (`%USERPROFILE%\.kopt`) | the local usage log read by `kopt stats` (kept 90 days, never sent anywhere), governor session state, install state, the hook launcher (`bin/`) and, when the global npm install was not possible, the private copy of kopt (`runtime/`). Created owner-only on Linux and macOS (folders 0700, files 0600). |
| Kiro IDE 0.x only, and only when prompt pointers are on (`budgets.frontload` above 0; off by default): `<project>/.kiro/hooks/kopt-prompt.kiro.hook` | see section 4; listed in `.git/info/exclude` so `git status` stays clean |

`kopt setup` never touches your shell profile or `PATH`.

## 4. How each Kiro surface uses kopt

- **Kiro IDE 1.x**: reads the user `mcp.json` (4 kopt tools), the global hooks in `~/.kiro/hooks/`, the global steering
  and the global ignore file. Reload the window after setup.
- **Kiro IDE 0.x (0.12)**: reads the MCP server, the global steering and the global ignore file, but loads hooks only
  from each workspace's `.kiro/hooks/*.kiro.hook`. The only hook kopt would use there adds prompt pointers, which are
  off by default: with the defaults, nothing is written into your workspaces. When you turn prompt pointers on
  (`budgets.frontload`, for example `200`) and the installed IDE is 0.x, the kopt MCP server writes one legacy hook
  into each workspace it serves, on its first start there: `kopt-prompt.kiro.hook` (a `promptSubmit` hook that adds
  a few index pointers to the prompt when retrieval is confident). The IDE asks once per workspace before running
  it. The tool-call governor is not installed on 0.x: there, every `preToolUse` / `postToolUse`
  command hook intercepts or annotates each matched tool call, even when it prints nothing, which would cost an
  extra model turn per call. Upgrade to Kiro IDE 1.x for the full governor. Turn the workspace hook off with
  `KOPT_LEGACY_WORKSPACE_HOOKS=0` (or `"kiro": {"legacyWorkspaceHooks": "off"}` in `~/.kopt/config.json`); force it
  with `on`. When the IDE updates itself to 1.x, the MCP server stops writing these hooks (it re-reads the IDE
  version), and the next `kopt setup` removes the ones it wrote.
- **Kiro CLI 2.x**: `kiro-cli chat` starts the `kopt` agent (the default agent), which embeds the hooks and includes the
  servers of `mcp.json`. If you keep another default agent, use `kiro-cli chat --agent kopt`.
- **Kiro CLI V3** (`kiro-cli --v3`, or `kiro-cli settings chat.agentEngine v3`): reads `~/.kiro/hooks/kopt.json` and
  `mcp.json`, like the IDE 1.x. If both the global hooks and the agent hooks run, kopt handles each event once.
- **Any terminal or other agent**: the same operations exist as commands, with the same compact output:

  ```bash
  kopt find "where is the refund amount computed" --pack
  kopt read "#3mv"
  kopt read src/billing --focus refund
  kopt refs OrderService.place --depth 2
  kopt run -- mvn -q test
  kopt read o1a2b3c --grep "FAIL|Exception"
  ```

## 5. Which project kopt serves, and where its index lives

The user-level server (`kopt mcp` with no `--root`) learns the project when Kiro connects: the first folder of the
client's MCP roots when the client advertises them, else `KOPT_ROOT`, else the folder Kiro starts it in (Kiro IDE
starts MCP servers in the workspace folder). The folder is widened to its git root, so a session opened in a
sub-folder uses the repository's index. Your home folder and a filesystem root are never indexed: kopt tools then
answer one line asking you to open a project folder.

The first build runs in the background in a worker thread. Search, read and outline answer as soon as the files are
parsed and written; references (`kopt_refs`) once they are resolved. A call that would wait longer than 15 seconds
answers at once with the progress and an estimate ("index building: 12000/33090 files parsed, ~2 min left"). After
that, the index refreshes incrementally in the same worker thread: hooks record the files the agent writes and the
next tool call re-indexes them; a pull or checkout is caught by a check that runs on a tool call, at most every 30
seconds (git state) or 2 minutes (everything); there is no timer. Run `kopt index --refresh` after a large pull if you
want it up to date immediately.

On a big repository, pre-build the index before opening Kiro: `kopt index --root <repo>`. A 30k-file Java
repository takes about 1.5 minutes and up to 2 GB of memory, and its index takes about 1 GB on disk (per checkout:
three worktrees, three indexes). `KOPT_INDEX_WORKERS=2` lowers the memory of the first build (the default below
12 GB of RAM). Measured on Elasticsearch, 33,090 indexed files ([docs/BENCHMARKS.md](BENCHMARKS.md#large-repositories-elasticsearch-and-vs-code)):
`kopt index` 79.5 s with a 2.04 GB memory peak and a 941 MB index; through MCP, search answers after 32 s and
references after 87 s; afterwards the files the agent writes are re-indexed by its next call (under a second) and
`kopt index --refresh` after a pull of 200 changed files takes 4 s. VS Code (14,713 files): 27.9 s, 338 MB. A
`kopt index` started while Kiro's server builds the index waits for it, then only catches up.

Override the index location with `KOPT_DATA_DIR` (one folder, per process) or `KOPT_CACHE_DIR` (the parent of all
project folders). A project that already has a `.kopt/` folder keeps its index there (per-project mode).

**Repository configuration files.** A `kopt.config.json` at the root of a repository (and `.kopt/config.json` in
per-project mode) is merged after your `~/.kopt/config.json`, and today it can set any key, including `root` (the
folder kopt indexes and serves), `dataDir`, `userDir` (unless `KOPT_HOME` is set) and the governor settings. Before
opening a repository you did not write, check whether it commits either file. Restricting repository files to
harmless keys is planned.

## 6. Optional: per-project install

`kopt setup` already covers every project. To commit kopt's Kiro files to one repository instead (for a team that
does not run `setup`), run from its root:

```bash
kopt init           # writes the files below; --dry-run to preview, --force to overwrite your edits
```

| File | Used by | Purpose |
|---|---|---|
| `.kiro/settings/mcp.json` | IDE, CLI | the `kopt` server pinned to this root (absolute Node and kopt paths) |
| `.kiro/hooks/kopt.json` | IDE 1.x, CLI V3 | session governor (`~/.kopt/bin/kopt hook --source workspace`; the launcher is written too) |
| `.kiro/agents/kopt-explorer.json` | IDE, CLI | read-only exploration sub-agent |
| `.kiro/steering/kopt.md`, `kopt-specs.md` | IDE, CLI | steering |
| `.kiroignore` (marked block) | IDE, CLI V3 | lockfiles, minified bundles, generated code and large data files, from an analysis of the repository |
| `.vscode/settings.json` | IDE | `kiroAgent.agentIgnoreFiles` += `.kiroignore` |

`.kiro/settings/mcp.json` and `.kiro/hooks/kopt.json` hold absolute paths of your machine (see "Why absolute paths"):
keep them out of git and commit the other files, or set `KOPT_HOOK_COMMAND=shim` before `kopt init` for the
portable bare `kopt` form (it then needs kopt on the `PATH` Kiro starts with). `kopt init` refuses to run from the npx
cache: run `kopt setup` first.

`kopt init --user` writes the user-level files of section 3 without the npm step. Workspace and global
configurations can coexist: events reported by both hook files are handled once.

## 7. Check it and see what it saves

```bash
kopt doctor               # Node, PATH, Kiro versions, config files, hooks run silently, MCP server, index status
kopt doctor --quick       # the same without starting the hook command and the MCP server
kopt stats --days 7       # tokens returned vs exact baselines, governor blocks, built-in tool output sizes
kopt credits              # per-request Kiro CLI credits collected from local sessions
```

`kopt doctor` prints one line per check (`ok`, `warn` or `fail`, with a fix). It runs the configured hook commands the
way Kiro does (through a shell, event JSON on stdin) and checks that an allowed call exits 0 with no output at all,
that a blocked call exits 2 and that a Stop event exits 0; it starts the MCP server the way Kiro does and lists its
tools. Both run with the environment of a Kiro started from the Dock or the Start menu: `PATH=/usr/bin:/bin` on
Linux and macOS, the Windows system folders on Windows. It also fails a command that is looked up on `PATH`, lives
in the npx cache, no longer exists, or runs a Node older than 22.13.

## 8. Uninstall

```bash
kopt uninstall            # removes what setup / init wrote, and the index caches
npm uninstall -g kiro-optimizer
```

`kopt uninstall` removes only kopt's own entries: the `kopt` server in `mcp.json`, kopt's hook, agent and steering
files, its marked block in `kiroignore`, `chat.defaultAgent` if it is still `kopt`, the `.kiroignore` settings entry
if setup added it, the IDE 0.x workspace hooks, the hook launcher and the private copy of kopt. A kopt file you edited
since kopt wrote it (checked against the hash kopt recorded) is kept and listed; `--force` removes it too. Shared
files and folders that `setup` created itself (for example `~/.kiro/settings/mcp.json` on a machine that had none)
are deleted again when nothing but kopt's emptied entry is left in them; anything you added keeps them. Only kopt's
own per-project folders are deleted from the cache folder (a shared `KOPT_CACHE_DIR` keeps everything else). Run from
your home folder, it never treats it as a project: `~/.kopt` is only deleted by `--purge`. Options: `--keep-index`
keeps the caches, `--purge` also deletes `~/.kopt`, `--user` / `--workspace` limit the scope, `--force` also removes
edited kopt files, `--dry-run` previews. Running it twice is harmless.

## Troubleshooting

- **`kopt: command not found` in a terminal**: npm's global bin folder is not on your `PATH`. Run `npm prefix -g` and
  add its `bin` folder (Linux/macOS) or the folder itself (Windows), or add `~/.kopt/bin`. Kiro does not need it: it
  runs kopt by absolute path.
- **Several Node versions (nvm, volta, fnm)**: run `setup` with Node 22.13+ active. Kiro then uses that Node by
  absolute path, whatever `nvm default` or the `node` on Kiro's `PATH` is. Re-run `kopt setup` after removing that
  Node version.
- **Global install fails (`EACCES`)**: setup falls back to a private copy in `~/.kopt/runtime` and says so. To have
  the `kopt` command in your terminal, point npm at a folder you own (`npm config set prefix ~/.npm-global`, then add
  `~/.npm-global/bin` to `PATH`) and run setup again.
- **The MCP panel does not list kopt**: restart Kiro; in Kiro IDE, check that MCP support is enabled in Settings.
  Run `kopt doctor`: it starts the server exactly as configured.
- **Hooks do nothing in the IDE**: run `kopt doctor`. Any output on the allow path would intercept tool calls, so
  doctor checks that it is silent. On IDE 0.x, accept the one-time prompt to run the workspace hook.
- **Kiro CLI does not use the kopt agent**: another default agent was kept. Run `kiro-cli chat --agent kopt`, or
  `kopt setup --force`. The V3 engine may offer to upgrade agent configs; kopt's global hooks work in V3 either way.
- **Windows**: hooks run `%USERPROFILE%\.kopt\bin\kopt.cmd hook …` by absolute path (no quotes, so the same line works
  in cmd.exe and PowerShell; a bare `kopt` would also make PowerShell pick npm's `kopt.ps1`, which the default
  execution policy blocks). The MCP server runs `<absolute node.exe> <kopt>\dist\bin.js mcp`, so nothing needs to be
  on the `PATH` Kiro sees. `kopt_run` runs commands in PowerShell 7 (`pwsh.exe`) when it is on
  the `PATH`, else in Windows PowerShell 5.1 (no `&&`: the agent must chain with `;`), else in cmd.exe; its tool
  description names the shell so the model writes matching syntax. Force one with `KOPT_SHELL` (for example
  `KOPT_SHELL=cmd`, or the full path of Git Bash's `bash.exe`).
- **`ExperimentalWarning: SQLite`**: `kopt` silences it in code (the `kopt` entry point filters it before loading
  SQLite), so it never reaches Kiro.

Environment variables:

| Variable | Effect |
|---|---|
| `KOPT_ROOT` | project root for `kopt mcp` / CLI commands when the client sends no MCP roots |
| `KOPT_DATA_DIR`, `KOPT_CACHE_DIR` | index location (one project / all projects) |
| `KOPT_HOME` | kopt's user folder (default `~/.kopt`) |
| `KIRO_HOME` | Kiro's user folder (default `~/.kiro`) |
| `KOPT_LEGACY_WORKSPACE_HOOKS` | `0` / `1`: IDE 0.x workspace hook off / on (default: on when the installed IDE is 0.x and prompt pointers are on) |
| `KOPT_INDEX_ON_START` | `0`: do not start the background index build when the MCP server starts |
| `KOPT_HOOKS` | `0`: disable all kopt hooks |
| `KOPT_HOOK_COMMAND` | `shim`: write the bare `kopt` command (needs kopt on Kiro's `PATH`); `node`: `<node> <bin.js>` in hook files instead of the launcher |
| `KOPT_INSTALL_SPEC` | npm spec `setup` installs globally (default: the copy npx is running; packed, then installed from the tarball) |
| `KOPT_SHELL` | shell used by `kopt_run` / `kopt run` (default: bash or sh on Linux/macOS; `pwsh`, then Windows PowerShell, then cmd.exe on Windows) |
| `KOPT_TELEMETRY` | `0`: no local usage log (`kopt stats` then has nothing to report) |
