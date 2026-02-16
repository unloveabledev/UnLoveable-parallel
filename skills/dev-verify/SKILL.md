---
name: dev-verify
description: Define and run a verification matrix (lint/type-check/test/build) and report actionable failures.
license: MIT
compatibility: opencode
---

## Purpose
Prevent regressions by enforcing a verification habit.

## Output
- command list
- expected pass conditions
- failure triage checklist

## Rules
- Run fast checks first, then slower ones.
- If a failure is unrelated, call it out explicitly.
