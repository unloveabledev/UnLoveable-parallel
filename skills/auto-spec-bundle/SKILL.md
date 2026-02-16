---
name: auto-spec-bundle
description: Generate a detailed spec bundle (SPEC/UI_SPEC/PLANS) suitable for orchestrated execution.
license: MIT
compatibility: opencode
---

## Purpose
Produce a multi-document spec bundle that an orchestrator can act on.

## Output documents
- SPEC.md
  - Problem statement, scope, non-goals, constraints, user flow, done criteria
- UI_SPEC.md (if UI touched)
  - screens, states, interactions, accessibility, visual direction
- IMPLEMENTATION_PLAN.md
  - ordered steps, milestones, validation steps, rollback
- ARCHITECTURE_PLAN.md (if complex)
  - components/modules, data flow, risk points, alternatives

## Rules
- Done Criteria must be testable/verifiable.
- Explicitly list assumptions + open questions.
- Add a Validation Plan section (how to prove success).
- Keep each document readable; avoid giant walls of text.
