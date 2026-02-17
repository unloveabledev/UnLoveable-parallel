import fs from 'node:fs'
import path from 'node:path'
import type { AgentResult, AgentTask, LoopStage, OrchestratorOutput, RunRecord } from './types.js'
import type { OpenCodeAdapter } from './opencode-adapter.js'

type OpenCodeMessagePart = {
  type: string
  text?: string
}

type OpenCodeMessageInfo = {
  id?: string
  role?: string
  finish?: string
}

type OpenCodeMessage = {
  info?: OpenCodeMessageInfo
  parts?: OpenCodeMessagePart[]
}

export type OpenCodeHttpAdapterOptions = {
  baseUrl: string
  serverPassword?: string | null
  directory?: string | null
}

export class OpenCodeHttpAdapter implements OpenCodeAdapter {
  kind = 'opencode' as const

  private readonly baseUrl: string
  private readonly authHeader: Record<string, string>
  private readonly defaultDirectory: string | null

  constructor(options: OpenCodeHttpAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.defaultDirectory = options.directory ? options.directory.trim() : null

    const pwd = options.serverPassword ? options.serverPassword.trim() : ''
    if (pwd) {
      const credentials = Buffer.from(`opencode:${pwd}`).toString('base64')
      this.authHeader = { Authorization: `Basic ${credentials}` }
    } else {
      this.authHeader = {}
    }
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    options: { label: string; maxAttempts: number; maxWaitMs: number },
  ): Promise<Response> {
    const start = Date.now()
    let lastError: unknown = null

    for (let attempt = 1; attempt <= Math.max(1, options.maxAttempts); attempt += 1) {
      try {
        const res = await fetch(url, init)

        const shouldRetryStatus = res.status === 502 || res.status === 503 || res.status === 504
        const shouldRetry404 = options.label === 'createSession' && res.status === 404
        if (!shouldRetryStatus && !shouldRetry404) {
          return res
        }

        lastError = new Error(`HTTP ${res.status}`)
        try {
          res.body?.cancel()
        } catch {
          // ignore
        }
      } catch (error) {
        lastError = error
      }

      const elapsed = Date.now() - start
      if (elapsed >= options.maxWaitMs) {
        break
      }
      const backoff = Math.min(2000, 250 * attempt)
      const jitter = Math.floor(Math.random() * 100)
      await sleep(Math.min(backoff + jitter, Math.max(0, options.maxWaitMs - elapsed)))
    }

    throw new Error(
      `OpenCode ${options.label} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')}`,
    )
  }

  async createSession(run: RunRecord): Promise<{ sessionId: string }> {
    const url = new URL(`${this.baseUrl}/session`)
    const directory = resolveDirectoryForRun(run) || this.defaultDirectory
    if (directory) {
      url.searchParams.set('directory', directory)
    }

    const response = await this.fetchWithRetry(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'content-type': 'application/json',
        ...this.authHeader,
      },
      body: JSON.stringify({ title: run.orchestrationPackage.objective.title }),
    }, { label: 'createSession', maxAttempts: 10, maxWaitMs: 20_000 })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`OpenCode createSession failed (${response.status}): ${text}`)
    }

    const json = (await response.json().catch(() => null)) as null | { id?: unknown; sessionID?: unknown; sessionId?: unknown }
    const sessionId =
      (typeof json?.id === 'string' && json.id) ||
      (typeof json?.sessionID === 'string' && json.sessionID) ||
      (typeof json?.sessionId === 'string' && json.sessionId) ||
      null
    if (!sessionId) {
      throw new Error('OpenCode createSession: missing session id in response')
    }
    return { sessionId }
  }

  async cancelSession(sessionId: string): Promise<void> {
    const url = new URL(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/abort`)
    if (this.defaultDirectory) {
      url.searchParams.set('directory', this.defaultDirectory)
    }
    await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...this.authHeader,
      },
    }).catch(() => null)
  }

  async runOrchestratorStage(input: {
    run: RunRecord
    stage: LoopStage
    iteration: number
    workerResults: AgentResult[]
  }): Promise<OrchestratorOutput> {
    const model = parseModelRef(input.run.orchestrationPackage.agents.orchestrator.model)
    const directory = resolveDirectoryForRun(input.run)
    const system = readPromptIfExists('orchestrator')
    const prompt = buildOrchestratorPrompt({
      system,
      run: input.run,
      stage: input.stage,
      iteration: input.iteration,
      workerResults: input.workerResults,
    })

    const json = await this.sendPromptAndWaitForJson({
      sessionId: input.run.sessionId,
      directory,
      model,
      agentName: 'build',
      text: prompt,
      timeoutMs: input.run.orchestrationPackage.runPolicy.timeouts.orchestratorStepMs,
    })

    return json as OrchestratorOutput
  }

  async runWorkerStage(input: {
    run: RunRecord
    task: AgentTask
    stage: LoopStage
    iteration: number
    attempt: number
  }): Promise<AgentResult> {
    const model = parseModelRef(input.run.orchestrationPackage.agents.worker.model)
    const system = readPromptIfExists('worker')

    // Prefer running workers in their worktree when git swarm is enabled.
    const directory = resolveWorkerDirectory(input.run, input.task.taskId)

    const prompt = buildWorkerPrompt({
      system,
      run: input.run,
      task: input.task,
      stage: input.stage,
      iteration: input.iteration,
      attempt: input.attempt,
    })

    const json = await this.sendPromptAndWaitForJson({
      sessionId: input.run.sessionId,
      directory,
      model,
      agentName: 'build',
      text: prompt,
      timeoutMs: input.run.orchestrationPackage.runPolicy.timeouts.workerTaskMs,
    })

    return json as AgentResult
  }

  private async sendPromptAndWaitForJson(input: {
    sessionId: string | null
    directory: string | null
    model: { providerID: string; modelID: string }
    agentName: string
    text: string
    timeoutMs: number
  }): Promise<unknown> {
    const sessionId = input.sessionId
    if (!sessionId) {
      throw new Error('OpenCode adapter missing sessionId on run')
    }

    const baseline = await this.fetchMessages(sessionId, input.directory, 50)
    const baselineIds = new Set(baseline.map((m) => String(m.info?.id ?? '')).filter(Boolean))

    await this.postPromptAsync({
      sessionId,
      directory: input.directory,
      model: input.model,
      agent: input.agentName,
      parts: [{ type: 'text', text: input.text }],
    })

    const deadline = Date.now() + Math.max(2000, input.timeoutMs)
    while (Date.now() < deadline) {
      const messages = await this.fetchMessages(sessionId, input.directory, 50)
      const candidate = findLatestAssistantCompletion(messages, baselineIds)
      if (candidate) {
        const text = extractText(candidate)
        const parsed = parseJsonLoose(text)
        return parsed
      }
      await sleep(300)
    }

    throw new Error(`OpenCode response timed out after ${input.timeoutMs}ms`)
  }

  private async fetchMessages(sessionId: string, directory: string | null, limit: number): Promise<OpenCodeMessage[]> {
    const url = new URL(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/message`)
    if (directory) {
      url.searchParams.set('directory', directory)
    }
    url.searchParams.set('limit', String(limit))

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...this.authHeader,
      },
    })

    if (!response.ok) {
      return []
    }
    const json = (await response.json().catch(() => null)) as unknown
    if (!Array.isArray(json)) {
      return []
    }
    return json as OpenCodeMessage[]
  }

  async sendPromptAndWaitForText(input: {
    sessionId: string
    directory: string | null
    model: { providerID: string; modelID: string }
    agentName: string
    text: string
    timeoutMs: number
  }): Promise<string> {
    const baseline = await this.fetchMessages(input.sessionId, input.directory, 50)
    const baselineIds = new Set(baseline.map((m) => String(m.info?.id ?? '')).filter(Boolean))

    await this.postPromptAsync({
      sessionId: input.sessionId,
      directory: input.directory,
      model: input.model,
      agent: input.agentName,
      parts: [{ type: 'text', text: input.text }],
    })

    const deadline = Date.now() + Math.max(2000, input.timeoutMs)
    while (Date.now() < deadline) {
      const messages = await this.fetchMessages(input.sessionId, input.directory, 50)
      const candidate = findLatestAssistantCompletion(messages, baselineIds)
      if (candidate) {
        return extractText(candidate)
      }
      await sleep(300)
    }

    throw new Error(`OpenCode response timed out after ${input.timeoutMs}ms`)
  }

  private async postPromptAsync(input: {
    sessionId: string
    directory: string | null
    model: { providerID: string; modelID: string }
    agent: string
    variant?: string
    parts: Array<{ type: string; text?: string }>
  }): Promise<void> {
    const url = new URL(`${this.baseUrl}/session/${encodeURIComponent(input.sessionId)}/prompt_async`)
    if (input.directory) {
      url.searchParams.set('directory', input.directory)
    }

    const response = await this.fetchWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'content-type': 'application/json',
          ...this.authHeader,
        },
        body: JSON.stringify({
          ...(shouldOmitModel(input.model) ? {} : { model: input.model }),
          agent: input.agent,
          ...(input.variant ? { variant: input.variant } : {}),
          parts: input.parts,
        }),
      },
      { label: 'prompt_async', maxAttempts: 6, maxWaitMs: 15_000 },
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`OpenCode prompt_async failed (${response.status}): ${text}`)
    }
  }
}

function shouldOmitModel(model: { providerID: string; modelID: string } | null | undefined): boolean {
  if (!model) return true
  const providerID = typeof model.providerID === 'string' ? model.providerID.trim() : ''
  const modelID = typeof model.modelID === 'string' ? model.modelID.trim() : ''
  // Placeholder model used in OpenChamber when no model is selected.
  if (providerID === 'opencode' && modelID === 'big-pickle') {
    return true
  }
  return providerID.length === 0 || modelID.length === 0
}

function resolveDirectoryForRun(run: RunRecord): string | null {
  const previewCwd = typeof run.orchestrationPackage.preview?.cwd === 'string' ? run.orchestrationPackage.preview.cwd.trim() : ''
  const repoPath = typeof run.orchestrationPackage.git?.repoPath === 'string' ? run.orchestrationPackage.git.repoPath.trim() : ''
  return previewCwd || repoPath || null
}

function resolveWorkerDirectory(run: RunRecord, taskId: string): string | null {
  const git = run.orchestrationPackage.git
  if (git?.enabled !== true) {
    return resolveDirectoryForRun(run)
  }
  const worktreesRoot = typeof git.worktreesRoot === 'string' ? git.worktreesRoot.trim() : ''
  if (!worktreesRoot) {
    return resolveDirectoryForRun(run)
  }
  const agentId = `agent_${taskId}`
  const worktreePath = path.join(worktreesRoot, sanitizePathSegment(agentId))
  return worktreePath
}

function sanitizePathSegment(input: string): string {
  return input.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64) || 'agent'
}

function parseModelRef(model: string): { providerID: string; modelID: string } {
  const raw = typeof model === 'string' ? model.trim() : ''
  const [providerID, modelID] = raw.split('/', 2)
  if (providerID && modelID) {
    return { providerID, modelID }
  }
  return { providerID: 'opencode', modelID: 'big-pickle' }
}

function readPromptIfExists(kind: 'orchestrator' | 'worker'): string {
  const file = kind === 'orchestrator' ? 'orchestrator.system.md' : 'worker.system.md'
  const candidate = new URL(`../prompts/${file}`, import.meta.url)
  try {
    return fs.readFileSync(candidate, 'utf8')
  } catch {
    return ''
  }
}

function buildOrchestratorPrompt(input: {
  system: string
  run: RunRecord
  stage: LoopStage
  iteration: number
  workerResults: AgentResult[]
}): string {
  const objective = input.run.orchestrationPackage.objective
  const inputs = (objective.inputs && typeof objective.inputs === 'object') ? (objective.inputs as Record<string, unknown>) : {}
  const done = objective.doneCriteria.map((c) => `- ${c.description}`).join('\n')
  const workerSummaries = input.workerResults
    .map((r) => `- ${r.taskId} ${r.stage} ${r.status}: ${r.summary}`)
    .join('\n')

  const specMd = typeof inputs.specMd === 'string' ? inputs.specMd : ''
  const uiSpecMd = typeof inputs.uiSpecMd === 'string' ? inputs.uiSpecMd : ''
  const architecturePlanMd = typeof inputs.architecturePlanMd === 'string' ? inputs.architecturePlanMd : ''
  const registryMd = typeof inputs.registryMd === 'string' ? inputs.registryMd : ''
  const implementationPlanMd = typeof inputs.implementationPlanMd === 'string' ? inputs.implementationPlanMd : ''

  const orchestratorValidationErrors = inputs.orchestratorValidationErrors
  const validationText =
    typeof orchestratorValidationErrors === 'string'
      ? orchestratorValidationErrors
      : Array.isArray(orchestratorValidationErrors)
        ? orchestratorValidationErrors.map(String).filter(Boolean).join('\n')
        : ''

  return [
    input.system.trim(),
    '',
    'You are producing STRICT JSON only. No markdown. No commentary.',
    '',
    `Stage: ${input.stage}`,
    `Iteration: ${input.iteration}`,
    '',
    'Objective:',
    objective.title,
    '',
    objective.description,
    '',
    'Done Criteria:',
    done || '- (none provided)',
    '',
    'Worker Results So Far:',
    workerSummaries || '- (none yet)',
    '',
    validationText ? `Validation feedback from last attempt:\n${validationText}` : null,
    '',
    implementationPlanMd
      ? 'Implementation Plan (authoritative task checklist; plan tasks should map to its checklist ids):\n' +
        truncateDoc(implementationPlanMd)
      : null,
    specMd ? 'SPEC.md:\n' + truncateDoc(specMd) : null,
    uiSpecMd ? 'UI_SPEC.md:\n' + truncateDoc(uiSpecMd) : null,
    architecturePlanMd ? 'ARCHITECTURE_PLAN.md:\n' + truncateDoc(architecturePlanMd) : null,
    registryMd ? 'REGISTRY.md:\n' + truncateDoc(registryMd) : null,
    '',
    'Return an OrchestratorOutput JSON object for this stage. Follow the schema used by Orchestrate (agentRole=orchestrator, stage, status, summary, metrics, next, plus the stage-specific fields).',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildWorkerPrompt(input: {
  system: string
  run: RunRecord
  task: AgentTask
  stage: LoopStage
  iteration: number
  attempt: number
}): string {
  const objective = input.run.orchestrationPackage.objective
  const inputs = (objective.inputs && typeof objective.inputs === 'object') ? (objective.inputs as Record<string, unknown>) : {}
  const requiredEvidence = input.task.requiredEvidence.map((e) => `- ${e.type}: ${e.description}`).join('\n')

  const specMd = typeof inputs.specMd === 'string' ? inputs.specMd : ''
  const uiSpecMd = typeof inputs.uiSpecMd === 'string' ? inputs.uiSpecMd : ''
  const architecturePlanMd = typeof inputs.architecturePlanMd === 'string' ? inputs.architecturePlanMd : ''
  const registryMd = typeof inputs.registryMd === 'string' ? inputs.registryMd : ''
  const implementationPlanMd = typeof inputs.implementationPlanMd === 'string' ? inputs.implementationPlanMd : ''
  const taskLine = implementationPlanMd ? extractImplementationTaskLine(implementationPlanMd, input.task.taskId) : null

  return [
    input.system.trim(),
    '',
    'You are producing STRICT JSON only. No markdown. No commentary.',
    '',
    `Stage: ${input.stage}`,
    `Iteration: ${input.iteration}`,
    `Attempt: ${input.attempt}`,
    '',
    'Run objective:',
    objective.title,
    '',
    'Task:',
    `taskId: ${input.task.taskId}`,
    `objective: ${input.task.objective}`,
    '',
    'Required evidence:',
    requiredEvidence || '- (none)',
    '',
    taskLine ? `Implementation plan line for ${input.task.taskId}:\n${taskLine}` : null,
    specMd ? 'SPEC.md (context):\n' + truncateDoc(specMd) : null,
    uiSpecMd ? 'UI_SPEC.md (context):\n' + truncateDoc(uiSpecMd) : null,
    architecturePlanMd ? 'ARCHITECTURE_PLAN.md (context):\n' + truncateDoc(architecturePlanMd) : null,
    registryMd ? 'REGISTRY.md (context):\n' + truncateDoc(registryMd) : null,
    '',
    'You are operating in the repository directory for this task. Make real changes, run real checks, and include real evidence references (diff/test/log excerpts) when applicable.',
    'Return an AgentResult JSON object matching Orchestrate schema.',
  ]
    .filter(Boolean)
    .join('\n')
}

function truncateDoc(doc: string, maxChars = 12_000): string {
  const text = String(doc || '')
  if (text.length <= maxChars) {
    return text
  }
  return text.slice(0, maxChars) + `\n\n[TRUNCATED ${text.length - maxChars} chars]`
}

function extractImplementationTaskLine(planMd: string, taskId: string): string | null {
  const id = String(taskId || '').trim()
  if (!id) {
    return null
  }
  const lines = String(planMd || '').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('-')) continue
    if (!trimmed.includes(id)) continue
    if (!trimmed.includes('[ ]') && !trimmed.includes('[x]')) continue
    return trimmed
  }
  return null
}

function findLatestAssistantCompletion(messages: OpenCodeMessage[], baselineIds: Set<string>): OpenCodeMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    const id = typeof m.info?.id === 'string' ? m.info.id : ''
    if (id && baselineIds.has(id)) {
      continue
    }
    const role = typeof m.info?.role === 'string' ? m.info.role : ''
    const finish = typeof m.info?.finish === 'string' ? m.info.finish : ''
    if (role === 'assistant' && (finish === 'stop' || finish === 'complete' || finish === 'completed')) {
      return m
    }
  }
  return null
}

function extractText(message: OpenCodeMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : []
  const text = parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => String(p.text))
    .join('\n')
  return text
}

function parseJsonLoose(text: string): unknown {
  const trimmed = String(text || '').trim()
  if (!trimmed) {
    throw new Error('OpenCode returned empty response')
  }
  // Best effort: find a JSON object region.
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  const slice = first !== -1 && last !== -1 && last > first ? trimmed.slice(first, last + 1) : trimmed
  try {
    return JSON.parse(slice)
  } catch {
    throw new Error(`OpenCode returned non-JSON: ${trimmed.slice(0, 200)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
