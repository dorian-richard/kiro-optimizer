# Troubleshooting

- **`kopt: command not found`**: npm's global bin folder is not on your `PATH`. Run `npm prefix -g` and add its `bin`
  folder (Linux/macOS) or the folder itself (Windows). Kiro is not affected: setup configures it with absolute
  paths.
- **Several Node versions (nvm)**: global packages are per Node version. Run `setup` with Node 22.13+ active.
- **Kiro does not list kopt's tools**: restart Kiro; in Kiro IDE, check that MCP is enabled in Settings. Then run
  `kopt doctor`: it starts the server exactly as configured.
- **Tools answer `index building: … left`**: the first build of a big repository is still running (search answers
  once files are parsed, `kopt_refs` a little later). Wait, or pre-build it with `kopt index --root <repo>` before
  opening Kiro.
- **Tools answer `index unavailable: …`**: the build failed; kopt retries after 1, 2, 4… minutes. `kopt doctor`
  shows the error; `kopt index` in the project prints it in full.
- **Tools answer `no project folder is open`**: Kiro was opened on your home folder or a filesystem root, which kopt
  never indexes. Open the project folder.
- **Hooks seem to do nothing**: run `kopt doctor`. In Kiro IDE 0.x only the prompt hook exists, and the IDE asks once
  per workspace before running it. Hook errors are logged to `~/.kopt/hook-errors.log`.
- **Kiro CLI 2.x does not use the kopt agent**: another default agent was kept. Run `kiro-cli chat --agent kopt`, or
  `kopt setup --force`.
- **Windows: `kopt_run` chain syntax fails**: Windows PowerShell 5.1 has no `&&`. Install PowerShell 7
  (`winget install Microsoft.PowerShell`), or set `KOPT_SHELL`.

More in [docs/INSTALL.md](INSTALL.md#troubleshooting). Module contracts: [docs/CONTRACTS.md](CONTRACTS.md).
The hard questions about how kopt works, answered with what was measured and what was not:
[docs/FAQ.md](FAQ.md) (in French).
