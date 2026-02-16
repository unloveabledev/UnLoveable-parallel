---
name: auto-simple-runner
description: Simple Auto behavior: generate spec bundle, convert to orchestration JSON, and start the run automatically.
license: MIT
compatibility: opencode
---

## Purpose
Define the Simple Auto UX contract.

## Behavior
- Generate spec bundle from prompt (use auto-spec-bundle).
- Convert bundle into an OrchestrationPackage JSON:
  - objective.title/description from SPEC
  - doneCriteria from SPEC done criteria
  - inputs include spec bundle text
- Start the orchestrated run immediately.

## Rules
- No user editing step.
- If OrchestrationPackage validation fails, fall back to a minimal valid package and attach the spec as inputs.
- Always log what was inferred vs explicit.
