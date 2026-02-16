---
name: artifact-packaging
description: Package artifacts into a clean deliverable set with changelog and navigation for UI display.
license: MIT
compatibility: opencode
---

## Purpose
Turn many outputs into a coherent deliverables bundle.

## Contract
Input:
- artifacts (docs, files, decisions)
- audience (internal/external)
- format (markdown, json, tables)

Output:
- deliverables index
- concise changelog
- how to use section

## Rules
- Provide a single entrypoint doc first.
- Keep summaries short; point to full artifacts.
- Include known limitations and follow-ups.
