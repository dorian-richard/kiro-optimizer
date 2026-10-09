# kiro-optimizer (`kopt`)

Token optimizer for [Kiro](https://kiro.dev). It cuts both input and output tokens on large codebases. It does
not proxy Kiro's LLM traffic, because Kiro does not allow that.

It provides:
- budgeted code-intelligence MCP tools;
- command-output compression;
- session-governor hooks;
- an optional centralized deployment on AWS.

It works on three surfaces: **Kiro IDE**, **Kiro CLI** (V3 and legacy 2.x), and the **standalone `kopt` CLI**,
which any terminal or agent can call.

**Status: prototype under active development (v0.1).** Interfaces may still change.

## Why another tool

On large repositories, existing "code graph" tools (KiroGraph, CodeGraph) save little. Kiro bills credits per
request, and the cost grows with the total request size. Every token that enters the context is **billed again on
every later turn** of the session.

Real spend therefore comes from:
- resident history multiplied by the number of turns;
- verbose build and test logs that get re-run;
- whole-file reads;
- the fixed prefix (steering, tool schemas);
- runaway agent loops.

A code graph only addresses a small slice of that. The detailed analysis is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). It was verified against the source code of the existing tools and
against the Kiro documentation.

## The five levers

1. **`kopt_run` / `kopt_expand`**: tests, builds and linters return only the verdict, the failures and the errors.
   The full log stays available by handle. An identical command re-run with no file change is not executed again.
2. **Session governor**, built on Kiro `command` hooks, which consume no credits. It provides:
   - a tool-call circuit breaker;
   - a one-time redirect of whole-file reads of big files;
   - a one-time redirect of verbose commands to `kopt_run`;
   - blocking of identical re-runs;
   - per-tool measurement of built-in tool output sizes.
3. **Budgeted code navigation** (`kopt_find`, `kopt_read`, `kopt_outline`, `kopt_refs`):
   - hard token caps, compact text output (never JSON), short handles such as `#3mv`;
   - per-session dedup;
   - a `pack` mode that returns task-level context in one call;
   - code-aware lexical search plus centrality (PageRank).
4. **Minimal fixed prefix**: 6 tools, `always` steering under 140 words, and a generated `.kiroignore`.
5. **Output levers**: steering for concise answers and minimal edits, plus an exploration sub-agent on a cheaper model.

## Architecture

- **Local**: `kopt mcp` (stdio MCP server), `kopt hook` (governor), and a local SQLite index (`node:sqlite`,
  FTS5) built with tree-sitter (WASM). No native dependencies.
- **Centralized (in the customer's AWS account)**:
  - per-commit indexing in CI (CodeBuild), with snapshots stored in S3 (KMS);
  - a multi-repository Streamable HTTP MCP server on ECS Fargate with OAuth (Cognito or the corporate IdP);
  - CloudWatch telemetry and a savings dashboard;
  - infrastructure as AWS CDK.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/CONTRACTS.md](docs/CONTRACTS.md).

## Quick start (v0.1 target)

```bash
nvm use 22            # Node >= 22.13
npm install && npm run build
npx kopt index        # index the current repository into .kopt/index.db
npx kopt init         # configure Kiro: mcp.json, steering, hooks, explorer agent, .kiroignore
npx kopt stats        # tokens returned, measured savings, governor blocks
```

## Measurement

No savings figure is claimed without measurement:
- `kopt bench` is an offline benchmark on large open-source repositories, using tasks with verified gold answers.
- `bench/ab/` is an online A/B harness that runs `kiro-cli` in non-interactive mode. It compares credits on paired
  tasks and only counts tasks that both arms solved.

## License

[MIT](LICENSE)
