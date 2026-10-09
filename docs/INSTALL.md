# Installation guide

The [README](../README.md) one-liner is all most people need:

```bash
npx -y github:dorian-richard/kiro-optimizer setup
```

Restart Kiro afterwards. This page explains what `setup` does, which files it writes on each OS and for each Kiro
surface, the optional per-project mode, and troubleshooting. kopt runs entirely on your machine: there is no server
to deploy and nothing is sent over the network.

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
   `KOPT_INSTALL_SPEC=<npm spec>` (packed the same way). A development checkout is left alone (use `npm link`, or
   pass `--global`).

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
`kopt` the Kiro CLI default agent even if you chose another one, `--no-doctor` skips the final checks.

## 3. Files written

`~/.kiro` is `%USERPROFILE%\.kiro` on Windows. Kiro's `KIRO_HOME` variable relocates it, and kopt follows it.

| File | Read by | Content |
|---|---|---|
| `~/.kiro/settings/mcp.json` | IDE, CLI | adds the `kopt` server: `{"command": "kopt", "args": ["mcp"]}` with the read-only tools auto-approved (`kopt_run` still asks). Other servers and keys are kept. On Windows the entry is `node <path to kopt>\dist\bin.js mcp`. |
| `~/.kiro/hooks/kopt.json` | IDE 1.x, CLI V3 | the session governor as global v1 hooks (`kopt hook --source global`; `kopt.cmd` on Windows) |
| `~/.kiro/agents/kopt.json` | CLI 2.x | an agent with the same hooks in the 2.x object form, `includeMcpJson: true` and the read-only kopt tools trusted. The IDE ignores agents that embed hooks. |
| `~/.kiro/settings/cli.json` | CLI 2.x | `"chat.defaultAgent": "kopt"`, only when no default agent was set (or with `--force`) |
| `~/.kiro/agents/kopt-explorer.json` | IDE, CLI | read-only exploration sub-agent on a cheaper model |
| `~/.kiro/steering/kopt.md`, `kopt-specs.md` | IDE, CLI | under 140 words always loaded, plus spec guidance loaded on demand |
| `~/.kiro/settings/kiroignore` | IDE | a marked block of generic token sinks (lockfiles, minified bundles, source maps, snapshots) |
| Kiro IDE user `settings.json` | IDE | adds `.kiroignore` to `kiroAgent.agentIgnoreFiles` (default `[]`), so the IDE honours project `.kiroignore` files. macOS: `~/Library/Application Support/Kiro/User/settings.json`; Linux: `$XDG_CONFIG_HOME/Kiro/User/settings.json` (default `~/.config/...`); Windows: `%APPDATA%\Kiro\User\settings.json`. Comments are kept. |

Data kopt writes at run time:

| Location | Content |
|---|---|
| macOS `~/Library/Caches/kopt/`, Linux `$XDG_CACHE_HOME/kopt/` (default `~/.cache/kopt/`), Windows `%LOCALAPPDATA%\kopt\` | one folder per project (`<name>-<hash>`): the index (`index.db`) and the raw logs of `kopt_run` |
| `~/.kopt/` (`%USERPROFILE%\.kopt`) | the local usage log read by `kopt stats` (kept 90 days, never sent anywhere), governor session state, install state |
| Kiro IDE 0.x only: `<project>/.kiro/hooks/kopt-prompt.kiro.hook` | see section 4; listed in `.git/info/exclude` so `git status` stays clean |

`kopt setup` never touches your shell profile or `PATH`.

## 4. How each Kiro surface uses kopt

- **Kiro IDE 1.x**: reads the user `mcp.json` (6 kopt tools), the global hooks in `~/.kiro/hooks/`, the global steering
  and the global ignore file. Reload the window after setup.
- **Kiro IDE 0.x (0.12)**: reads the MCP server, the global steering and the global ignore file, but loads hooks only
  from each workspace's `.kiro/hooks/*.kiro.hook`. When the installed IDE is 0.x, the kopt MCP server therefore writes
  one legacy hook into each workspace it serves, on its first start there: `kopt-prompt.kiro.hook` (a `promptSubmit`
  hook that adds a few index pointers to the prompt when retrieval is confident). The IDE asks once per workspace
  before running it. The tool-call governor is not installed on 0.x: there, every `preToolUse` / `postToolUse`
  command hook intercepts or annotates each matched tool call, even when it prints nothing, which would cost an
  extra model turn per call. Upgrade to Kiro IDE 1.x for the full governor. Turn the workspace hook off with
  `KOPT_LEGACY_WORKSPACE_HOOKS=0` (or `"kiro": {"legacyWorkspaceHooks": "off"}` in `~/.kopt/config.json`); force it
  with `on`.
- **Kiro CLI 2.x**: `kiro-cli chat` starts the `kopt` agent (the default agent), which embeds the hooks and includes the
  servers of `mcp.json`. If you keep another default agent, use `kiro-cli chat --agent kopt`.
- **Kiro CLI V3** (`kiro-cli --v3`, or `kiro-cli settings chat.agentEngine v3`): reads `~/.kiro/hooks/kopt.json` and
  `mcp.json`, like the IDE 1.x. If both the global hooks and the agent hooks run, kopt handles each event once.
- **Any terminal or other agent**: the same operations exist as commands, with the same compact output:

  ```bash
  kopt find "where is the refund amount computed" --pack
  kopt read "#3mv"
  kopt outline src/billing --focus refund
  kopt refs OrderService.place --depth 2
  kopt run -- mvn -q test
  kopt expand o1a2b3 --grep "FAIL|Exception"
  ```

## 5. Which project kopt serves, and where its index lives

The user-level server (`kopt mcp` with no `--root`) learns the project when Kiro connects: the first folder of the
client's MCP roots when the client advertises them, else `KOPT_ROOT`, else the folder Kiro starts it in (Kiro IDE
starts MCP servers in the workspace folder). The folder is widened to its git root, so a session opened in a
sub-folder uses the repository's index. Your home folder and a filesystem root are never indexed: kopt tools then
answer one line asking you to open a project folder.

The first build runs in the background in a worker thread; tool calls wait up to 15 seconds, then answer
"index building … retry shortly". After that, the index refreshes incrementally: hooks record the files the agent
writes, and each tool call re-indexes only what changed. Run `kopt index --refresh` after a large pull if you want it
up to date immediately.

Override the index location with `KOPT_DATA_DIR` (one folder, per process) or `KOPT_CACHE_DIR` (the parent of all
project folders). A project that already has a `.kopt/` folder keeps its index there (per-project mode).

## 6. Optional: per-project install

`kopt setup` already covers every project. To commit kopt's Kiro files to one repository instead (for a team that
does not run `setup`), run from its root:

```bash
kopt init           # writes the files below; --dry-run to preview, --force to overwrite your edits
```

| File | Used by | Purpose |
|---|---|---|
| `.kiro/settings/mcp.json` | IDE, CLI | the `kopt` server pinned to this root |
| `.kiro/hooks/kopt.json` | IDE 1.x, CLI V3 | session governor (`kopt hook --source workspace`) |
| `.kiro/agents/kopt-explorer.json` | IDE, CLI | read-only exploration sub-agent |
| `.kiro/steering/kopt.md`, `kopt-specs.md` | IDE, CLI | steering |
| `.kiroignore` (marked block) | IDE, CLI V3 | lockfiles, minified bundles, generated code and large data files, from an analysis of the repository |
| `.vscode/settings.json` | IDE | `kiroAgent.agentIgnoreFiles` += `.kiroignore` |

`kopt init --user` writes the user-level files of section 3 without the npm step. Workspace and global
configurations can coexist: events reported by both hook files are handled once.

## 7. Check it and see what it saves

```bash
kopt doctor               # Node, PATH, Kiro versions, config files, hooks run silently, MCP server, index status
kopt doctor --quick       # the same without starting the hook command and the MCP server
kopt stats --days 7       # tokens returned vs exact baselines, governor blocks, built-in tool output sizes
kopt credits              # per-request Kiro CLI credits collected from local sessions
```

`kopt doctor` prints one line per check (`ok`, `warn` or `fail`, with a fix). It runs the configured hook command the
way Kiro does (through a shell, event JSON on stdin) and checks that an allowed call exits 0 with no output at all,
and that a blocked call exits 2; it starts the MCP server the way Kiro does and lists its tools.

## 8. Uninstall

```bash
kopt uninstall            # removes what setup / init wrote, and the index caches
npm uninstall -g kiro-optimizer
```

`kopt uninstall` removes only kopt's own entries: the `kopt` server in `mcp.json`, kopt's hook, agent and steering
files, its marked block in `kiroignore`, `chat.defaultAgent` if it is still `kopt`, the `.kiroignore` settings entry
if setup added it, and the IDE 0.x workspace hooks. Shared files and folders that `setup` created itself (for
example `~/.kiro/settings/mcp.json` on a machine that had none) are deleted again when nothing but kopt's emptied
entry is left in them; anything you added keeps them. Options: `--keep-index` keeps the caches, `--purge` also deletes
`~/.kopt`, `--user` / `--workspace` limit the scope, `--dry-run` previews. Running it twice is harmless.

## Troubleshooting

- **`kopt: command not found`**: npm's global bin folder is not on your `PATH`. Run `npm prefix -g` and add its `bin`
  folder (Linux/macOS) or the folder itself (Windows). Kiro keeps working meanwhile: `setup` then configures an
  explicit Node path instead of the `kopt` command.
- **Several Node versions (nvm)**: global packages are per Node version. Run `setup` with Node 22.13+ active. If the
  `node` on your `PATH` is older, `setup` pins the Node binary it ran with; re-run `kopt setup` after removing that
  Node version.
- **The MCP panel does not list kopt**: restart Kiro; in Kiro IDE, check that MCP support is enabled in Settings.
  Run `kopt doctor`: it starts the server exactly as configured.
- **Hooks do nothing in the IDE**: run `kopt doctor`. Any output on the allow path would intercept tool calls, so
  doctor checks that it is silent. On IDE 0.x, accept the one-time prompt to run the workspace hook.
- **Kiro CLI does not use the kopt agent**: another default agent was kept. Run `kiro-cli chat --agent kopt`, or
  `kopt setup --force`. The V3 engine may offer to upgrade agent configs; kopt's global hooks work in V3 either way.
- **Windows**: hooks run `kopt.cmd hook …` (it works in cmd.exe and PowerShell; a bare `kopt` would make PowerShell
  pick npm's `kopt.ps1`, which the default execution policy blocks). The MCP server runs `node <kopt>\dist\bin.js mcp`,
  so `node.exe` must be on the `PATH` Kiro sees. `kopt_run` runs commands in PowerShell 7 (`pwsh.exe`) when it is on
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
| `KOPT_LEGACY_WORKSPACE_HOOKS` | `0` / `1`: IDE 0.x workspace hook off / on (default: on when the installed IDE is 0.x) |
| `KOPT_INDEX_ON_START` | `0`: do not start the background index build when the MCP server starts |
| `KOPT_HOOKS` | `0`: disable all kopt hooks |
| `KOPT_INSTALL_SPEC` | npm spec `setup` installs globally (default: the copy npx is running; packed, then installed from the tarball) |
| `KOPT_SHELL` | shell used by `kopt_run` / `kopt run` (default: bash or sh on Linux/macOS; `pwsh`, then Windows PowerShell, then cmd.exe on Windows) |
| `KOPT_TELEMETRY` | `0`: no local usage log (`kopt stats` then has nothing to report) |
