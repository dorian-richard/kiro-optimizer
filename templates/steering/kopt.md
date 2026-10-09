---
inclusion: always
---
# kopt

## Code navigation
- New task: start with `kopt_find` mode=pack. Then `kopt_read #id`, `kopt_outline`, `kopt_refs` instead of grep + whole-file reads.
- Read ranges (`kopt_read path:a-b`), not whole files. Reuse `#id` handles already shown.

## Output
- Be concise: don't restate code or the plan back; no summary of what you did unless asked.
- Edit with the smallest exact replacement; never rewrite whole files. Don't re-read files you just wrote.
- Run tests and builds with `kopt_run`, only the affected tests.
- Stop when the acceptance criteria are met.
