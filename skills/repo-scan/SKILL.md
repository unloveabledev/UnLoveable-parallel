---
name: repo-scan
description: Identify relevant modules/files quickly and propose a minimal-change plan with verification steps.
license: MIT
compatibility: opencode
---

## Purpose
Fast, reliable orientation for codebases.

## Output
- likely entrypoints
- files to edit
- constraints/conventions to follow
- verification commands to run

## Rules
- Prefer minimal diffs.
- Avoid refactors unless required.
- Always include how to verify (type-check/lint/tests/build).
