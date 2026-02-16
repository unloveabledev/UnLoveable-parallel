---
name: source-gather-cite
description: Gather sources in parallel, extract relevant quotes, and produce citations with quality notes.
license: MIT
compatibility: opencode
---

## Output
- claims[] each with:
  - statement
  - quote (verbatim)
  - source url
  - date accessed
  - quality notes and caveats

## Rules
- Separate primary vs secondary sources.
- Prefer multiple independent sources for key claims.
- Flag uncertainty explicitly.
