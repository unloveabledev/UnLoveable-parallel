# Auto Mode (Orchestrate)

OpenChamber supports two interaction modes:

- Prompt Mode: existing OpenCode chat flow (unchanged)
- Auto Mode: runs an Orchestrate workflow (Simple Auto / Advanced Auto)

Auto Mode is powered by the `@openchamber/orchestrate` server and is accessed via OpenChamber server-side proxy routes under `/api/orchestrate/*`.

## Quick Start

1) Start Orchestrate

```bash
bun run --cwd packages/orchestrate dev
```

By default it listens on `http://localhost:8787`.

2) Configure OpenChamber

In OpenChamber:

- Settings -> OpenChamber -> Orchestrate
- Set `Base URL` to `http://localhost:8787`

3) Run

- In Chat, open the mode menu (sparkle icon)
- Choose `Simple Auto` or `Advanced Auto`
- Use `Start Run` to create a run
- You will be taken to `/runs/:id` run monitor

## Run Monitor

The run monitor (`/runs/:id`) shows:

- Timeline (SSE event stream)
- Swarm (tasks)
- Git Swarm (branches, commits, merges)
- Artifacts + Evidence (from run snapshot)
- Live Preview (proxied via Orchestrate)
- Git lane (diff evidence)

SSE reconnect + replay is supported via `Last-Event-ID`.

## Proxy Endpoints

Browser requests do not talk to Orchestrate directly.

- `POST /api/orchestrate/runs`
- `GET /api/orchestrate/runs/:id`
- `POST /api/orchestrate/runs/:id/cancel`
- `GET /api/orchestrate/runs/:id/events` (SSE)
- `POST /api/orchestrate/spec`
- `GET /api/orchestrate/runs/:id/preview`
- `POST /api/orchestrate/runs/:id/preview/start`
- `POST /api/orchestrate/runs/:id/preview/stop`
- `GET /api/orchestrate/runs/:id/preview/*` (stable iframe target)
- `GET /api/orchestrate/health`

## Live Preview

Orchestrate can manage a per-run preview process and expose it at a stable URL:

- Orchestrate: `/runs/:id/preview/`
- OpenChamber (recommended): `/api/orchestrate/runs/:id/preview/`

Preview is controlled by optional `OrchestrationPackage.preview` fields:

- `preview.enabled` (boolean)
- `preview.cwd` (string)
- `preview.command` (string)
- `preview.args` (string[]) supports placeholders: `{PORT}`, `{RUN_ID}`
- `preview.readyPath` (string)
- `preview.autoStopOnTerminal` (boolean)

MVP limitation: the reverse proxy supports `GET/HEAD` only and does not support WebSocket upgrades (some dev servers may lose HMR in iframe).

## Git Swarm

Runs can emit git swarm events (branches/commits/merges). MVP currently emits deterministic events for visualization when `OrchestrationPackage.git.enabled` is true.

## Notes

- If Orchestrate is not configured, Prompt Mode continues to work normally.
- Auto Mode shows setup guidance and will not start runs until Orchestrate is reachable.
