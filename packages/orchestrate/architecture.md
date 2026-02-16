# Architecture

## Components
- OpenChamber submits `POST /runs`, consumes SSE.
- Orchestrate API validates schema and creates run records.
- Run engine enforces deterministic loop and policy guards.
- OpenCode adapter manages a single headless session per run.
- SQLite stores canonical state and append-only events.
- SSE hub fans out persisted events and replay (`Last-Event-ID`).

## Run sequence
1. Validate and persist run (`queued`) + `run.created`.
2. Move to `running`, create one OpenCode session.
3. Execute orchestrator loop stages in order.
4. During orchestrator `act`, dispatch workers up to concurrency limit.
5. Execute worker loop stages in order with retries and evidence gate.
6. Aggregate worker results and run orchestrator `check`.
7. If checks fail, run orchestrator `fix`; otherwise run `report`.
8. Transition run to terminal state and emit final event.
