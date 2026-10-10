# kiro-optimizer (`kopt`)

[![CI](https://github.com/dorian-richard/kiro-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/dorian-richard/kiro-optimizer/actions/workflows/ci.yml)

`kopt` makes [Kiro](https://kiro.dev) (IDE and CLI) use fewer tokens on large codebases. It gives the agent 4 compact
tools (code search, code reads, callers, compressed test and build output), free hooks that stop wasteful actions, and
a 42-word steering file. Everything runs locally: no server, no cloud account, nothing leaves your machine.

**Status: v0.2.0** (git tag `v0.2.0`). Linux, macOS and Windows. Interfaces may still change.

## Results: what you save

"Without kopt" means Kiro's own tools: grep, then reading files or line ranges.

| Situation | Without kopt | With kopt | Gain |
|---|---|---|---|
| **A real agent explores unfamiliar code** (<!--v:ab.exTasks-->15<!--/v--> tasks on 9 open-source repositories, 2 runs each) | session cost = 100 | session cost = 77 | **<!--v:ab.ex.primary-->-23% [-38%, -8%]<!--/v-->** (95% confidence interval), cheaper on <!--v:ab.ex.primaryLower-->13/15<!--/v--> tasks, every answer still correct |
| **One code search** (<!--v:offline.tasks-->138<!--/v--> tasks, 11 languages) | <!--v:ranged.median-->6,675<!--/v--> tokens, complete answer in <!--v:ranged.found-->54/138 (39%)<!--/v--> | <!--v:kopt.median-->1,299<!--/v--> tokens, complete answer in <!--v:kopt.found-->108/138 (78%)<!--/v--> | **<!--v:ratio.medianRanged-->5.1x<!--/v--> fewer tokens, and the answer found twice as often** |
| **Test, build and git output** (50 outputs) | <!--v:compress.raw-->286,154<!--/v--> tokens | <!--v:compress.out-->10,402<!--/v--> tokens | **<!--v:compress.reduction-->96.4%<!--/v--> fewer tokens**, failures and file:line kept |
| A real agent diagnoses failing tests (6 tasks) | | | no measurable saving: <!--v:ab.rn.primary-->+16% [-31%, +67%]<!--/v--> |
| **Kiro credits** | | | **not measured yet**: measure them on your repository with `kopt bench ab` |

Other tools on the same 138 tasks: CodeGraph finds the complete answer in <!--v:codegraph.found-->79/138 (57%)<!--/v-->
at <!--v:codegraph.median-->8,315<!--/v--> tokens per search, KiroGraph in <!--v:kirograph.found-->4/138 (3%)<!--/v-->.

How these were measured, and their limits: the agent runs used AI agents driving a shell wrapper outside Kiro, with
Kiro's prompt size modeled; they are not Kiro credits. Full tables, charts and method:
[docs/BENCHMARKS.md](docs/BENCHMARKS.md), also as a web page:
<https://dorian-richard.github.io/kiro-optimizer/benchmarks.html>.

## Install

You need [Node.js 22.13+](https://nodejs.org) and git. Run once, on Linux, macOS or Windows:

```bash
npx -y github:dorian-richard/kiro-optimizer setup
```

Then **restart Kiro**. kopt now starts by itself in every project you open in Kiro IDE or Kiro CLI. Nothing is written
into your repositories.

- Check the installation: `kopt doctor`
- See what it saves: `kopt stats`
- Remove it: `kopt uninstall`, then `npm uninstall -g kiro-optimizer`

Details per OS and per Kiro version: [docs/INSTALL.md](docs/INSTALL.md).

## How it works

1. `kopt setup` registers kopt in Kiro's user configuration, so every project gets it.
2. When you open a project, Kiro starts the kopt server. kopt indexes the code in the background (tree-sitter, 11
   languages) and keeps the index up to date as files change.
3. The agent calls kopt's tools instead of grepping and reading whole files. Every answer has a token budget, and code
   already shown in the session is not sent again.
4. Free command hooks watch each agent action: they redirect a huge whole-file read or a verbose test command once,
   block an identical re-run when nothing changed, and stop a runaway session.
5. `kopt stats` shows what was saved.

More: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## The 4 tools the agent uses

| Tool | What it does |
|---|---|
| `kopt_find` | Searches code by identifiers or plain words. `mode: "pack"` returns the context of a task in one call. |
| `kopt_read` | Reads a symbol, a file, a line range, the outline of a folder, or a stored test log. |
| `kopt_refs` | Lists the callers of a function (with the call line), its callees, and the readers and writers of a field. |
| `kopt_run` | Runs a test, build or lint command and returns only the verdict, the failures and the errors. |

Their descriptions add about <!--v:ab.koptPrompt-->+282<!--/v--> tokens to each request. Every option and every `kopt`
command: [docs/COMMANDS.md](docs/COMMANDS.md).

## Documentation

| Page | Content |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | installation details, files written, Kiro versions |
| [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) | how kopt works, supported Kiro surfaces, measuring savings |
| [docs/COMMANDS.md](docs/COMMANDS.md) | the 4 tools and every `kopt` command with all options |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | session governor rules, config keys, environment variables, data locations |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | common problems and fixes |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | all measurements, method and limits |
| [docs/TESTING.md](docs/TESTING.md) | test plan for large repositories (in French) |
| [docs/FAQ.md](docs/FAQ.md) | the hard questions (in French) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | design decisions and why |
| [bench/ab/README.md](bench/ab/README.md) | measuring real Kiro credits on your repository (`kopt bench ab`) |

## License

[MIT](LICENSE)
