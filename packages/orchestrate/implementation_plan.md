# Implementation Plan

1. Scaffold Express TypeScript package.
2. Add schema validation (Ajv/Zod).
3. Add SQLite persistence and append-only event log.
4. Add SSE endpoint with replay and heartbeat.
5. Build deterministic orchestrator/worker loop engine.
6. Add evidence gate, retries, timeout, cancellation, budget checks.
7. Add OpenCode adapter interface and mock adapter.
8. Add integration tests for acceptance scenarios.
