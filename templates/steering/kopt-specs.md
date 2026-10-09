---
inclusion: auto
name: kopt-specs
description: Token-efficient execution of spec tasks. Use when implementing or verifying tasks from a spec tasks.md.
---
# Spec task execution
- One task at a time; don't start the next task unless asked.
- Reuse verification already done this session; no full-suite rerun when nothing changed since it passed.
- Verify with `kopt_run` on the affected tests only.
- Keep task notes and status updates terse: one line per task.
