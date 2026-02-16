---
name: evidence-contracts
description: Define evidence requirements per task type and map them to artifacts and validation steps.
license: MIT
compatibility: opencode
---

## Purpose
Prevent "looks done" outcomes by defining proof upfront.

## Contract
Input:
- task objective
- task type (software, research, ops, creative, compliance)
- constraints (time/tools)

Output:
- evidence_requirements[]: type, description, how-to-collect, failure modes

## Evidence types (suggested)
- diff: code or doc changes (or versioned edits)
- test_result: unit/integration checks or validation steps
- log_excerpt: command output, run logs, execution traces
- citation: quoted source + link + retrieval date
- rubric_score: scoring table + thresholds
- checklist: completed checklist with exceptions noted
- decision_record: assumptions, alternatives, rationale

## Rules
- Evidence must be feasible to produce.
- Require at least 1 independent validation signal.
- If evidence cannot be produced, explicitly downgrade confidence.
