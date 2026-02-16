import type { EvidenceItem, EvidenceType, RunRecord } from './types.js'

export class PolicyError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface EvidenceGateResult {
  passed: boolean
  missingTypes: EvidenceType[]
  issues: string[]
}

export function validateEvidence(requiredTypes: EvidenceType[], evidence: EvidenceItem[]): EvidenceGateResult {
  const issues: string[] = []
  const present = new Set<EvidenceType>()

  for (const item of evidence) {
    if (!item.uri || !item.hash || item.hash.length < 8) {
      issues.push(`evidence ${item.evidenceId} missing uri/hash integrity`)
      continue
    }
    present.add(item.type)
  }

  const missingTypes = requiredTypes.filter((requiredType) => !present.has(requiredType))
  return {
    passed: missingTypes.length === 0 && issues.length === 0,
    missingTypes,
    issues,
  }
}

export function ensureRunNotCanceled(run: RunRecord): void {
  if (run.cancelRequested) {
    throw new PolicyError('run_canceled', 'run cancellation requested')
  }
}

export function ensureWithinWallClock(run: RunRecord): void {
  if (!run.startedAt) {
    return
  }

  const startedAtMs = Date.parse(run.startedAt)
  const elapsed = Date.now() - startedAtMs
  if (elapsed > run.orchestrationPackage.runPolicy.limits.maxRunWallClockMs) {
    throw new PolicyError('wall_clock_exceeded', 'run exceeded max wall-clock')
  }
}

export function ensureWithinBudget(run: RunRecord): void {
  const budget = run.orchestrationPackage.runPolicy.budget
  if (run.budgetTokensUsed > budget.maxTokens) {
    throw new PolicyError('budget_tokens_exceeded', 'token budget exceeded')
  }
  if (run.budgetCostUsed > budget.maxCostUsd) {
    throw new PolicyError('budget_cost_exceeded', 'cost budget exceeded')
  }
}
