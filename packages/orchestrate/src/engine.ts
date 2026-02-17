import { randomUUID } from 'node:crypto'
import pino from 'pino'
import type { OpenCodeAdapter } from './opencode-adapter.js'
import { ensureRunNotCanceled, ensureWithinBudget, ensureWithinWallClock, PolicyError, validateEvidence } from './policy.js'
import type { Repository } from './repository.js'
import type { SseHub } from './sse.js'
import type { AgentResult, AgentTask, LoopStage, OrchestrationPackage, RunRecord } from './types.js'
import { validateOrchestratorOutput, validateResult, validateTask } from './validation.js'
import type { PreviewManager, PreviewConfig } from './preview.js'
import path from 'node:path'
import os from 'node:os'
import { GitManager } from './git-manager.js'
import { validateTaskIdsAgainstImplementationPlan } from './implementation-plan.js'

const workerStages: LoopStage[] = ['plan', 'act', 'check', 'report']

export class RunEngine {
  private readonly repository: Repository
  private readonly sseHub: SseHub
  private readonly adapter: OpenCodeAdapter
  private readonly previewManager: PreviewManager | null
  private gitManagers = new Map<string, GitManager>()
  private readonly logger = pino({ name: 'orchestrate-engine' })
  private readonly activeRuns = new Set<string>()

  constructor(repository: Repository, sseHub: SseHub, adapter: OpenCodeAdapter, previewManager: PreviewManager | null = null) {
    this.repository = repository
    this.sseHub = sseHub
    this.adapter = adapter
    this.previewManager = previewManager
  }

  schedule(runId: string): void {
    if (this.activeRuns.has(runId)) {
      return
    }

    this.activeRuns.add(runId)
    queueMicrotask(() => {
      void this.execute(runId).finally(() => {
        this.activeRuns.delete(runId)
      })
    })
  }

  private async execute(runId: string): Promise<void> {
    let run = this.repository.getRunOrThrow(runId)
    if (run.status === 'canceled') {
      return
    }

    try {
      run = this.repository.markRunStarted(runId)
      this.emit(runId, 'run.started', { runId })

      await this.maybeInitGitSwarm(run)

      await this.maybeStartPreview(run)

      const session = await this.adapter.createSession(run)
      run = this.repository.setRunSession(runId, session.sessionId)
      this.emit(runId, 'session.started', { runId, sessionId: session.sessionId })

      let workerResults: AgentResult[] = []

      for (let iteration = 1; iteration <= run.orchestrationPackage.runPolicy.limits.maxOrchestratorIterations; iteration += 1) {
        run = this.enforceRunPolicy(run)

        const planOutput = await this.runOrchestratorStage(run, 'plan', iteration, workerResults)
        this.emit(runId, 'orchestrator.plan.completed', { runId, iteration, summary: planOutput.summary, output: planOutput })

        const actOutput = await this.runOrchestratorStage(run, 'act', iteration, workerResults)
        this.emit(runId, 'orchestrator.act.completed', { runId, iteration, summary: actOutput.summary, output: actOutput })

        workerResults = await this.runWorkerDispatches(run, iteration, actOutput.workerDispatch ?? [])

        await this.maybeFinalizeGitSwarm(run)

        const checkOutput = await this.runOrchestratorStage(run, 'check', iteration, workerResults)
        this.emit(runId, 'orchestrator.check.completed', {
          runId,
          iteration,
          status: checkOutput.status,
          summary: checkOutput.summary,
          output: checkOutput,
        })

        if (checkOutput.status !== 'succeeded') {
          if (iteration >= run.orchestrationPackage.runPolicy.limits.maxOrchestratorIterations) {
        run = this.repository.updateRunStatus(runId, 'failed', 'orchestrator_checks_failed')
        this.emit(runId, 'run.failed', { runId, reason: run.reason })
        await this.maybeStopPreview(run)
        await this.maybeCleanupGit(run)
        return
      }

          const fixOutput = await this.runOrchestratorStage(run, 'fix', iteration, workerResults)
          this.emit(runId, 'orchestrator.fix.completed', { runId, iteration, summary: fixOutput.summary, output: fixOutput })
          continue
        }

        const reportOutput = await this.runOrchestratorStage(run, 'report', iteration, workerResults)
        const reportEvidenceSet = new Set(workerResults.flatMap((result) => result.evidence.map((evidence) => evidence.evidenceId)))

        const hasRequiredEvidenceRefs =
          reportOutput.report?.evidenceRefs.every((evidenceRef) => reportEvidenceSet.has(evidenceRef)) ?? false

        if (!hasRequiredEvidenceRefs) {
          this.emit(runId, 'orchestrator.report.rejected', {
            runId,
            reason: 'report references unknown evidence',
          })
          run = this.repository.updateRunStatus(runId, 'failed', 'invalid_report_evidence_refs')
          this.emit(runId, 'run.failed', { runId, reason: run.reason })
          await this.maybeStopPreview(run)
          await this.maybeCleanupGit(run)
          return
        }

        // Guard against false positives: if a run requires live preview, do not
        // report success unless the preview reached ready state.
        const preview = run.orchestrationPackage.preview
        if (preview?.enabled === true && preview?.required === true && this.previewManager) {
          const status = this.previewManager.get(runId)
          if (status.state !== 'ready') {
            this.emit(runId, 'run.warning', {
              runId,
              code: 'preview_required_not_ready',
              preview: status,
            })
            run = this.repository.updateRunStatus(runId, 'failed', 'preview_failed')
            this.emit(runId, 'run.failed', { runId, reason: run.reason })
            await this.maybeStopPreview(run)
            await this.maybeCleanupGit(run)
            return
          }
        }

        run = this.repository.updateRunStatus(runId, 'succeeded', null)
        this.emit(runId, 'orchestrator.report.completed', { runId, iteration, summary: reportOutput.summary, output: reportOutput })
        this.emit(runId, 'run.completed', { runId, status: run.status })
        await this.maybeStopPreview(run)
        await this.maybeCleanupGit(run)
        return
      }

      run = this.repository.updateRunStatus(runId, 'failed', 'max_iterations_exhausted')
      this.emit(runId, 'run.failed', { runId, reason: run.reason })
      await this.maybeStopPreview(run)
      await this.maybeCleanupGit(run)
    } catch (error) {
      if (error instanceof PolicyError) {
        run = this.handlePolicyError(run, error)
      } else {
        this.logger.error({ err: error, runId }, 'run execution failed')
        run = this.repository.updateRunStatus(runId, 'failed', 'internal_error')
        this.emit(runId, 'run.failed', { runId, reason: 'internal_error' })
      }

      if (run.sessionId) {
        await this.adapter.cancelSession(run.sessionId)
      }

      await this.maybeStopPreview(run)
      await this.maybeCleanupGit(run)
    }
  }

  private async maybeStartPreview(run: RunRecord): Promise<void> {
    if (!this.previewManager) {
      return
    }
    const preview = run.orchestrationPackage.preview
    if (!preview || preview.enabled !== true) {
      return
    }

    const config: PreviewConfig = {
      command: typeof preview.command === 'string' && preview.command.trim().length > 0 ? preview.command.trim() : 'bun',
      args:
        Array.isArray(preview.args) && preview.args.length > 0
          ? preview.args
          : ['run', 'dev', '--', '--port', '{PORT}', '--host', '127.0.0.1'],
      cwd: typeof preview.cwd === 'string' && preview.cwd.trim().length > 0 ? preview.cwd.trim() : process.cwd(),
      readyPath: typeof preview.readyPath === 'string' && preview.readyPath.trim().length > 0 ? preview.readyPath.trim() : '/',
      autoStopOnTerminal: preview.autoStopOnTerminal !== false,
    }

    try {
      await this.previewManager.start(run.id, config)
    } catch (error) {
      this.logger.warn({ err: error, runId: run.id }, 'preview start failed')
    }
  }

  private async maybeInitGitSwarm(run: RunRecord): Promise<void> {
    const git = run.orchestrationPackage.git
    if (!git || git.enabled !== true) {
      return
    }

    const repoPath = typeof git.repoPath === 'string' && git.repoPath.trim().length > 0 ? git.repoPath.trim() : ''
    if (!repoPath) {
      this.emit(run.id, 'git.error', { runId: run.id, message: 'git.repoPath is required when git.enabled is true' })
      return
    }

    const baseBranch = typeof git.baseBranch === 'string' && git.baseBranch.trim().length > 0 ? git.baseBranch.trim() : 'main'
    const integrationBranch = typeof git.integrationBranch === 'string' && git.integrationBranch.trim().length > 0
      ? git.integrationBranch.trim()
      : `oc/integration/${run.id}`

    const worktreesRoot = typeof git.worktreesRoot === 'string' && git.worktreesRoot.trim().length > 0
      ? git.worktreesRoot.trim()
      : path.join(os.tmpdir(), 'orchestrate-worktrees', run.id)

    const identity = {
      userName: typeof git.identity?.userName === 'string' ? git.identity.userName : null,
      userEmail: typeof git.identity?.userEmail === 'string' ? git.identity.userEmail : null,
      sshCommand: typeof git.identity?.sshCommand === 'string' ? git.identity.sshCommand : null,
    }

    const manager = new GitManager({
      runId: run.id,
      repoPath,
      worktreesRoot,
      baseBranch,
      integrationBranch,
      requireChecks: Array.isArray(git.requireChecks) ? git.requireChecks.map(String) : [],
      identity,
    }, (type, data) => {
      const event = this.repository.appendEvent(run.id, type, data)
      this.sseHub.publish(event)
    })

    try {
      await manager.init()
      this.gitManagers.set(run.id, manager)
    } catch (error) {
      this.emit(run.id, 'git.error', {
        runId: run.id,
        message: error instanceof Error ? error.message : 'git init failed',
      })
    }
  }

  private async maybeFinalizeGitSwarm(run: RunRecord): Promise<void> {
    const manager = this.gitManagers.get(run.id)
    if (!manager) {
      return
    }
    await manager.processMergeQueue().catch((error) => {
      this.emit(run.id, 'git.error', { runId: run.id, message: error instanceof Error ? error.message : 'merge queue failed' })
    })
  }

  private async maybeCleanupGit(run: RunRecord): Promise<void> {
    const manager = this.gitManagers.get(run.id)
    if (!manager) {
      return
    }
    this.gitManagers.delete(run.id)
    await manager.cleanup().catch(() => {})
  }

  private async maybeStopPreview(run: RunRecord): Promise<void> {
    if (!this.previewManager) {
      return
    }
    const preview = run.orchestrationPackage.preview
    if (preview && preview.autoStopOnTerminal === false) {
      return
    }
    try {
      await this.previewManager.stop(run.id)
    } catch (error) {
      this.logger.warn({ err: error, runId: run.id }, 'preview stop failed')
    }
  }

  private handlePolicyError(run: RunRecord, error: PolicyError): RunRecord {
    if (error.code === 'run_canceled') {
      const updated = this.repository.updateRunStatus(run.id, 'canceled', 'canceled_by_user')
      this.emit(run.id, 'run.canceled', { runId: run.id })
      return updated
    }

    if (error.code === 'wall_clock_exceeded') {
      const updated = this.repository.updateRunStatus(run.id, 'timed_out', error.code)
      this.emit(run.id, 'run.timed_out', { runId: run.id })
      return updated
    }

    if (error.code === 'budget_tokens_exceeded' || error.code === 'budget_cost_exceeded') {
      const updated = this.repository.updateRunStatus(run.id, 'failed', 'budget_exceeded')
      this.emit(run.id, 'policy.budget.exceeded', { runId: run.id, code: error.code })
      this.emit(run.id, 'run.failed', { runId: run.id, reason: 'budget_exceeded' })
      return updated
    }

    const updated = this.repository.updateRunStatus(run.id, 'failed', error.code)
    this.emit(run.id, 'run.failed', { runId: run.id, reason: error.code })
    return updated
  }

  private enforceRunPolicy(run: RunRecord): RunRecord {
    const freshRun = this.repository.getRunOrThrow(run.id)
    ensureRunNotCanceled(freshRun)
    ensureWithinWallClock(freshRun)
    ensureWithinBudget(freshRun)
    return freshRun
  }

  private async runOrchestratorStage(
    run: RunRecord,
    stage: LoopStage,
    iteration: number,
    workerResults: AgentResult[],
  ) {
    const maxMalformedRetries = run.orchestrationPackage.runPolicy.retries.maxMalformedOutputRetries
    let validationError: unknown = null
    let validationFeedback: string | null = null
    for (let malformedAttempt = 1; malformedAttempt <= maxMalformedRetries + 1; malformedAttempt += 1) {
      const runForAttempt = validationFeedback ? this.withOrchestratorValidationFeedback(run, validationFeedback) : run
      const output = await this.withTimeout(
        this.adapter.runOrchestratorStage({ run: runForAttempt, stage, iteration, workerResults }),
        run.orchestrationPackage.runPolicy.timeouts.orchestratorStepMs,
        'orchestrator_timeout',
      )

      const validation = validateOrchestratorOutput(output)
      if (validation.ok && validation.value) {
        const planValidation = this.validateOrchestratorTaskIds(run, stage, validation.value)
        if (!planValidation.ok) {
          validationError = planValidation.errors
          validationFeedback = planValidation.errors.map((e) => `- ${e.path}: ${e.message}`).join('\n')
          this.emit(run.id, 'agent.output.invalid', {
            runId: run.id,
            actor: 'orchestrator',
            stage,
            malformedAttempt,
            errors: planValidation.errors,
          })
          continue
        }

        validationFeedback = null
        this.repository.updateBudgetUsage(
          run.id,
          Math.ceil(validation.value.metrics.estimatedTokens),
          validation.value.metrics.estimatedCostUsd,
        )

        return validation.value
      }

      validationError = validation.errors
      validationFeedback = validation.errors.map((e) => `- ${e.path}: ${e.message}`).join('\n')
      this.emit(run.id, 'agent.output.invalid', {
        runId: run.id,
        actor: 'orchestrator',
        stage,
        malformedAttempt,
        errors: validation.errors,
      })
    }

    throw new PolicyError('orchestrator_output_invalid', `orchestrator output was invalid: ${JSON.stringify(validationError)}`)
  }

  private withOrchestratorValidationFeedback(run: RunRecord, feedback: string): RunRecord {
    const objective = run.orchestrationPackage.objective
    const inputs = objective.inputs && typeof objective.inputs === 'object' ? (objective.inputs as Record<string, unknown>) : {}
    const nextInputs = { ...inputs, orchestratorValidationErrors: feedback }
    return {
      ...run,
      orchestrationPackage: {
        ...run.orchestrationPackage,
        objective: {
          ...objective,
          inputs: nextInputs,
        },
      },
    }
  }

  private validateOrchestratorTaskIds(
    run: RunRecord,
    stage: LoopStage,
    output: { plan?: { tasks: Array<{ taskId: string }> } | undefined; workerDispatch?: Array<{ taskId: string }> | undefined },
  ): { ok: true } | { ok: false; errors: Array<{ path: string; message: string }> } {
    if (stage !== 'plan' && stage !== 'act') {
      return { ok: true }
    }

    const inputs = run.orchestrationPackage.objective.inputs
    if (!inputs || typeof inputs !== 'object') {
      return { ok: true }
    }
    const implementationPlanMd = (inputs as Record<string, unknown>).implementationPlanMd
    if (typeof implementationPlanMd !== 'string' || implementationPlanMd.trim().length === 0) {
      return { ok: true }
    }

    if (stage === 'plan') {
      const taskIds = Array.isArray(output.plan?.tasks) ? output.plan?.tasks.map((t) => t.taskId) : []
      return validateTaskIdsAgainstImplementationPlan({ implementationPlanMd, stage: 'plan', taskIds })
    }

    const taskIds = Array.isArray(output.workerDispatch) ? output.workerDispatch.map((d) => d.taskId) : []
    return validateTaskIdsAgainstImplementationPlan({ implementationPlanMd, stage: 'act', taskIds })
  }

  private async runWorkerStageValidated(input: {
    run: RunRecord
    task: AgentTask
    stage: LoopStage
    iteration: number
    attempt: number
  }): Promise<AgentResult> {
    const maxMalformedRetries = input.run.orchestrationPackage.runPolicy.retries.maxMalformedOutputRetries

    for (let malformedAttempt = 1; malformedAttempt <= maxMalformedRetries + 1; malformedAttempt += 1) {
      const rawResult = await this.withTimeout(
        this.adapter.runWorkerStage(input),
        input.run.orchestrationPackage.runPolicy.timeouts.workerTaskMs,
        'worker_timeout',
      )
      const validation = validateResult(rawResult)

      if (validation.ok && validation.value) {
        return validation.value
      }

      this.emit(input.run.id, 'agent.output.invalid', {
        runId: input.run.id,
        actor: 'worker',
        taskId: input.task.taskId,
        stage: input.stage,
        malformedAttempt,
        errors: validation.errors,
      })
    }

    throw new PolicyError('worker_output_invalid', 'worker output invalid after retries')
  }

  private async runWorkerDispatches(
    run: RunRecord,
    orchestratorIteration: number,
    workerDispatches: Array<{
      taskId: string
      workerProfile: string
      inputs: Record<string, unknown>
      acceptance: string[]
      requiredEvidence: AgentTask['requiredEvidence'][number]['type'][]
    }>,
  ): Promise<AgentResult[]> {
    if (workerDispatches.length === 0) {
      return []
    }

    const concurrency = run.orchestrationPackage.runPolicy.concurrency.maxWorkers
    const pending = [...workerDispatches]
    const results: AgentResult[] = []

    const workers: Promise<void>[] = []
    for (let i = 0; i < Math.min(concurrency, pending.length); i += 1) {
      workers.push(
        (async () => {
          while (pending.length > 0) {
            const dispatch = pending.shift()
            if (!dispatch) {
              return
            }
            const result = await this.executeWorkerTask(run, orchestratorIteration, dispatch)
            results.push(result)
          }
        })(),
      )
    }

    await Promise.all(workers)
    return results
  }

  private async executeWorkerTask(
    run: RunRecord,
    orchestratorIteration: number,
    dispatch: {
      taskId: string
      workerProfile: string
      inputs: Record<string, unknown>
      acceptance: string[]
      requiredEvidence: AgentTask['requiredEvidence'][number]['type'][]
    },
  ): Promise<AgentResult> {
    const pkg: OrchestrationPackage = run.orchestrationPackage
    const task: AgentTask = {
      taskId: dispatch.taskId,
      runId: run.id,
      assignedBy: {
        agent: 'orchestrator',
        iteration: orchestratorIteration,
      },
      workerProfile: {
        name: dispatch.workerProfile,
        model: pkg.agents.worker.model,
      },
      dependencies: [],
      loop: {
        maxIterations: pkg.runPolicy.limits.maxWorkerIterations,
        currentIteration: 1,
        allowedStages: ['plan', 'act', 'check', 'fix', 'report'],
      },
      objective: pkg.objective.description,
      inputs: dispatch.inputs,
      constraints: {
        timeoutMs: pkg.runPolicy.timeouts.workerTaskMs,
        budgetTokens: pkg.runPolicy.budget.maxTokens,
        allowedSkills: pkg.registries.skills
          .map((skill) => (typeof skill.name === 'string' ? skill.name : null))
          .filter((value): value is string => value !== null),
      },
      acceptance: dispatch.acceptance.map((description, index) => ({ id: `acc_${index + 1}`, description })),
      requiredEvidence: dispatch.requiredEvidence.map((type) => ({
        type,
        description: `${type} evidence required`,
        required: true,
      })),
      outputFormat: 'AgentResult.schema.json',
    }

    const taskValidation = validateTask(task)
    if (!taskValidation.ok) {
      throw new PolicyError('task_invalid', `worker task invalid: ${JSON.stringify(taskValidation.errors)}`)
    }

    const maxRetries = pkg.runPolicy.retries.maxWorkerTaskRetries
    let latestResult: AgentResult | null = null

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      this.repository.upsertTask(task, 'running', attempt - 1)
      this.emit(run.id, 'worker.task.started', { runId: run.id, taskId: task.taskId, attempt })

      const gitManager = this.gitManagers.get(run.id) ?? null
      const agentId = `agent_${task.taskId}`
      if (gitManager) {
        await gitManager.ensureAgentWorktree(agentId).catch((error) => {
          this.emit(run.id, 'git.error', {
            runId: run.id,
            message: error instanceof Error ? error.message : 'failed to create worktree',
            agentId,
          })
        })
      }

      let attemptFailed = false

      for (let iteration = 1; iteration <= task.loop.maxIterations; iteration += 1) {
        for (const stage of workerStages) {
          try {
            latestResult = await this.runWorkerStageValidated({ run, task, stage, iteration, attempt })
          } catch (error) {
            if (error instanceof PolicyError && (error.code === 'worker_output_invalid' || error.code === 'worker_timeout')) {
              attemptFailed = true
              this.emit(run.id, 'worker.task.stage_failed', {
                runId: run.id,
                taskId: task.taskId,
                stage,
                reason: error.code,
              })
              break
            }
            throw error
          }

          this.repository.saveResult(latestResult)
          this.repository.updateBudgetUsage(run.id, latestResult.metrics.tokensUsed, latestResult.metrics.costUsd)
          this.enforceRunPolicy(run)

          if (stage === 'check' || stage === 'report') {
            const gate = validateEvidence(
              task.requiredEvidence.map((requiredEvidence) => requiredEvidence.type),
              latestResult.evidence,
            )

            if (!gate.passed) {
              this.emit(run.id, 'worker.evidence.missing', {
                runId: run.id,
                taskId: task.taskId,
                missingTypes: gate.missingTypes,
                issues: gate.issues,
              })

              latestResult = {
                ...latestResult,
                status: 'needs_fix',
                next: {
                  recommendedStage: 'fix',
                  reason: 'evidence_missing',
                },
              }
            }
          }

          this.emit(run.id, `worker.${stage}.completed`, {
            runId: run.id,
            taskId: task.taskId,
            status: latestResult.status,
          })

          if (stage === 'report' && latestResult.status === 'succeeded') {
            this.repository.upsertTask(task, 'succeeded', attempt - 1)
            this.emit(run.id, 'worker.task.completed', { runId: run.id, taskId: task.taskId, status: 'succeeded' })

            if (gitManager) {
              try {
                const lane = await gitManager.ensureAgentWorktree(agentId)
                const commitMessage = `worker(${task.taskId}): complete task`
                const commit = await gitManager.commitAll(agentId, commitMessage)
                if (commit) {
                  gitManager.enqueueMerge(lane.branch, gitManager.getIntegrationBranch(), agentId)
                } else {
                  this.emit(run.id, 'git.commit.skipped', {
                    runId: run.id,
                    agentId,
                    branch: lane.branch,
                    reason: 'no_changes',
                  })
                }
              } catch (error) {
                this.emit(run.id, 'git.error', {
                  runId: run.id,
                  message: error instanceof Error ? error.message : 'git commit failed',
                  agentId,
                })
              }
            }

            return latestResult
          }

          if (latestResult.status === 'failed') {
            break
          }

          if (latestResult.status === 'needs_fix') {
            latestResult = await this.runWorkerStageValidated({
              run,
              task,
              stage: 'fix',
              iteration,
              attempt,
            })
            this.repository.saveResult(latestResult)
            this.emit(run.id, 'worker.fix.completed', {
              runId: run.id,
              taskId: task.taskId,
              status: latestResult.status,
            })
            break
          }
        }

        if (attemptFailed) {
          break
        }
      }

      if (attempt <= maxRetries) {
        this.repository.upsertTask(task, 'retrying', attempt)
        this.emit(run.id, 'worker.task.retry', {
          runId: run.id,
          taskId: task.taskId,
          retry: attempt,
        })
      }
    }

    const failedResult = latestResult ?? {
      resultId: `result_${randomUUID()}`,
      taskId: task.taskId,
      runId: run.id,
      agentRole: 'worker',
      workerId: `worker_${task.taskId}`,
      iteration: {
        index: 1,
        max: task.loop.maxIterations,
        attempt: maxRetries + 1,
      },
      stage: 'report' as const,
      status: 'failed' as const,
      summary: 'Worker failed after retries.',
      checks: [],
      evidence: [],
      artifacts: [],
      metrics: {
        durationMs: 0,
        tokensUsed: 0,
        costUsd: 0,
      },
      next: {
        recommendedStage: 'end' as const,
        reason: 'retries_exhausted',
      },
    }

    this.repository.saveResult(failedResult)
    this.repository.upsertTask(task, 'failed', maxRetries)
    this.emit(run.id, 'worker.task.completed', { runId: run.id, taskId: task.taskId, status: 'failed' })
    return failedResult
  }

  private emit(runId: string, type: string, data: Record<string, unknown>): void {
    const event = this.repository.appendEvent(runId, type, data)
    this.sseHub.publish(event)
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorCode: string): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new PolicyError(errorCode, `${errorCode} after ${timeoutMs}ms`))
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }
  }
}
