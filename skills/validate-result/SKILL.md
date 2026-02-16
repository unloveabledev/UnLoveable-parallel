---
name: validate-result
description: Validate a result against explicit evidence requirements; return pass/fail with reasons and fixes.
license: MIT
compatibility: opencode
---

## Purpose
Run the Check step: does the work satisfy requirements?

## Contract
Input:
- requirements (acceptance + evidence)
- result (artifacts, outputs, claims)

Output:
- verdict: pass | fail | needs_fix
- missing_evidence[]
- issues[] (severity, impact, fix)
- recommended next action

## Rules
- Treat missing evidence as fail unless explicitly optional.
- Separate incorrect vs unproven.
- Suggest the smallest fix that closes the gap.
