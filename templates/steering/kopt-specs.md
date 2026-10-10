---
inclusion: auto
name: kopt-specs
description: Token-efficient code changes. Use when implementing, fixing or editing code, running tests, or executing tasks from a spec tasks.md.
---
# Code changes
- Be concise: don't restate code or the plan back; no summary of what you did unless asked.
- Edit with the smallest exact replacement; never rewrite whole files. Don't re-read files you just wrote.
- Run tests and builds with `kopt_run`, only the affected tests; no full-suite rerun when nothing changed since it passed.
- Spec tasks: one at a time, don't start the next unless asked; one-line status notes.
- Stop when the acceptance criteria are met.
