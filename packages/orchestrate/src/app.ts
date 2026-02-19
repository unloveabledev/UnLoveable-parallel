import express, { type Express, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { OpenCodeAdapter } from './opencode-adapter.js'
import { DeterministicMockOpenCodeAdapter } from './opencode-adapter.js'
import { OpenCodeHttpAdapter } from './opencode-http-adapter.js'
import { createDb, type OrchestrateDb } from './db.js'
import { RunEngine } from './engine.js'
import { Repository } from './repository.js'
import { SseHub } from './sse.js'
import { validatePackage } from './validation.js'
import { generateSpecBundle } from './spec.js'
import { PreviewManager } from './preview.js'
import { generateFollowups } from './followup.js'
import { assistDocs } from './doc-assist.js'
import type { RunRecord } from './types.js'

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
  const adapter = options.adapter ?? createDefaultAdapter()
  const allowMockRuns = process.env.ORCHESTRATE_ALLOW_MOCK === 'true'
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
    res.status(200).json({ ok: true, adapter: adapter.kind, allowMockRuns })
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

    const answers = req.body?.answers && typeof req.body.answers === 'object' ? (req.body.answers as Record<string, string>) : undefined
    const context = req.body?.context && typeof req.body.context === 'object' ? (req.body.context as Record<string, unknown>) : undefined

    try {
      const spec = await generateSpecBundle({ adapter, prompt, model, answers, context })
      res.status(200).json(spec)
    } catch (error) {
      res.status(500).json({
        error: {
          code: 'spec_generation_failed',
          message: error instanceof Error ? error.message : 'Spec generation failed',
        },
      })
    }
  })

  app.post('/spec/stream', async (req: Request, res: Response) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
    if (!prompt) {
      res.status(400).json({ error: { code: 'invalid_request', message: 'Missing prompt' } })
      return
    }

    const model = typeof req.body?.model === 'string' && req.body.model.trim().length > 0
      ? req.body.model.trim()
      : 'opencode/big-pickle'

    const answers = req.body?.answers && typeof req.body.answers === 'object' ? (req.body.answers as Record<string, string>) : undefined
    const context = req.body?.context && typeof req.body.context === 'object' ? (req.body.context as Record<string, unknown>) : undefined

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })

    let eventId = 0
    const sendEvent = (event: string, data: unknown) => {
      eventId += 1
      try {
        res.write(`id: ${eventId}\n`)
        res.write(`event: ${event}\n`)
        res.write(`data: ${JSON.stringify(data)}\n\n`)
      } catch {
        // ignore
      }
    }

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        // ignore
      }
    }, 15000)

    res.on('close', () => {
      clearInterval(heartbeat)
    })

    try {
      sendEvent('spec.progress', { phase: 'start', message: 'Starting…', percent: 0 })
      const spec = await generateSpecBundle({
        adapter,
        prompt,
        model,
        answers,
        context,
        onProgress: (evt) => sendEvent('spec.progress', evt),
      })
      sendEvent('spec.result', spec)
    } catch (error) {
      sendEvent('spec.error', {
        code: 'spec_generation_failed',
        message: error instanceof Error ? error.message : 'Spec generation failed',
      })
    } finally {
      clearInterval(heartbeat)
      try {
        res.end()
      } catch {
        // ignore
      }
    }
  })

  app.post('/followup', async (req: Request, res: Response) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
    if (!prompt) {
      res.status(400).json({ error: { code: 'invalid_request', message: 'Missing prompt' } })
      return
    }

    const modelRaw = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
    const [providerID, modelID] = modelRaw.includes('/') ? modelRaw.split('/', 2) : ['opencode', 'big-pickle']

    const context = req.body?.context && typeof req.body.context === 'object' ? (req.body.context as Record<string, unknown>) : undefined
    const directory = typeof context?.directory === 'string' ? context.directory.trim() : null

    // Minimal ephemeral run record for question generation.
    const createdAt = new Date().toISOString()
    const followupId = `followup_${randomUUID()}`
    const run: RunRecord = {
      id: followupId,
      status: 'queued',
      reason: null,
      cancelRequested: false,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      sessionId: null,
      budgetTokensUsed: 0,
      budgetCostUsed: 0,
      orchestrationPackage: {
        packageVersion: '0.1.0',
        metadata: { packageId: followupId, createdAt, createdBy: 'openchamber:auto' },
        objective: {
          title: 'Followup',
          description: prompt,
          inputs: {},
          doneCriteria: [{ id: 'done_1', description: 'Questions gathered', requiredEvidenceTypes: ['log_excerpt'] }],
        },
        agents: {
          orchestrator: { name: 'orchestrator', model: modelRaw || 'opencode/big-pickle', systemPromptRef: 'openchamber/orchestrator-system' },
          worker: { name: 'worker', model: modelRaw || 'opencode/big-pickle', systemPromptRef: 'openchamber/worker-system' },
        },
        registries: { skills: [], variables: [] },
        runPolicy: {
          limits: { maxOrchestratorIterations: 1, maxWorkerIterations: 1, maxRunWallClockMs: 60_000 },
          retries: { maxWorkerTaskRetries: 0, maxMalformedOutputRetries: 0 },
          concurrency: { maxWorkers: 1 },
          timeouts: { workerTaskMs: 30_000, orchestratorStepMs: 30_000 },
          budget: { maxTokens: 50_000, maxCostUsd: 2 },
          determinism: { enforceStageOrder: true, requireStrictJson: true, singleSessionPerRun: true },
        },
      },
    }

    try {
      const result = await generateFollowups({
        adapter,
        run,
        model: { providerID, modelID },
        directory,
        prompt,
      })
      res.status(200).json(result)
    } catch (error) {
      res.status(500).json({
        error: {
          code: 'followup_failed',
          message: error instanceof Error ? error.message : 'Followup failed',
        },
      })
    }
  })

  app.post('/doc-assist', async (req: Request, res: Response) => {
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : ''
    if (!instruction) {
      res.status(400).json({ error: { code: 'invalid_request', message: 'Missing instruction' } })
      return
    }

    const docs = req.body?.docs && typeof req.body.docs === 'object' ? (req.body.docs as Record<string, unknown>) : null
    if (!docs) {
      res.status(400).json({ error: { code: 'invalid_request', message: 'Missing docs' } })
      return
    }

    const docStrings = {
      promptMd: typeof docs.promptMd === 'string' ? docs.promptMd : '',
      specMd: typeof docs.specMd === 'string' ? docs.specMd : '',
      uiSpecMd: typeof docs.uiSpecMd === 'string' ? docs.uiSpecMd : '',
      architecturePlanMd: typeof docs.architecturePlanMd === 'string' ? docs.architecturePlanMd : '',
      registryMd: typeof docs.registryMd === 'string' ? docs.registryMd : '',
      implementationPlanMd: typeof docs.implementationPlanMd === 'string' ? docs.implementationPlanMd : '',
    }
    const missing = Object.entries(docStrings)
      .filter(([, v]) => String(v).trim().length === 0)
      .map(([k]) => k)
    if (missing.length > 0) {
      res.status(400).json({
        error: { code: 'invalid_request', message: `Missing docs fields: ${missing.join(', ')}` },
      })
      return
    }

    const modelRaw = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
    const [providerID, modelID] = modelRaw.includes('/') ? modelRaw.split('/', 2) : ['opencode', 'big-pickle']

    const context = req.body?.context && typeof req.body.context === 'object' ? (req.body.context as Record<string, unknown>) : undefined
    const directory = typeof context?.directory === 'string' ? context.directory.trim() : null

    const createdAt = new Date().toISOString()
    const assistId = `doc_assist_${randomUUID()}`
    const run: RunRecord = {
      id: assistId,
      status: 'queued',
      reason: null,
      cancelRequested: false,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      sessionId: null,
      budgetTokensUsed: 0,
      budgetCostUsed: 0,
      orchestrationPackage: {
        packageVersion: '0.1.0',
        metadata: { packageId: assistId, createdAt, createdBy: 'openchamber:auto' },
        objective: {
          title: 'Doc Assist',
          description: instruction,
          inputs: {},
          doneCriteria: [{ id: 'done_1', description: 'Docs updated', requiredEvidenceTypes: ['log_excerpt'] }],
        },
        agents: {
          orchestrator: { name: 'orchestrator', model: modelRaw || 'opencode/big-pickle', systemPromptRef: 'openchamber/orchestrator-system' },
          worker: { name: 'worker', model: modelRaw || 'opencode/big-pickle', systemPromptRef: 'openchamber/worker-system' },
        },
        registries: { skills: [], variables: [] },
        runPolicy: {
          limits: { maxOrchestratorIterations: 1, maxWorkerIterations: 1, maxRunWallClockMs: 120_000 },
          retries: { maxWorkerTaskRetries: 0, maxMalformedOutputRetries: 0 },
          concurrency: { maxWorkers: 1 },
          timeouts: { workerTaskMs: 180_000, orchestratorStepMs: 180_000 },
          budget: { maxTokens: 100_000, maxCostUsd: 5 },
          determinism: { enforceStageOrder: true, requireStrictJson: true, singleSessionPerRun: true },
        },
      },
    }

    try {
      const result = await assistDocs({
        adapter,
        run,
        request: {
          instruction,
          directory,
          model: { providerID, modelID },
          docs: {
            promptMd: docStrings.promptMd,
            specMd: docStrings.specMd,
            uiSpecMd: docStrings.uiSpecMd,
            architecturePlanMd: docStrings.architecturePlanMd,
            registryMd: docStrings.registryMd,
            implementationPlanMd: docStrings.implementationPlanMd,
          },
        },
      })
      res.status(200).json(result)
    } catch (error) {
      res.status(500).json({
        error: {
          code: 'doc_assist_failed',
          message: error instanceof Error ? error.message : 'Doc assist failed',
        },
      })
    }
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

    if (adapter.kind === 'mock' && !allowMockRuns) {
      res.status(409).json({
        error: {
          code: 'mock_adapter_disabled',
          message: 'Orchestrate is running in mock mode; refusing to start runs because it will not touch your repo or run tests. Set ORCHESTRATE_ALLOW_MOCK=true to allow mock runs.',
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

function createDefaultAdapter() {
  const baseUrl = (process.env.OPENCODE_URL || process.env.OPENCHAMBER_OPENCODE_URL || '').trim()
  const password = (process.env.OPENCODE_SERVER_PASSWORD || '').trim()
  const directory = (process.env.OPENCODE_DIRECTORY || '').trim()

  if (baseUrl) {
    return new OpenCodeHttpAdapter({
      baseUrl,
      serverPassword: password || null,
      directory: directory || null,
    })
  }

  return new DeterministicMockOpenCodeAdapter()
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
