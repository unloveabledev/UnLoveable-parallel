import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { OpenCodeAdapter } from './opencode-adapter.js'
import type { OrchestrationPackage, RunRecord } from './types.js'

export type SpecGenerateRequest = {
  prompt: string
  model?: string
  mode?: 'simple' | 'advanced'
  answers?: Record<string, string>
  context?: Record<string, unknown>
}

export type SpecQuestion = {
  id: string
  prompt: string
  kind: 'short_text' | 'long_text'
  optional?: boolean
  placeholder?: string
}

export type SpecDocument = {
  path: string
  title: string
  content: string
}

export type SpecGenerateResponse = {
  specId: string
  createdAt: string
  questions?: SpecQuestion[]
  documents: SpecDocument[]
  orchestrationPackage: OrchestrationPackage
}

const phase1Schema = z.object({
  promptMd: z.string().min(1),
  specMd: z.string().min(1),
  uiSpecMd: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  doneCriteria: z.array(z.string().min(1)).min(1),
})

const architectureSchema = z.object({
  architecturePlanMd: z.string().min(1),
})

const registrySchema = z.object({
  registryMd: z.string().min(1),
  registries: z.object({
    variables: z.array(z.record(z.string(), z.unknown())).default([]),
    functions: z.array(z.record(z.string(), z.unknown())).default([]),
  }),
})

const implementationSchema = z.object({
  implementationPlanMd: z.string().min(1),
})

export async function generateSpecBundle(input: {
  adapter: OpenCodeAdapter
  prompt: string
  model: string
  answers?: Record<string, string>
  context?: Record<string, unknown>
  onProgress?: (event: { phase: string; message: string; percent: number }) => void
}): Promise<SpecGenerateResponse> {
  const createdAt = new Date().toISOString()
  const specId = `spec_${randomUUID()}`

  const directory = typeof input.context?.directory === 'string' ? input.context.directory.trim() : ''
  const modelRef = input.model.trim() || 'opencode/big-pickle'
  const modelParsed = parseModelRef(modelRef)

  const mergedPrompt = mergePromptWithAnswers(input.prompt, input.answers ?? {})

  // Model-generated followups are handled by /followup. /spec should not ask.
  const questions = [] as SpecQuestion[]

  const inferred = inferProjectConfig(directory, specId)

  const run = buildEphemeralRun({ specId, createdAt, model: modelRef, directory, inferred })

  const { sessionId } = await input.adapter.createSession(run)
  const runWithSession: RunRecord = { ...run, sessionId }

  try {
    input.onProgress?.({ phase: 'phase1', message: 'Generating PROMPT.md, SPEC.md, UI_SPEC.md…', percent: 5 })
    const adapterAny = input.adapter as unknown as {
      sendPromptAndWaitForText?: (args: {
        sessionId: string
        directory: string | null
        model: { providerID: string; modelID: string }
        agentName: string
        text: string
        timeoutMs: number
      }) => Promise<string>
    }

    if (!adapterAny.sendPromptAndWaitForText) {
      throw new Error('Adapter does not support text prompting for /spec')
    }

    const promptAdapter = {
      sendPromptAndWaitForText: adapterAny.sendPromptAndWaitForText.bind(input.adapter),
    }

    const phase1 = await promptJson({
      adapter: promptAdapter,
      sessionId,
      directory: directory || null,
      model: modelParsed,
      timeoutMs: 180_000,
      prompt: buildPhase1Prompt(mergedPrompt),
      schema: phase1Schema,
    })

    input.onProgress?.({ phase: 'architecture', message: 'Generating ARCHITECTURE_PLAN.md…', percent: 35 })
    const architecture = await promptJson({
      adapter: promptAdapter,
      sessionId,
      directory: directory || null,
      model: modelParsed,
      timeoutMs: 180_000,
      prompt: buildArchitecturePrompt({
        promptMd: phase1.promptMd,
        specMd: phase1.specMd,
        uiSpecMd: phase1.uiSpecMd,
      }),
      schema: architectureSchema,
    })

    input.onProgress?.({ phase: 'registry', message: 'Generating REGISTRY.md…', percent: 55 })
    const registry = await promptJson({
      adapter: promptAdapter,
      sessionId,
      directory: directory || null,
      model: modelParsed,
      timeoutMs: 180_000,
      prompt: buildRegistryPrompt({
        promptMd: phase1.promptMd,
        specMd: phase1.specMd,
        uiSpecMd: phase1.uiSpecMd,
        architecturePlanMd: architecture.architecturePlanMd,
      }),
      schema: registrySchema,
    })

    input.onProgress?.({ phase: 'implementation', message: 'Generating IMPLEMENTATION_PLAN.md…', percent: 75 })
    const implementation = await promptJson({
      adapter: promptAdapter,
      sessionId,
      directory: directory || null,
      model: modelParsed,
      timeoutMs: 240_000,
      prompt: buildImplementationPrompt({
        promptMd: phase1.promptMd,
        specMd: phase1.specMd,
        uiSpecMd: phase1.uiSpecMd,
        architecturePlanMd: architecture.architecturePlanMd,
        registryMd: registry.registryMd,
      }),
      schema: implementationSchema,
    })

    input.onProgress?.({ phase: 'package', message: 'Composing orchestration package…', percent: 92 })

    const pkg: OrchestrationPackage = {
      packageVersion: '0.1.0',
      metadata: {
        packageId: specId,
        createdAt,
        createdBy: 'openchamber:auto',
        source: 'openchamber:auto',
        tags: ['auto-mode', 'spec'],
      },
      objective: {
        title: phase1.title.trim(),
        description: phase1.description.trim(),
        inputs: {
          promptMd: phase1.promptMd,
          specMd: phase1.specMd,
          uiSpecMd: phase1.uiSpecMd,
          architecturePlanMd: architecture.architecturePlanMd,
          registryMd: registry.registryMd,
          implementationPlanMd: implementation.implementationPlanMd,
          userPrompt: input.prompt.trim(),
          mergedPrompt,
          context: input.context ?? {},
        },
        doneCriteria: phase1.doneCriteria.map((desc, idx) => ({
          id: `done_${idx + 1}`,
          description: desc,
          requiredEvidenceTypes: ['diff', 'test_result', 'log_excerpt'],
        })),
      },
      agents: {
        orchestrator: {
          name: 'orchestrator',
          model: modelRef,
          systemPromptRef: 'openchamber/orchestrator-system',
        },
        worker: {
          name: 'worker',
          model: modelRef,
          systemPromptRef: 'openchamber/worker-system',
        },
      },
      registries: {
        skills: [],
        variables: registry.registries.variables,
        functions: registry.registries.functions,
      },
      runPolicy: {
        limits: {
          maxOrchestratorIterations: 4,
          maxWorkerIterations: 6,
          maxRunWallClockMs: 20 * 60 * 1000,
        },
        retries: {
          maxWorkerTaskRetries: 1,
          maxMalformedOutputRetries: 1,
        },
        concurrency: {
          maxWorkers: 4,
        },
        timeouts: {
          workerTaskMs: 2 * 60 * 1000,
          orchestratorStepMs: 2 * 60 * 1000,
        },
        budget: {
          maxTokens: 250_000,
          maxCostUsd: 25,
        },
        determinism: {
          enforceStageOrder: true,
          requireStrictJson: true,
          singleSessionPerRun: true,
        },
      },
      preview: inferred.preview,
      git: inferred.git,
    }

    const documents: SpecDocument[] = [
      { path: 'PROMPT.md', title: 'Prompt', content: phase1.promptMd },
      { path: 'SPEC.md', title: 'Spec', content: phase1.specMd },
      { path: 'UI_SPEC.md', title: 'UI Spec', content: phase1.uiSpecMd },
      { path: 'ARCHITECTURE_PLAN.md', title: 'Architecture Plan', content: architecture.architecturePlanMd },
      { path: 'REGISTRY.md', title: 'Registry', content: registry.registryMd },
      { path: 'IMPLEMENTATION_PLAN.md', title: 'Implementation Plan', content: implementation.implementationPlanMd },
      { path: 'ORCHESTRATION_PACKAGE.json', title: 'OrchestrationPackage', content: JSON.stringify(pkg, null, 2) },
    ]

    return {
      specId,
      createdAt,
      questions: questions.length > 0 ? questions : undefined,
      documents,
      orchestrationPackage: pkg,
    }
  } finally {
    input.onProgress?.({ phase: 'done', message: 'Done', percent: 100 })
    if (runWithSession.sessionId) {
      await input.adapter.cancelSession(runWithSession.sessionId).catch(() => null)
    }
  }
}

function buildEphemeralRun(input: {
  specId: string
  createdAt: string
  model: string
  directory: string
  inferred: { preview: NonNullable<OrchestrationPackage['preview']>; git: NonNullable<OrchestrationPackage['git']> }
}): RunRecord {
  const pkg: OrchestrationPackage = {
    packageVersion: '0.1.0',
    metadata: {
      packageId: input.specId,
      createdAt: input.createdAt,
      createdBy: 'openchamber:auto',
    },
    objective: {
      title: 'Spec generation',
      description: 'Generate spec docs',
      inputs: {},
      doneCriteria: [{ id: 'done_1', description: 'Docs generated', requiredEvidenceTypes: ['log_excerpt'] }],
    },
    agents: {
      orchestrator: { name: 'orchestrator', model: input.model, systemPromptRef: 'openchamber/orchestrator-system' },
      worker: { name: 'worker', model: input.model, systemPromptRef: 'openchamber/worker-system' },
    },
    registries: { skills: [], variables: [] },
    runPolicy: {
      limits: { maxOrchestratorIterations: 1, maxWorkerIterations: 1, maxRunWallClockMs: 120_000 },
      retries: { maxWorkerTaskRetries: 0, maxMalformedOutputRetries: 0 },
      concurrency: { maxWorkers: 1 },
      timeouts: { workerTaskMs: 60_000, orchestratorStepMs: 60_000 },
      budget: { maxTokens: 100_000, maxCostUsd: 5 },
      determinism: { enforceStageOrder: true, requireStrictJson: true, singleSessionPerRun: true },
    },
    preview: input.inferred.preview,
    git: input.inferred.git,
  }

  return {
    id: input.specId,
    status: 'queued',
    reason: null,
    cancelRequested: false,
    orchestrationPackage: pkg,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    startedAt: null,
    finishedAt: null,
    sessionId: null,
    budgetTokensUsed: 0,
    budgetCostUsed: 0,
  }
}

function parseModelRef(model: string): { providerID: string; modelID: string } {
  const raw = typeof model === 'string' ? model.trim() : ''
  const [providerID, modelID] = raw.split('/', 2)
  if (providerID && modelID) {
    return { providerID, modelID }
  }
  return { providerID: 'opencode', modelID: 'big-pickle' }
}

async function promptJson<T extends z.ZodTypeAny>(input: {
  adapter: { sendPromptAndWaitForText: (args: {
    sessionId: string
    directory: string | null
    model: { providerID: string; modelID: string }
    agentName: string
    text: string
    timeoutMs: number
  }) => Promise<string> }
  sessionId: string
  directory: string | null
  model: { providerID: string; modelID: string }
  agentName?: string
  prompt: string
  timeoutMs: number
  schema: T
}): Promise<z.infer<T>> {
  const text = await input.adapter.sendPromptAndWaitForText({
    sessionId: input.sessionId,
    directory: input.directory,
    model: input.model,
    agentName: input.agentName ?? 'build',
    text: input.prompt,
    timeoutMs: input.timeoutMs,
  })
  const parsed = parseJsonLoose(text)
  const validated = input.schema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`Spec generation JSON invalid: ${validated.error.issues.map((i) => `${i.path.join('.') || '/'} ${i.message}`).join('; ')}`)
  }
  return validated.data
}

function parseJsonLoose(text: string): unknown {
  const trimmed = String(text || '').trim()
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  const slice = first !== -1 && last !== -1 && last > first ? trimmed.slice(first, last + 1) : trimmed
  return JSON.parse(slice)
}

function mergePromptWithAnswers(prompt: string, answers: Record<string, string>): string {
  const normalizedPrompt = prompt.trim()
  const entries = Object.entries(answers)
    .map(([k, v]) => [String(k).trim(), typeof v === 'string' ? v.trim() : ''] as const)
    .filter(([, v]) => v.length > 0)

  if (entries.length === 0) {
    return normalizedPrompt
  }

  return [
    normalizedPrompt,
    '',
    '## Follow-up Answers',
    ...entries.map(([k, v]) => `- ${k}: ${v}`),
  ].join('\n')
}

function buildPhase1Prompt(prompt: string): string {
  return [
    'You are generating a spec bundle for an autonomous orchestrator + parallel workers.',
    'Return STRICT JSON only. No code fences. No extra keys.',
    '',
    'Return exactly:',
    '{"promptMd": string, "specMd": string, "uiSpecMd": string, "title": string, "description": string, "doneCriteria": string[]}',
    '',
    'Rules:',
    '- Do not use tools. Do not read files. Do not access the network.',
    '- All markdown must be detailed and actionable.',
    '- specMd must include: Scope, Non-goals, Constraints, Acceptance Criteria, Validation Plan, Risks.',
    '- uiSpecMd must include: Screens/States, Interactions, Accessibility, Visual direction, Empty/loading/error states.',
    '- promptMd is an enhanced version of the user goal (clear, complete, structured).',
    '- doneCriteria must be testable/verifiable and match specMd acceptance criteria.',
    '',
    'User prompt:',
    prompt.trim(),
  ].join('\n')
}

function buildArchitecturePrompt(input: { promptMd: string; specMd: string; uiSpecMd: string }): string {
  return [
    'You are selecting the best architecture and producing an architecture plan.',
    'Return STRICT JSON only. No code fences.',
    '',
    'Return exactly: {"architecturePlanMd": string}',
    '',
    'Rules:',
    '- Do not use tools. Do not read files. Do not access the network.',
    '- Be explicit about modules, data flow, and integration points.',
    '- Include alternatives considered + why rejected.',
    '- Include risk points and mitigations.',
    '',
    'PROMPT.md:',
    input.promptMd,
    '',
    'SPEC.md:',
    input.specMd,
    '',
    'UI_SPEC.md:',
    input.uiSpecMd,
  ].join('\n')
}

function buildRegistryPrompt(input: {
  promptMd: string
  specMd: string
  uiSpecMd: string
  architecturePlanMd: string
}): string {
  return [
    'You are producing a function + variable registry for an orchestrator + workers.',
    'Return STRICT JSON only. No code fences.',
    '',
    'Return exactly: {"registryMd": string, "registries": {"variables": object[], "functions": object[]}}',
    '',
    'Rules:',
    '- Do not use tools. Do not read files. Do not access the network.',
    '- registryMd must be markdown that mirrors the JSON structure for human readability.',
    '- registries.variables and registries.functions must be stable and minimal (only what is needed).',
    '- If unsure, include fewer entries, not more.',
    '',
    'ARCHITECTURE_PLAN.md:',
    input.architecturePlanMd,
  ].join('\n')
}

function buildImplementationPrompt(input: {
  promptMd: string
  specMd: string
  uiSpecMd: string
  architecturePlanMd: string
  registryMd: string
}): string {
  return [
    'You are producing an agent-executable IMPLEMENTATION_PLAN.md for an orchestrator.',
    'Return STRICT JSON only. No code fences.',
    '',
    'Return exactly: {"implementationPlanMd": string}',
    '',
    'Rules:',
    '- Do not use tools. Do not read files. Do not access the network.',
    '- implementationPlanMd must be a checklist with [ ] for every delegatable task.',
    '- Each checklist item must have a stable id like "T1", "T2" and be small enough for a single worker.',
    '- Include explicit verification steps (commands) and expected signals.',
    '- Include dependencies between tasks and where merges/integration should happen.',
    '',
    'SPEC.md:',
    input.specMd,
    '',
    'ARCHITECTURE_PLAN.md:',
    input.architecturePlanMd,
    '',
    'REGISTRY.md:',
    input.registryMd,
  ].join('\n')
}

function inferProjectConfig(
  directory: string,
  specId: string,
): { preview: NonNullable<OrchestrationPackage['preview']>; git: NonNullable<OrchestrationPackage['git']> } {
  const previewDisabled = { enabled: false } as NonNullable<OrchestrationPackage['preview']>
  const gitDisabled = { enabled: false } as NonNullable<OrchestrationPackage['git']>

  if (!directory) {
    return { preview: previewDisabled, git: gitDisabled }
  }

  try {
    if (!fs.existsSync(directory)) {
      return { preview: previewDisabled, git: gitDisabled }
    }
  } catch {
    return { preview: previewDisabled, git: gitDisabled }
  }

  const gitEnabled = fs.existsSync(path.join(directory, '.git'))
  const git: NonNullable<OrchestrationPackage['git']> = gitEnabled
    ? {
        enabled: true,
        repoPath: directory,
        worktreesRoot: `${directory.replace(/\/+$/, '')}/.orchestrate-worktrees/${specId}`,
        baseBranch: 'main',
        integrationBranch: `oc/integration/${specId}`,
        requireChecks: [],
      }
    : gitDisabled

  const pkgPath = path.join(directory, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return { preview: previewDisabled, git }
  }

  let pkg: unknown = null
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as unknown
  } catch {
    return { preview: previewDisabled, git }
  }

  const pkgObj = pkg && typeof pkg === 'object' ? (pkg as Record<string, unknown>) : null
  const scripts = pkgObj && typeof pkgObj.scripts === 'object' ? (pkgObj.scripts as Record<string, unknown>) : null
  const devScript = scripts && typeof scripts.dev === 'string' ? scripts.dev : null
  const startScript = scripts && typeof scripts.start === 'string' ? scripts.start : null
  const deps = {
    ...((pkgObj && typeof pkgObj.dependencies === 'object' ? (pkgObj.dependencies as Record<string, unknown>) : {}) ?? {}),
    ...((pkgObj && typeof pkgObj.devDependencies === 'object' ? (pkgObj.devDependencies as Record<string, unknown>) : {}) ?? {}),
  }
  const hasVite = typeof deps.vite === 'string'
  const hasNext = typeof deps.next === 'string'
  const hasReactScripts = typeof deps['react-scripts'] === 'string'

  if (hasVite && devScript) {
    return {
      preview: {
        enabled: true,
        required: true,
        cwd: directory,
        command: 'bun',
        args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '{PORT}'],
        readyPath: '/',
        autoStopOnTerminal: true,
      },
      git,
    }
  }

  if (hasNext && devScript) {
    return {
      preview: {
        enabled: true,
        required: true,
        cwd: directory,
        command: 'bun',
        args: ['run', 'dev', '--', '-p', '{PORT}', '-H', '127.0.0.1'],
        readyPath: '/',
        autoStopOnTerminal: true,
      },
      git,
    }
  }

  if (hasReactScripts && (startScript || devScript)) {
    const script = devScript ? 'dev' : 'start'
    return {
      preview: {
        enabled: true,
        required: true,
        cwd: directory,
        command: 'bun',
        args: ['run', script],
        readyPath: '/',
        autoStopOnTerminal: true,
      },
      git,
    }
  }

  return { preview: previewDisabled, git }
}
