import { readFileSync } from 'node:fs'
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { z } from 'zod'
import type { AgentResult, AgentTask, OrchestrationPackage, OrchestratorOutput } from './types.js'

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

function loadSchema(relativePath: string): object {
  const schemaFile = new URL(relativePath, import.meta.url)
  return JSON.parse(readFileSync(schemaFile, 'utf8')) as object
}

const orchestrationPackageSchema = loadSchema('../schemas/OrchestrationPackage.schema.json')
const agentTaskSchema = loadSchema('../schemas/AgentTask.schema.json')
const agentResultSchema = loadSchema('../schemas/AgentResult.schema.json')

const validateOrchestrationPackage = ajv.compile(orchestrationPackageSchema) as ValidateFunction<OrchestrationPackage>
const validateAgentTask = ajv.compile(agentTaskSchema) as ValidateFunction<AgentTask>
const validateAgentResult = ajv.compile(agentResultSchema) as ValidateFunction<AgentResult>

const orchestratorOutputSchema = z.object({
  agentRole: z.literal('orchestrator'),
  stage: z.enum(['plan', 'act', 'check', 'fix', 'report']),
  status: z.enum(['in_progress', 'succeeded', 'failed', 'needs_fix']),
  summary: z.string().min(1),
  plan: z
    .object({
      goals: z.array(z.string()),
      tasks: z.array(
        z.object({
          taskId: z.string().min(1),
          objective: z.string().min(1),
          priority: z.enum(['high', 'medium', 'low']),
          requiredEvidence: z.array(
            z.enum(['test_result', 'log_excerpt', 'diff', 'artifact', 'metric', 'screenshot']),
          ),
          dependencies: z.array(z.string()),
        }),
      ),
    })
    .optional(),
  workerDispatch: z
    .array(
      z.object({
        taskId: z.string().min(1),
        workerProfile: z.string().min(1),
        inputs: z.record(z.string(), z.unknown()),
        acceptance: z.array(z.string()),
        requiredEvidence: z.array(
          z.enum(['test_result', 'log_excerpt', 'diff', 'artifact', 'metric', 'screenshot']),
        ),
      }),
    )
    .optional(),
  checks: z
    .array(
      z.object({
        checkId: z.string().min(1),
        passed: z.boolean(),
        reason: z.string().min(1),
      }),
    )
    .optional(),
  fixes: z
    .array(
      z.object({
        issue: z.string().min(1),
        action: z.string().min(1),
        retryTarget: z.string().min(1),
      }),
    )
    .optional(),
  report: z
    .object({
      outcome: z.enum(['succeeded', 'failed', 'partial']),
      deliverables: z.array(z.string()),
      evidenceRefs: z.array(z.string()),
      artifactRefs: z.array(z.string()),
      openRisks: z.array(z.string()),
    })
    .optional(),
  metrics: z.object({
    estimatedTokens: z.number().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
  }),
  next: z.object({
    recommendedStage: z.enum(['plan', 'act', 'check', 'fix', 'report', 'end']),
    reason: z.string().min(1),
  }),
})

export interface ValidationIssue {
  path: string
  message: string
}

export interface ValidationResult<T> {
  ok: boolean
  value?: T
  errors: ValidationIssue[]
}

function ajvErrors(validateFn: ValidateFunction): ValidationIssue[] {
  const errors = (validateFn.errors ?? []) as ErrorObject[]
  return errors.map((err) => ({
    path: err.instancePath || '/',
    message: err.message ?? 'invalid',
  }))
}

export function validatePackage(payload: unknown): ValidationResult<OrchestrationPackage> {
  const ok = validateOrchestrationPackage(payload)
  if (!ok) {
    return { ok: false, errors: ajvErrors(validateOrchestrationPackage) }
  }
  return { ok: true, value: payload as OrchestrationPackage, errors: [] }
}

export function validateTask(payload: unknown): ValidationResult<AgentTask> {
  const ok = validateAgentTask(payload)
  if (!ok) {
    return { ok: false, errors: ajvErrors(validateAgentTask) }
  }
  return { ok: true, value: payload as AgentTask, errors: [] }
}

export function validateResult(payload: unknown): ValidationResult<AgentResult> {
  const ok = validateAgentResult(payload)
  if (!ok) {
    return { ok: false, errors: ajvErrors(validateAgentResult) }
  }
  return { ok: true, value: payload as AgentResult, errors: [] }
}

export function validateOrchestratorOutput(payload: unknown): ValidationResult<OrchestratorOutput> {
  const parsed = orchestratorOutputSchema.safeParse(payload)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '/',
        message: issue.message,
      })),
    }
  }

  return { ok: true, value: parsed.data, errors: [] }
}
