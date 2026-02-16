---
name: ralph-loop-control
description: Control a Plan->Act->Check->Fix loop with explicit stop conditions and iteration budgeting.
license: MIT
compatibility: opencode
---

## Purpose
Keep iterative work bounded and deliberate.

## Contract
Input:
- state (iteration, findings, remaining tasks)
- limits (max iterations/time/budget)
- confidence signal

Output:
- next_stage: plan | act | check | fix | end
- reason
- updated limits if re-scoping

## Rules
- End early when confidence is high and evidence is complete.
- If repeating the same failure twice, change strategy or reduce scope.
- Always produce a short "what changed this iteration" note.
