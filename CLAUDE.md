# CLAUDE.md — AI Assistant Guide for jobtool

## Project Overview

**jobtool** is a job posting data extraction and conversion tool.

> 求人データのページを吸い上げて求人票化する
> ("Extract job posting data from web pages and convert them into job posting documents/forms")

The project is in its initial state — only a README exists. Development conventions and workflows defined here should be followed as the codebase grows.

---

## Repository Layout

```
jobtool/
├── CLAUDE.md         # This file — AI assistant guide
├── README.md         # Project overview (Japanese)
└── tasks/            # Planning and tracking artifacts
    ├── todo.md       # Active task plan (checked items = done)
    └── lessons.md    # Lessons learned; updated after mistakes
```

As the project grows, expected structure:

```
jobtool/
├── src/              # Main source code
├── tests/            # Test suite
├── docs/             # Documentation
└── ...
```

---

## Workflow Orchestration

### 1. Plan Before Acting

- Enter plan mode for **any non-trivial task** (3+ steps or architectural decisions).
- Write the plan to `tasks/todo.md` with checkable items before touching code.
- If something goes sideways mid-task: **STOP and re-plan** — do not keep pushing.
- Verify the plan covers edge cases and rollback before starting.

### 2. Subagent Strategy

- Use subagents to keep the main context window clean.
- Offload research, codebase exploration, and parallel analysis to subagents.
- For complex problems: throw more compute at it via subagents.
- One focused task per subagent.

### 3. Self-Improvement Loop

- After **any correction from the user**: update `tasks/lessons.md` with the pattern.
- Write rules that prevent the same mistake from recurring.
- Review `tasks/lessons.md` at the start of each session for relevant context.

### 4. Verification Before Done

- Never mark a task complete without proving it works.
- Run tests, check logs, demonstrate correctness.
- Ask: *"Would a staff engineer approve this?"*
- Diff behavior between main and your changes when relevant.

### 5. Demand Elegance (Balanced)

- For non-trivial changes: pause and ask *"is there a more elegant way?"*
- If a fix feels hacky: implement the elegant solution instead.
- Skip this for simple, obvious fixes — avoid over-engineering.

### 6. Autonomous Bug Fixing

- Given a bug report: just fix it. No hand-holding needed.
- Point at logs, errors, failing tests — then resolve them.
- Fix failing CI tests without being asked how.

---

## Task Management Protocol

1. **Plan First** — Write plan to `tasks/todo.md` with checkable items.
2. **Verify Plan** — Review before starting implementation.
3. **Track Progress** — Mark items `[x]` as you complete them.
4. **Explain Changes** — High-level summary at each step.
5. **Document Results** — Add a review section to `tasks/todo.md` when done.
6. **Capture Lessons** — Update `tasks/lessons.md` after any user correction.

---

## Core Development Principles

| Principle | Description |
|-----------|-------------|
| **Simplicity First** | Make every change as simple as possible. Minimal code impact. |
| **No Laziness** | Find root causes. No temporary fixes. Senior developer standards. |
| **Minimal Impact** | Touch only what is necessary. Avoid introducing regressions. |

---

## Git Conventions

- **Development branch**: `claude/claude-md-mlyh0p6iwci1askk-fdb4g`
- Branch names follow the pattern: `claude/<description>-<session-id>`
- Always push with: `git push -u origin <branch-name>`
- Use clear, descriptive commit messages that explain *why*, not just *what*.
- Never push to a different branch without explicit permission.

---

## Language Notes

- The project context is Japanese (job posting data, Japanese web pages).
- Comments, variable names, and documentation should follow the language used in the codebase as it develops. English is acceptable for code; Japanese for domain-specific content.

---

## When the Codebase Grows — Conventions to Follow

When implementation is added, update this file with:

- **How to run** the tool (CLI commands, entry points)
- **How to run tests** (`make test`, `pytest`, `npm test`, etc.)
- **How to lint/format** (`ruff`, `black`, `eslint`, etc.)
- **Environment variables** required (use `.env.example` as reference)
- **Dependencies** and how to install them
- **Architecture decisions** and key design patterns

---

*Last updated: 2026-02-23 — Initial scaffold, project not yet implemented.*
