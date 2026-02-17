import { describe, expect, it } from 'bun:test'

import { generateSpecBundle } from './spec.js'
import type { OpenCodeAdapter } from './opencode-adapter.js'

describe('spec generation', () => {
  it('returns a multi-document spec bundle and orchestration package', async () => {
    const calls: string[] = []

    const adapter = new (class implements OpenCodeAdapter {
      kind = 'opencode' as const
      async createSession(): Promise<{ sessionId: string }> {
        return { sessionId: 'sess_test' }
      }
      async cancelSession(): Promise<void> {
        return
      }
      async runOrchestratorStage(): Promise<never> {
        throw new Error('not used')
      }
      async runWorkerStage(): Promise<never> {
        throw new Error('not used')
      }

      // Used by generateSpecBundle via a narrow type-cast.
      async sendPromptAndWaitForText(input: { text: string }): Promise<string> {
        calls.push(input.text)

        if (input.text.includes('"promptMd"') && input.text.includes('"uiSpecMd"')) {
          return JSON.stringify({
            promptMd: '# Prompt\n\nDo the thing.',
            specMd: '# Spec\n\nScope: ...\n\nAcceptance Criteria: ...',
            uiSpecMd: '# UI Spec\n\nScreens: ...',
            title: 'Test Objective',
            description: 'Test Description',
            doneCriteria: ['Feature works end-to-end'],
          })
        }

        if (input.text.includes('"architecturePlanMd"')) {
          return JSON.stringify({ architecturePlanMd: '# Architecture\n\nPlan.' })
        }

        if (input.text.includes('"registryMd"')) {
          return JSON.stringify({
            registryMd: '# Registry\n\n- variables: []\n- functions: []',
            registries: { variables: [], functions: [] },
          })
        }

        if (input.text.includes('"implementationPlanMd"')) {
          return JSON.stringify({
            implementationPlanMd: '# Implementation Plan\n\n- [ ] T1 Implement feature\n- [ ] T2 Add tests',
          })
        }

        throw new Error('unexpected prompt')
      }
    })()

    const result = await generateSpecBundle({
      adapter,
      prompt: 'Add a button',
      model: 'opencode/big-pickle',
      context: { directory: '/tmp' },
    })

    expect(typeof result.specId).toBe('string')
    expect(Array.isArray(result.documents)).toBe(true)
    expect(result.documents.some((d) => d.path === 'PROMPT.md')).toBe(true)
    expect(result.documents.some((d) => d.path === 'SPEC.md')).toBe(true)
    expect(result.documents.some((d) => d.path === 'UI_SPEC.md')).toBe(true)
    expect(result.documents.some((d) => d.path === 'ARCHITECTURE_PLAN.md')).toBe(true)
    expect(result.documents.some((d) => d.path === 'REGISTRY.md')).toBe(true)
    expect(result.documents.some((d) => d.path === 'IMPLEMENTATION_PLAN.md')).toBe(true)
    expect(result.documents.some((d) => d.path === 'ORCHESTRATION_PACKAGE.json')).toBe(true)

    const pkg = result.orchestrationPackage as unknown as { objective?: { inputs?: Record<string, unknown> } }
    expect(typeof pkg.objective?.inputs?.specMd).toBe('string')
    expect(typeof pkg.objective?.inputs?.implementationPlanMd).toBe('string')

    expect(calls.length).toBeGreaterThanOrEqual(4)
  })
})
