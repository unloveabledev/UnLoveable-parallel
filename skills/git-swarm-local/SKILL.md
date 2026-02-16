---
name: git-swarm-local
description: Use per-agent worktrees/branches and deterministic merge queue locally (no push/PR).
license: MIT
compatibility: opencode
---

## Purpose
Parallel work with deterministic integration, without touching remote repos.

## Behavior
- Each worker works in its own branch/worktree.
- Workers commit locally with a configured identity.
- Orchestrator merges into an integration branch in a fixed queue order.
- Conflicts emit conflict events + produce a conflict file list.

## Rules
- Never push to remote.
- Never rewrite public history.
- If conflict: stop queue, surface conflict details, optionally spawn resolver.
