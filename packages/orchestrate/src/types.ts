export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timed_out'

export type LoopStage = 'plan' | 'act' | 'check' | 'fix' | 'report'

export type EvidenceType =
  | 'test_result'
  | 'log_excerpt'
  | 'diff'
  | 'artifact'
  | 'metric'
  | 'screenshot'

export interface RunRecord {
  id: string
  status: RunStatus
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  reason: string | null
  cancelRequested: boolean
  sessionId: string | null
  orchestrationPackage: OrchestrationPackage
  budgetTokensUsed: number
  budgetCostUsed: number
}

export interface RunEvent {
  runId: string
  eventId: number
  type: string
  data: Record<string, unknown>
  createdAt: string
}

export interface OrchestrationPackage {
  packageVersion: string
  metadata: {
    packageId: string
    createdAt: string
    createdBy: string
    source?: string
    tags?: string[]
  }
  objective: {
    title: string
    description: string
    inputs?: Record<string, unknown>
    doneCriteria: Array<{
      id: string
      description: string
      requiredEvidenceTypes: EvidenceType[]
    }>
  }
  agents: {
    orchestrator: {
      name: string
      model: string
      systemPromptRef: string
      temperature?: number
    }
    worker: {
      name: string
      model: string
      systemPromptRef: string
      temperature?: number
    }
  }
  registries: {
    skills: Array<Record<string, unknown>>
    variables: Array<Record<string, unknown>>
    functions?: Array<Record<string, unknown>>
    uiSpecs?: Array<Record<string, unknown>>
  }
  runPolicy: {
    limits: {
      maxOrchestratorIterations: number
      maxWorkerIterations: number
      maxRunWallClockMs: number
    }
    retries: {
      maxWorkerTaskRetries: number
      maxMalformedOutputRetries: number
    }
    concurrency: {
      maxWorkers: number
    }
    timeouts: {
      workerTaskMs: number
      orchestratorStepMs: number
    }
    budget: {
      maxTokens: number
      maxCostUsd: number
    }
    determinism: {
      enforceStageOrder: true
      requireStrictJson: true
      singleSessionPerRun: true
    }
  }

  // Optional: live preview server management for UI embedding.
  preview?: {
    enabled?: boolean
    required?: boolean
    command?: string
    args?: string[]
    cwd?: string
    readyPath?: string
    autoStopOnTerminal?: boolean
  }

  // Optional: git swarm + merge queue support.
  git?: {
    enabled?: boolean
    repoPath?: string
    worktreesRoot?: string
    baseBranch?: string
    integrationBranch?: string
    requireChecks?: string[]
    identity?: {
      userName?: string
      userEmail?: string
      sshCommand?: string
    }
  }
}

export interface EvidenceItem {
  evidenceId: string
  type: EvidenceType
  uri: string
  description: string
  hash: string
  metadata?: Record<string, unknown>
}

export interface AgentResult {
  resultId: string
  taskId: string
  runId: string
  agentRole: 'orchestrator' | 'worker'
  workerId?: string | null
  iteration: {
    index: number
    max: number
    attempt: number
  }
  stage: LoopStage
  status: 'in_progress' | 'succeeded' | 'failed' | 'needs_fix'
  summary: string
  checks: Array<{
    checkId: string
    passed: boolean
    reason: string
  }>
  evidence: EvidenceItem[]
  artifacts: Array<{
    artifactId: string
    kind: string
    uri: string
    sizeBytes?: number
  }>
  metrics: {
    durationMs: number
    tokensUsed: number
    costUsd: number
  }
  next: {
    recommendedStage: LoopStage | 'end'
    reason: string
  }
}

export interface AgentTask {
  taskId: string
  runId: string
  assignedBy: {
    agent: 'orchestrator'
    iteration: number
  }
  workerProfile: {
    name: string
    model: string
  }
  dependencies: string[]
  loop: {
    maxIterations: number
    currentIteration: number
    allowedStages: LoopStage[]
  }
  objective: string
  inputs: Record<string, unknown>
  constraints: {
    timeoutMs: number
    budgetTokens: number
    allowedSkills: string[]
  }
  acceptance: Array<{
    id: string
    description: string
  }>
  requiredEvidence: Array<{
    type: EvidenceType
    description: string
    required?: boolean
  }>
  outputFormat?: 'AgentResult.schema.json'
}

export interface OrchestratorOutput {
  agentRole: 'orchestrator'
  stage: LoopStage
  status: 'in_progress' | 'succeeded' | 'failed' | 'needs_fix'
  summary: string
  plan?: {
    goals: string[]
    tasks: Array<{
      taskId: string
      objective: string
      priority: 'high' | 'medium' | 'low'
      requiredEvidence: EvidenceType[]
      dependencies: string[]
    }>
  }
  workerDispatch?: Array<{
    taskId: string
    workerProfile: string
    inputs: Record<string, unknown>
    acceptance: string[]
    requiredEvidence: EvidenceType[]
  }>
  checks?: Array<{
    checkId: string
    passed: boolean
    reason: string
  }>
  fixes?: Array<{
    issue: string
    action: string
    retryTarget: string
  }>
  report?: {
    outcome: 'succeeded' | 'failed' | 'partial'
    deliverables: string[]
    evidenceRefs: string[]
    artifactRefs: string[]
    openRisks: string[]
  }
  metrics: {
    estimatedTokens: number
    estimatedCostUsd: number
  }
  next: {
    recommendedStage: LoopStage | 'end'
    reason: string
  }
}
