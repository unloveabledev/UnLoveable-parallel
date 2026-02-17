import { describe, expect, it } from 'bun:test'

import { parseImplementationPlanChecklistIds, validateTaskIdsAgainstImplementationPlan } from './implementation-plan.js'

describe('implementation plan parsing', () => {
  it('extracts checklist ids', () => {
    const md = [
      '# Implementation Plan',
      '',
      '- [ ] T1 Do the thing',
      '- [x] T2: Another thing',
      '* [ ] X_3 Extra',
      '- Not a task',
    ].join('\n')

    expect(parseImplementationPlanChecklistIds(md)).toEqual(['T1', 'T2', 'X_3'])
  })

  it('validates task ids against checklist', () => {
    const md = ['- [ ] T1 One', '- [ ] T2 Two'].join('\n')
    const ok = validateTaskIdsAgainstImplementationPlan({ implementationPlanMd: md, stage: 'plan', taskIds: ['T1', 'T2'] })
    expect(ok.ok).toBe(true)

    const bad = validateTaskIdsAgainstImplementationPlan({ implementationPlanMd: md, stage: 'act', taskIds: ['T1', 'task_1'] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.length).toBe(1)
      expect(bad.errors[0].message.includes('IMPLEMENTATION_PLAN.md')).toBe(true)
    }
  })
})
