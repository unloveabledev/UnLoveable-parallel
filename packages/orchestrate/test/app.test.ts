import assert from 'node:assert/strict'
import test from 'node:test'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { DeterministicMockOpenCodeAdapter, type OpenCodeAdapter } from '../src/opencode-adapter.js'
import type { AgentResult, AgentTask, LoopStage, OrchestratorOutput, RunRecord } from '../src/types.js'

const IS_BUN = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== 'undefined'

function samplePackage() {
  return {
    packageVersion: '1.0.0',
    metadata: {
      packageId: 'pkg_1',
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    },
    objective: {
      title: 'Test objective',
      description: 'Do thing',
      doneCriteria: [
        {
          id: 'c1',
          description: 'Need test and diff',
          requiredEvidenceTypes: ['test_result', 'diff'],
        },
      ],
    },
    agents: {
      orchestrator: {
        name: 'orchestrator',
        model: 'test-model',
        systemPromptRef: 'prompts/orchestrator.system.md',
      },
      worker: {
        name: 'worker',
        model: 'test-model',
        systemPromptRef: 'prompts/worker.system.md',
      },
    },
    registries: {
      skills: [],
      variables: [],
    },
    runPolicy: {
      limits: {
        maxOrchestratorIterations: 3,
        maxWorkerIterations: 2,
        maxRunWallClockMs: 10000,
      },
      retries: {
        maxWorkerTaskRetries: 1,
        maxMalformedOutputRetries: 1,
      },
      concurrency: {
        maxWorkers: 2,
      },
      timeouts: {
        workerTaskMs: 1000,
        orchestratorStepMs: 1000,
      },
      budget: {
        maxTokens: 1000,
        maxCostUsd: 5,
      },
      determinism: {
        enforceStageOrder: true,
        requireStrictJson: true,
        singleSessionPerRun: true,
      },
    },
  }
}

async function waitForTerminalStatus(api: ReturnType<typeof request>, runId: string) {
  for (let i = 0; i < 40; i += 1) {
    const response = await api.get(`/runs/${runId}`)
    const status = response.body.status as string
    if (['succeeded', 'failed', 'canceled', 'timed_out'].includes(status)) {
      return response.body
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('run did not reach terminal status in time')
}

if (IS_BUN) {
  test('orchestrate integration (skipped under bun)', () => {
    // Bun does not support better-sqlite3; run this suite under Node.
  })
} else {

test('happy path run succeeds', async () => {
  const { app } = buildApp({ adapter: new DeterministicMockOpenCodeAdapter() })
  const api = request(app)

  const create = await api.post('/runs').send(samplePackage()).expect(201)
  const run = await waitForTerminalStatus(api, create.body.id)
  assert.equal(run.status, 'succeeded')
})

class MissingEvidenceAdapter extends DeterministicMockOpenCodeAdapter {
  override async runWorkerStage(input: {
    run: RunRecord
    task: AgentTask
    stage: LoopStage
    iteration: number
    attempt: number
  }): Promise<AgentResult> {
    const result = await super.runWorkerStage(input)
    if (input.stage === 'check' || input.stage === 'report') {
      return { ...result, evidence: [] }
    }
    return result
  }
}

test('missing evidence causes run failure', async () => {
  const { app } = buildApp({ adapter: new MissingEvidenceAdapter() })
  const api = request(app)

  const create = await api.post('/runs').send(samplePackage()).expect(201)
  const run = await waitForTerminalStatus(api, create.body.id)
  assert.equal(run.status, 'failed')
})

class BudgetExceedAdapter extends DeterministicMockOpenCodeAdapter {
  override async runOrchestratorStage(input: {
    run: RunRecord
    stage: LoopStage
    iteration: number
    workerResults: AgentResult[]
  }): Promise<OrchestratorOutput> {
    const result = await super.runOrchestratorStage(input)
    if (input.stage === 'plan') {
      return {
        ...result,
        metrics: {
          estimatedTokens: 999999,
          estimatedCostUsd: 999,
        },
      }
    }
    return result
  }
}

test('budget exceed fails run', async () => {
  const { app } = buildApp({ adapter: new BudgetExceedAdapter() })
  const api = request(app)

  const pkg = samplePackage()
  pkg.runPolicy.budget.maxTokens = 10
  pkg.runPolicy.budget.maxCostUsd = 0.01

  const create = await api.post('/runs').send(pkg).expect(201)
  const run = await waitForTerminalStatus(api, create.body.id)
  assert.equal(run.status, 'failed')
  assert.equal(run.reason, 'budget_exceeded')
})

class SlowCancelAdapter extends DeterministicMockOpenCodeAdapter implements OpenCodeAdapter {
  override async runOrchestratorStage(input: {
    run: RunRecord
    stage: LoopStage
    iteration: number
    workerResults: AgentResult[]
  }): Promise<OrchestratorOutput> {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return super.runOrchestratorStage(input)
  }
}

test('cancel queued run transitions to canceled', async () => {
  const { app } = buildApp({ adapter: new SlowCancelAdapter() })
  const api = request(app)

  const create = await api.post('/runs').send(samplePackage()).expect(201)
  await api.post(`/runs/${create.body.id}/cancel`).expect(202)
  const run = await waitForTerminalStatus(api, create.body.id)
  assert.equal(run.status, 'canceled')
})

}
