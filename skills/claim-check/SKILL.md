---
name: claim-check
description: Validate claims against citations and identify unsupported or overstated assertions.
license: MIT
compatibility: opencode
---

## Output
- supported / unsupported / ambiguous claims
- suggested rewrites
- missing evidence list

## Rules
- If no citation supports a key claim, mark unsupported.
- Prefer conservative phrasing when evidence is weak.
