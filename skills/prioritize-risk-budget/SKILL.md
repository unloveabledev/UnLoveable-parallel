---
name: prioritize-risk-budget
description: Prioritize tasks by risk, dependency order, and budget to produce a safe execution order.
license: MIT
compatibility: opencode
---

## Purpose
Order tasks so the highest-risk unknowns are resolved early and dependencies are respected.

## Contract
Input:
- tasks[] (from plan-decompose)
- budget/time constraints
- risk tolerance (low/med/high)

Output:
- ordered_tasks[] with rationale per step
- fast-fail checkpoints
- stop conditions (when to halt or re-scope)

## Rules
- Do risky discovery/validation before heavy production.
- If a task can invalidate the approach, move it earlier.
- Insert checkpoints after major integration points.
- Explicitly call out tasks safe to run in parallel.
