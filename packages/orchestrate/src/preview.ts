import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { Readable } from 'node:stream'
import type { Request, Response } from 'express'

export type PreviewState = 'stopped' | 'starting' | 'ready' | 'error'

export type PreviewStatus = {
  state: PreviewState
  runId: string
  url: string | null
  port: number | null
  proxiedPath: string
  startedAt: string | null
  stoppedAt: string | null
  error: string | null
  logsTail: string[]
}

export type PreviewConfig = {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  readyPath?: string
  autoStopOnTerminal?: boolean
}

type PreviewEntry = {
  runId: string
  state: PreviewState
  port: number | null
  proxiedPath: string
  startedAt: string | null
  stoppedAt: string | null
  error: string | null
  url: string | null
  child: ChildProcessWithoutNullStreams | null
  logs: string[]
  lastLogAt: string | null
}

type PreviewManagerOptions = {
  logsMaxLines?: number
  connectTimeoutMs?: number
  readyTimeoutMs?: number
  pollIntervalMs?: number
  onEvent?: (type: string, data: Record<string, unknown>) => void
}

const DEFAULT_LOG_LINES = 200
const DEFAULT_CONNECT_TIMEOUT_MS = 2500
const DEFAULT_READY_TIMEOUT_MS = 45000
const DEFAULT_POLL_INTERVAL_MS = 500

export class PreviewManager {
  private readonly previews = new Map<string, PreviewEntry>()
  private readonly logsMaxLines: number
  private readonly connectTimeoutMs: number
  private readonly readyTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly onEvent?: (type: string, data: Record<string, unknown>) => void

  constructor(options: PreviewManagerOptions = {}) {
    this.logsMaxLines = Math.max(50, options.logsMaxLines ?? DEFAULT_LOG_LINES)
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.onEvent = options.onEvent
  }

  get(runId: string): PreviewStatus {
    const entry = this.previews.get(runId) ?? this.createStopped(runId)
    return this.toStatus(entry)
  }

  async start(runId: string, config: PreviewConfig): Promise<PreviewStatus> {
    const existing = this.previews.get(runId)
    if (existing && (existing.state === 'starting' || existing.state === 'ready')) {
      return this.toStatus(existing)
    }

    const port = await allocatePort()
    const proxiedPath = `/runs/${encodeURIComponent(runId)}/preview/`
    const startedAt = new Date().toISOString()

    const entry: PreviewEntry = {
      runId,
      state: 'starting',
      port,
      proxiedPath,
      startedAt,
      stoppedAt: null,
      error: null,
      url: proxiedPath,
      child: null,
      logs: [],
      lastLogAt: null,
    }
    this.previews.set(runId, entry)

    this.emit('preview.starting', {
      runId,
      port,
      proxiedPath,
      externalUrl: proxiedPath,
    })

    const resolvedArgs = config.args.map((arg) =>
      arg
        .replaceAll('{PORT}', String(port))
        .replaceAll('{RUN_ID}', runId),
    )

    const env: Record<string, string> = {
      ...process.env,
      ...(config.env ?? {}),
      PORT: String(port),
      HOST: '127.0.0.1',
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(config.command, resolvedArgs, {
        cwd: config.cwd,
        env,
        stdio: 'pipe',
      })
    } catch (error) {
      entry.state = 'error'
      entry.error = error instanceof Error ? error.message : 'failed to spawn preview'
      entry.stoppedAt = new Date().toISOString()
      this.emit('preview.error', { runId, port, proxiedPath, error: entry.error })
      return this.toStatus(entry)
    }

    entry.child = child
    this.captureLogs(entry, child)

    child.once('exit', (code, signal) => {
      const current = this.previews.get(runId)
      if (!current) return
      if (current.state === 'stopped') return
      current.state = current.state === 'ready' ? 'stopped' : 'error'
      current.stoppedAt = new Date().toISOString()
      if (current.state === 'error') {
        current.error = `preview exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`
        this.emit('preview.error', { runId, port: current.port, proxiedPath: current.proxiedPath, error: current.error })
      } else {
        this.emit('preview.stopped', { runId, port: current.port, proxiedPath: current.proxiedPath })
      }
    })

    try {
      const readyPath = (config.readyPath ?? '/').startsWith('/') ? (config.readyPath ?? '/') : `/${config.readyPath}`
      await waitForHttpReady({
        port,
        path: readyPath,
        timeoutMs: this.readyTimeoutMs,
        pollIntervalMs: this.pollIntervalMs,
        connectTimeoutMs: this.connectTimeoutMs,
      })

      entry.state = 'ready'
      entry.error = null
      this.emit('preview.ready', {
        runId,
        port,
        proxiedPath,
        externalUrl: proxiedPath,
      })
    } catch (error) {
      entry.state = 'error'
      entry.error = error instanceof Error ? error.message : 'preview readiness failed'
      this.emit('preview.error', { runId, port, proxiedPath, error: entry.error })
    }

    return this.toStatus(entry)
  }

  async stop(runId: string): Promise<PreviewStatus> {
    const entry = this.previews.get(runId)
    if (!entry) {
      return this.get(runId)
    }

    if (entry.state === 'stopped') {
      return this.toStatus(entry)
    }

    entry.state = 'stopped'
    entry.stoppedAt = new Date().toISOString()

    const child = entry.child
    entry.child = null
    if (child) {
      await terminateChild(child)
    }

    this.emit('preview.stopped', { runId, port: entry.port, proxiedPath: entry.proxiedPath })
    return this.toStatus(entry)
  }

  isAllowed(runId: string): boolean {
    const entry = this.previews.get(runId)
    return Boolean(entry && entry.port && (entry.state === 'starting' || entry.state === 'ready'))
  }

  getTarget(runId: string): { port: number; baseUrl: string } | null {
    const entry = this.previews.get(runId)
    if (!entry || !entry.port) {
      return null
    }
    return {
      port: entry.port,
      baseUrl: `http://127.0.0.1:${entry.port}`,
    }
  }

  async proxyToRun(runId: string, req: Request, res: Response, proxiedPath: string): Promise<void> {
    const target = this.getTarget(runId)
    if (!target) {
      res.status(404).json({
        error: {
          code: 'preview_not_running',
          message: 'Preview is not running',
        },
      })
      return
    }

    const url = new URL(proxiedPath, target.baseUrl)
    // Preserve query string.
    if (typeof req.originalUrl === 'string' && req.originalUrl.includes('?')) {
      const query = req.originalUrl.split('?')[1]
      if (query) {
        url.search = query
      }
    }

    const method = String(req.method || 'GET').toUpperCase()
    const hasBody = method !== 'GET' && method !== 'HEAD'
    if (hasBody) {
      res.status(405).json({
        error: {
          code: 'method_not_allowed',
          message: 'Preview proxy only supports GET/HEAD in MVP',
        },
      })
      return
    }

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      if (typeof value !== 'string') continue
      const lower = key.toLowerCase()
      if (lower === 'host' || lower === 'connection' || lower === 'transfer-encoding') continue
      headers[key] = value
    }

    const upstream = await fetch(url, {
      method,
      headers,
      redirect: 'manual',
    })

    res.status(upstream.status)
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (lower === 'connection' || lower === 'transfer-encoding') {
        return
      }
      res.setHeader(key, value)
    })

    if (!upstream.body) {
      res.end()
      return
    }

    const nodeStream = Readable.fromWeb(upstream.body as unknown as ReadableStream<Uint8Array>)
    nodeStream.pipe(res)
  }

  private captureLogs(entry: PreviewEntry, child: ChildProcessWithoutNullStreams): void {
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf-8').replace(/\r\n/g, '\n')
      for (const line of text.split('\n')) {
        if (!line) continue
        entry.logs.push(line)
        entry.lastLogAt = new Date().toISOString()
        if (entry.logs.length > this.logsMaxLines) {
          entry.logs.splice(0, entry.logs.length - this.logsMaxLines)
        }
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.onEvent?.(type, data)
  }

  private createStopped(runId: string): PreviewEntry {
    return {
      runId,
      state: 'stopped',
      port: null,
      proxiedPath: `/runs/${encodeURIComponent(runId)}/preview/`,
      startedAt: null,
      stoppedAt: null,
      error: null,
      url: null,
      child: null,
      logs: [],
      lastLogAt: null,
    }
  }

  private toStatus(entry: PreviewEntry): PreviewStatus {
    return {
      state: entry.state,
      runId: entry.runId,
      url: entry.url,
      port: entry.port,
      proxiedPath: entry.proxiedPath,
      startedAt: entry.startedAt,
      stoppedAt: entry.stoppedAt,
      error: entry.error,
      logsTail: entry.logs.slice(-50),
    }
  }
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address !== 'object') {
          reject(new Error('Failed to allocate port'))
          return
        }
        resolve(address.port)
      })
    })
  })
}

async function waitForHttpReady(input: {
  port: number
  path: string
  timeoutMs: number
  pollIntervalMs: number
  connectTimeoutMs: number
}): Promise<void> {
  const start = Date.now()
  const url = `http://127.0.0.1:${input.port}${input.path}`

  while (Date.now() - start < input.timeoutMs) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), input.connectTimeoutMs)
      const res = await fetch(url, { method: 'GET', signal: controller.signal })
      clearTimeout(timer)
      if (res.status >= 200 && res.status < 500) {
        return
      }
    } catch {
      // ignore
    }

    await new Promise((r) => setTimeout(r, input.pollIntervalMs))
  }

  throw new Error(`Preview did not become ready within ${input.timeoutMs}ms`)
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed) {
    return
  }

  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }

  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })

  if (exited) {
    return
  }

  try {
    child.kill('SIGKILL')
  } catch {
    // ignore
  }
}
