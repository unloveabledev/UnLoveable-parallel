# Orchestrate

Deterministic Node.js (Express) orchestration control-plane for OpenCode headless sessions.

## Goals
- Validate one immutable `OrchestrationPackage` per run.
- Persist run/task/result/evidence/artifact/event data.
- Enforce Ralph loop (`Plan -> Act -> Check -> Fix -> Report`) for orchestrator and workers.
- Enforce limits: iterations, retries, timeout, budget, concurrency.
- Stream run events via SSE (`GET /runs/:id/events`).
- Gate completion on evidence quality and required evidence types.

## Non-goals
- Websockets.
- Multi-session fan-out per run in MVP.
- Agent-driven policy changes.

## Glossary
- OpenChamber: UI package producer.
- OrchestrationPackage: immutable run input.
- Orchestrate: control-plane API and engine.
- OpenCode: runtime executing orchestrator and worker agents.
