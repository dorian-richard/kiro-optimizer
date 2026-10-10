---
inclusion: always
---
- Named symbol: `kopt_read X` or `kopt_find X`.
- Who calls/uses X: `kopt_refs X`; trust it, grep only what it marks unresolved.
- Many members of one file: `kopt_read <file>` mode=outline.
- How does Y work: `kopt_find` mode=pack.
- Tests, builds: `kopt_run`.
