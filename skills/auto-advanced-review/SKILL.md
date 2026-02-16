---
name: auto-advanced-review
description: Advanced Auto behavior: generate spec bundle, present for review/edit, then generate/run orchestration JSON.
license: MIT
compatibility: opencode
---

## Purpose
Define the Advanced Auto UX contract.

## Behavior
- Generate spec bundle from prompt (use auto-spec-bundle).
- Present documents for review/edit.
- Only after explicit approval:
  - generate OrchestrationPackage JSON
  - run

## Rules
- Treat edits as source of truth; regenerate JSON from edited docs.
- Warn if JSON is stale vs current docs.
- Preserve user changes; do not overwrite without asking.
