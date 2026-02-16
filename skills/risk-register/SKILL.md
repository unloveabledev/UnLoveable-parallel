---
name: risk-register
description: Build a risk register with severity/likelihood, mitigations, and monitoring signals.
license: MIT
compatibility: opencode
---

## Output
- risks[] with:
  - description
  - severity/likelihood
  - mitigation
  - monitoring signal
  - owner

## Rules
- Include execution risks and correctness risks.
- Add explicit assumptions that could break.
