---
name: plan-decompose
description: Decompose a goal into parallelizable tasks with explicit assumptions, dependencies, and outputs.
license: MIT
compatibility: opencode
---

## Purpose
Turn an ambiguous goal into a task graph suitable for parallel workers.

## Contract
Input:
- goal (1-3 sentences)
- constraints (bullet list)
- context (optional: domain, audience, time/budget)

Output:
- tasks[] where each task includes:
  - id, objective, owner (role), priority, dependencies[]
  - deliverables (artifacts produced)
  - acceptance criteria
  - evidence requirements (what proves it's done)

## Rules
- Prefer 3-7 tasks; merge tiny tasks, split overloaded ones.
- Make tasks independently executable when possible.
- List explicit assumptions and unknowns to resolve.
- Mark tasks as parallelizable when safe.
- Include a validation task if none exist.

## Template
- Assumptions:
- Unknowns / Questions:
- Task Graph:
- Risks:
- Next:
