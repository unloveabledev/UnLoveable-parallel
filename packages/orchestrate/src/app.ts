import express, { type Express, type Request, type Response } from 'express'
import type { OpenCodeAdapter } from './opencode-adapter.js'
import { DeterministicMockOpenCodeAdapter } from './opencode-adapter.js'
import { createDb, type OrchestrateDb } from './db.js'
import { RunEngine } from './engine.js'
import { Repository } from './repository.js'
import { SseHub } from './sse.js'
import { validatePackage } from './validation.js'
import { generateSpecBundle } from './spec.js'
import { PreviewManager } from './preview.js'

export interface BuildAppOptions {
  databasePath?: string
  adapter?: OpenCodeAdapter
}

export interface BuildAppResult {
  app: Express
  repository: Repository
  engine: RunEngine
  sseHub: SseHub
  previewManager: PreviewManager
  db: OrchestrateDb
}

export function buildApp(options: BuildAppOptions = {}): BuildAppResult {
  const app = express()
  app.use(express.json({ limit: '10mb' }))

  const databasePath = options.databasePath ?? ':memory:'
  const db = createDb(databasePath)
  const repository = new Repository(db)
  const sseHub = new SseHub()
  const adapter = options.adapter ?? new DeterministicMockOpenCodeAdapter()
  const previewManager = new PreviewManager({
    onEvent(type, data) {
      const runId = typeof data.runId === 'string' ? data.runId : null
      if (!runId) {
        return
      }
      const event = repository.appendEvent(runId, type, data)
      sseHub.publish(event)
    },
  })

  const engine = new RunEngine(repository, sseHub, adapter, previewManager)

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true })
  })

  app.post('/spec', async (req: Request, res: Response) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
    if (!prompt) {
      res.status(400).json({
        error: {
          code: 'invalid_request',
          message: 'Missing prompt',
        },
      })
      return
    }

    const model = typeof req.body?.model === 'string' && req.body.model.trim().length > 0
      ? req.body.model.trim()
      : 'opencode/big-pickle'

    const spec = await generateSpecBundle({ adapter, prompt, model })
    res.status(200).json(spec)
  })

  app.post('/runs', (req: Request, res: Response) => {
    const validation = validatePackage(req.body)
    if (!validation.ok || !validation.value) {
      res.status(400).json({
        error: {
          code: 'invalid_package',
          message: 'OrchestrationPackage validation failed',
          details: validation.errors,
        },
      })
      return
    }

    const run = repository.createRun(validation.value)
    const event = repository.appendEvent(run.id, 'run.created', {
      runId: run.id,
      status: run.status,
      createdAt: run.createdAt,
    })
    sseHub.publish(event)

    engine.schedule(run.id)
    res.status(201).json(serializeRun(repository.getRunOrThrow(run.id)))
  })

  // Preview status (JSON)
  app.get('/runs/:id/preview', (req: Request, res: Response) => {
    const runId = String(req.params.id)
    const run = repository.getRun(runId)
    if (!run) {
      res.status(404).json({
        error: {
          code: 'not_found',
          message: 'Run not found',
        },
      })
      return
    }

    res.status(200).json(previewManager.get(runId))
  })

  app.post('/runs/:id/preview/start', async (req: Request, res: Response) => {
    const runId = String(req.params.id)
    const run = repository.getRun(runId)
    if (!run) {
      res.status(404).json({
        error: {
          code: 'not_found',
          message: 'Run not found',
        },
      })
      return
    }

    const preview = run.orchestrationPackage.preview
    if (!preview || preview.enabled !== true) {
      res.status(409).json({
        error: {
          code: 'preview_disabled',
          message: 'Preview is not enabled for this run',
        },
      })
      return
    }

    const status = await previewManager.start(runId, {
      command: typeof preview.command === 'string' && preview.command.trim().length > 0 ? preview.command.trim() : 'bun',
      args: Array.isArray(preview.args) && preview.args.length > 0 ? preview.args : ['run', 'dev', '--', '--port', '{PORT}', '--host', '127.0.0.1'],
      cwd: typeof preview.cwd === 'string' && preview.cwd.trim().length > 0 ? preview.cwd.trim() : process.cwd(),
      readyPath: typeof preview.readyPath === 'string' && preview.readyPath.trim().length > 0 ? preview.readyPath.trim() : '/',
      autoStopOnTerminal: preview.autoStopOnTerminal !== false,
    })

    res.status(200).json(status)
  })

  app.post('/runs/:id/preview/stop', async (req: Request, res: Response) => {
    const runId = String(req.params.id)
    const run = repository.getRun(runId)
    if (!run) {
      res.status(404).json({
        error: {
          code: 'not_found',
          message: 'Run not found',
        },
      })
      return
    }

    const status = await previewManager.stop(runId)
    res.status(200).json(status)
  })

  // Reverse proxy to the preview process for this run.
  // NOTE: stable iframe target is `/runs/:id/preview/` (trailing slash).
  app.all('/runs/:id/preview/', async (req: Request, res: Response) => {
    const runId = String(req.params.id)
    if (!repository.getRun(runId)) {
      res.status(404).json({
        error: { code: 'not_found', message: 'Run not found' },
      })
      return
    }
    await previewManager.proxyToRun(runId, req, res, '/')
  })

  app.all('/runs/:id/preview/*rest', async (req: Request, res: Response) => {
    const runId = String(req.params.id)
    if (!repository.getRun(runId)) {
      res.status(404).json({
        error: { code: 'not_found', message: 'Run not found' },
      })
      return
    }

    const subPath = typeof (req.params as unknown as { rest?: unknown }).rest === 'string'
      ? String((req.params as unknown as { rest: string }).rest)
      : ''
    await previewManager.proxyToRun(runId, req, res, `/${subPath}`)
  })

  app.get('/runs/:id', (req: Request, res: Response) => {
    const runId = String(req.params.id)
    const run = repository.getRun(runId)
    if (!run) {
      res.status(404).json({
        error: {
          code: 'not_found',
          message: 'Run not found',
        },
      })
      return
    }

    const counters = repository.getRunCounters(run.id)
    const tasks = repository.listTasks(run.id)
    const artifacts = repository.listArtifacts(run.id)
    const evidence = repository.listEvidence(run.id)
    const results = repository.listResults(run.id, 200)
    res.status(200).json({
      ...serializeRun(run),
      summary: {
        objective: run.orchestrationPackage.objective.title,
        reason: run.reason,
      },
      counters: {
        orchestratorIterations: counters.orchestratorIterations,
        workersSpawned: counters.workersSpawned,
        workerFailures: counters.workerFailures,
        evidenceItems: counters.evidenceItems,
      },
      tasks,
      results,
      evidence,
      artifacts,
      latestEventId: String(counters.latestEventId),
    })
  })

  app.post('/runs/:id/cancel', async (req: Request, res: Response) => {
    const runId = String(req.params.id)
    const run = repository.getRun(runId)
    if (!run) {
      res.status(404).json({
        error: {
          code: 'not_found',
          message: 'Run not found',
        },
      })
      return
    }

    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'canceled' || run.status === 'timed_out') {
      res.status(409).json({
        error: {
          code: 'already_terminal',
          message: 'Run is already in terminal state',
        },
      })
      return
    }

    const updated = repository.requestCancel(run.id)
    const cancelRequestedEvent = repository.appendEvent(run.id, 'run.cancel.requested', {
      runId: run.id,
      status: updated.status,
    })
    sseHub.publish(cancelRequestedEvent)

    // Best-effort: stop any live preview immediately on cancel request.
    try {
      await previewManager.stop(run.id)
    } catch {
      // ignore
    }

    if (updated.status === 'queued') {
      const canceledRun = repository.updateRunStatus(run.id, 'canceled', 'canceled_by_user')
      const event = repository.appendEvent(run.id, 'run.canceled', {
        runId: run.id,
      })
      sseHub.publish(event)
      res.status(202).json(serializeRun(canceledRun))
      return
    }

    if (updated.sessionId) {
      await adapter.cancelSession(updated.sessionId)
    }

    res.status(202).json(serializeRun(updated))
  })

  app.get('/runs/:id/events', (req: Request, res: Response) => {
    const runId = String(req.params.id)
    const run = repository.getRun(runId)
    if (!run) {
      res.status(404).json({
        error: {
          code: 'not_found',
          message: 'Run not found',
        },
      })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })

    const rawLastEventId = req.header('Last-Event-ID')
    const parsed = Number(rawLastEventId)
    const lastEventId = Number.isFinite(parsed) ? parsed : 0
    const historicalEvents = repository.listRunEvents(run.id, lastEventId)
    for (const event of historicalEvents) {
      res.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
    }

    const unsubscribe = sseHub.subscribe(run.id, res)
    const heartbeat = setInterval(() => {
      sseHub.publishPing(run.id)
    }, 15000)

    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      res.end()
    })
  })

  return { app, repository, engine, sseHub, previewManager, db }
}

function serializeRun(run: ReturnType<Repository['getRunOrThrow']>) {
  const pkg = run.orchestrationPackage
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    reason: run.reason,
    limits: {
      maxIterations: pkg.runPolicy.limits.maxOrchestratorIterations,
      maxWallClockMs: pkg.runPolicy.limits.maxRunWallClockMs,
      maxRetries: pkg.runPolicy.retries.maxWorkerTaskRetries,
      maxWorkers: pkg.runPolicy.concurrency.maxWorkers,
      budget: pkg.runPolicy.budget,
    },
  }
}
