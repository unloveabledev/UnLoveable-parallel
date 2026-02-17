import { randomUUID } from 'node:crypto'
import type { AgentResult, AgentTask, LoopStage, OrchestratorOutput, RunRecord } from './types.js'

export interface OpenCodeAdapter {
  kind: 'mock' | 'opencode'
  createSession(run: RunRecord): Promise<{ sessionId: string }>
  cancelSession(sessionId: string): Promise<void>
  runOrchestratorStage(input: {
    run: RunRecord
    stage: LoopStage
    iteration: number
    workerResults: AgentResult[]
  }): Promise<OrchestratorOutput>
  runWorkerStage(input: {
    run: RunRecord
    task: AgentTask
    stage: LoopStage
    iteration: number
    attempt: number
  }): Promise<AgentResult>
}

export class DeterministicMockOpenCodeAdapter implements OpenCodeAdapter {
  kind = 'mock' as const
  async createSession(run: RunRecord): Promise<{ sessionId: string }> {
    return { sessionId: `sess_${run.id}` }
  }

  async cancelSession(): Promise<void> {
    return
  }

  async runOrchestratorStage(input: {
    run: RunRecord
    stage: LoopStage
    iteration: number
    workerResults: AgentResult[]
  }): Promise<OrchestratorOutput> {
    const doneCriteriaEvidence = input.run.orchestrationPackage.objective.doneCriteria.flatMap(
      (criterion) => criterion.requiredEvidenceTypes,
    )

    if (input.stage === 'plan') {
      return {
        agentRole: 'orchestrator',
        stage: 'plan',
        status: 'in_progress',
        summary: 'Planned worker tasks.',
        plan: {
          goals: [input.run.orchestrationPackage.objective.title],
          tasks: [
            {
              taskId: `task_${input.iteration}_1`,
              objective: input.run.orchestrationPackage.objective.description,
              priority: 'high',
              requiredEvidence: doneCriteriaEvidence,
              dependencies: [],
            },
          ],
        },
        metrics: { estimatedTokens: 100, estimatedCostUsd: 0.001 },
        next: { recommendedStage: 'act', reason: 'task graph created' },
      }
    }

    if (input.stage === 'act') {
      return {
        agentRole: 'orchestrator',
        stage: 'act',
        status: 'in_progress',
        summary: 'Dispatching workers.',
        workerDispatch: [
          {
            taskId: `task_${input.iteration}_1`,
            workerProfile: input.run.orchestrationPackage.agents.worker.name,
            inputs: input.run.orchestrationPackage.objective.inputs ?? {},
            acceptance: input.run.orchestrationPackage.objective.doneCriteria.map((criterion) => criterion.description),
            requiredEvidence: doneCriteriaEvidence,
          },
        ],
        metrics: { estimatedTokens: 80, estimatedCostUsd: 0.001 },
        next: { recommendedStage: 'check', reason: 'workers dispatched' },
      }
    }

    if (input.stage === 'check') {
      const passed = input.workerResults.every((result) => result.status === 'succeeded')
      return {
        agentRole: 'orchestrator',
        stage: 'check',
        status: passed ? 'succeeded' : 'needs_fix',
        summary: passed ? 'All worker checks passed.' : 'One or more worker checks failed.',
        checks: [
          {
            checkId: 'workers_passed',
            passed,
            reason: passed ? 'all workers succeeded' : 'worker reported failure',
          },
        ],
        metrics: { estimatedTokens: 60, estimatedCostUsd: 0.001 },
        next: {
          recommendedStage: passed ? 'report' : 'fix',
          reason: passed ? 'objective satisfied' : 'requires retry',
        },
      }
    }

    if (input.stage === 'fix') {
      return {
        agentRole: 'orchestrator',
        stage: 'fix',
        status: 'in_progress',
        summary: 'Applying corrective plan.',
        fixes: [
          {
            issue: 'worker_failed_check',
            action: 'retry failed tasks with narrowed scope',
            retryTarget: 'worker:retry',
          },
        ],
        metrics: { estimatedTokens: 70, estimatedCostUsd: 0.001 },
        next: { recommendedStage: 'plan', reason: 'new plan generated' },
      }
    }

    return {
      agentRole: 'orchestrator',
      stage: 'report',
      status: 'succeeded',
      summary: 'Reporting completion.',
      report: {
        outcome: 'succeeded',
        deliverables: [input.run.orchestrationPackage.objective.title],
        evidenceRefs: input.workerResults.flatMap((result) => result.evidence.map((evidence) => evidence.evidenceId)),
        artifactRefs: input.workerResults.flatMap((result) => result.artifacts.map((artifact) => artifact.artifactId)),
        openRisks: [],
      },
      metrics: { estimatedTokens: 50, estimatedCostUsd: 0.001 },
      next: { recommendedStage: 'end', reason: 'report completed' },
    }
  }

  async runWorkerStage(input: {
    run: RunRecord
    task: AgentTask
    stage: LoopStage
    iteration: number
    attempt: number
  }): Promise<AgentResult> {
    const requiredEvidence = input.task.requiredEvidence.map((requirement) => ({
      evidenceId: `ev_${randomUUID()}`,
      type: requirement.type,
      uri: `memory://${input.task.taskId}/${requirement.type}`,
      description: requirement.description,
      hash: `hash_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      metadata: {},
    }))

    const evidence =
      input.stage === 'check' || input.stage === 'report'
        ? requiredEvidence
        : [
            {
              evidenceId: `ev_${randomUUID()}`,
              type: 'log_excerpt' as const,
              uri: `memory://${input.task.taskId}/${input.stage}/log`,
              description: `${input.stage} execution log`,
              hash: `hash_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
              metadata: {},
            },
          ]

    const status = input.stage === 'report' ? 'succeeded' : input.stage === 'check' ? 'succeeded' : 'in_progress'

    return {
      resultId: `result_${randomUUID()}`,
      taskId: input.task.taskId,
      runId: input.run.id,
      agentRole: 'worker',
      workerId: `worker_${input.task.taskId}`,
      iteration: {
        index: input.iteration,
        max: input.task.loop.maxIterations,
        attempt: input.attempt,
      },
      stage: input.stage,
      status,
      summary: `Worker completed ${input.stage}.`,
      checks:
        input.stage === 'check'
          ? [
              {
                checkId: 'required_evidence_present',
                passed: true,
                reason: 'mock adapter generated required evidence',
              },
            ]
          : [],
      evidence,
      artifacts:
        input.stage === 'report'
          ? [
              {
                artifactId: `artifact_${randomUUID()}`,
                kind: 'report',
                uri: `memory://${input.task.taskId}/artifact`,
                sizeBytes: 128,
              },
            ]
          : [],
      metrics: {
        durationMs: 10,
        tokensUsed: 20,
        costUsd: 0.0002,
      },
      next: {
        recommendedStage:
          input.stage === 'plan'
            ? 'act'
            : input.stage === 'act'
              ? 'check'
              : input.stage === 'check'
                ? 'report'
                : input.stage === 'fix'
                  ? 'plan'
                  : 'end',
        reason: 'deterministic mock progression',
      },
    }
  }
}
