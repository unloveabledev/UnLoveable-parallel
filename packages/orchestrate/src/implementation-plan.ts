export type ValidationIssue = {
  path: string
  message: string
}

export function parseImplementationPlanChecklistIds(markdown: string): string[] {
  const text = String(markdown || '')
  const ids: string[] = []
  const seen = new Set<string>()

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    // Matches:
    // - [ ] T1 Do thing
    // * [x] T2: Another thing
    const match = line.match(/^(?:[-*])\s+\[(?: |x|X)\]\s+([A-Za-z][A-Za-z0-9_-]{0,31})(?:\b|:)/)
    if (!match) continue
    const id = match[1]
    if (!id) continue
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  return ids
}

export function validateTaskIdsAgainstImplementationPlan(input: {
  implementationPlanMd: string
  stage: 'plan' | 'act'
  taskIds: string[]
}): { ok: true } | { ok: false; errors: ValidationIssue[] } {
  const ids = parseImplementationPlanChecklistIds(input.implementationPlanMd)
  if (ids.length === 0) {
    return { ok: true }
  }

  const allowed = new Set(ids)
  const errors: ValidationIssue[] = []

  for (let i = 0; i < input.taskIds.length; i += 1) {
    const taskId = String(input.taskIds[i] || '').trim()
    if (!taskId) {
      errors.push({
        path: `${input.stage}.${input.stage === 'plan' ? 'plan.tasks' : 'workerDispatch'}[${i}].taskId`,
        message: 'taskId is empty',
      })
      continue
    }
    if (!allowed.has(taskId)) {
      errors.push({
        path: `${input.stage}.${input.stage === 'plan' ? 'plan.tasks' : 'workerDispatch'}[${i}].taskId`,
        message: `taskId "${taskId}" is not present in IMPLEMENTATION_PLAN.md checklist ids (${ids.join(', ')})`,
      })
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true }
}
