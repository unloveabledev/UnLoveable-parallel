import { z } from 'zod'
import type { OpenCodeAdapter } from './opencode-adapter.js'
import type { RunRecord } from './types.js'

export type DocAssistRequest = {
  instruction: string
  directory: string | null
  model: { providerID: string; modelID: string }
  docs: {
    promptMd: string
    specMd: string
    uiSpecMd: string
    architecturePlanMd: string
    registryMd: string
    implementationPlanMd: string
  }
}

export type DocAssistResponse = {
  docs: {
    promptMd: string
    specMd: string
    uiSpecMd: string
    architecturePlanMd: string
    registryMd: string
    implementationPlanMd: string
  }
}

const responseSchema = z.object({
  docs: z.object({
    promptMd: z.string().min(1),
    specMd: z.string().min(1),
    uiSpecMd: z.string().min(1),
    architecturePlanMd: z.string().min(1),
    registryMd: z.string().min(1),
    implementationPlanMd: z.string().min(1),
  }),
})

export async function assistDocs(input: {
  adapter: OpenCodeAdapter
  run: RunRecord
  request: DocAssistRequest
}): Promise<DocAssistResponse> {
  const { sessionId } = await input.adapter.createSession(input.run)
  const runWithSession = { ...input.run, sessionId }

  try {
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
      throw new Error('Adapter does not support doc assist')
    }

    const text = await adapterAny.sendPromptAndWaitForText({
      sessionId,
      directory: input.request.directory,
      model: input.request.model,
      agentName: 'build',
      timeoutMs: 90_000,
      text: buildDocAssistPrompt(input.request),
    })

    const parsed = parseJsonLoose(text)
    const validated = responseSchema.safeParse(parsed)
    if (!validated.success) {
      throw new Error(
        `Doc assist JSON invalid: ${validated.error.issues
          .map((i) => `${i.path.join('.') || '/'} ${i.message}`)
          .join('; ')}`,
      )
    }
    return validated.data
  } finally {
    if (runWithSession.sessionId) {
      await input.adapter.cancelSession(runWithSession.sessionId).catch(() => null)
    }
  }
}

function buildDocAssistPrompt(req: DocAssistRequest): string {
  return [
    'You are an assistant helping refine a multi-document spec bundle for an autonomous coding orchestrator.',
    'Return STRICT JSON only. No code fences. No extra keys.',
    '',
    'You must return exactly:',
    '{"docs": {"promptMd": string, "specMd": string, "uiSpecMd": string, "architecturePlanMd": string, "registryMd": string, "implementationPlanMd": string}}',
    '',
    'Rules:',
    '- Only change what is necessary to satisfy the instruction.',
    '- Keep IDs stable where possible (done_*, T1/T2 checklist ids).',
    '- Keep implementationPlanMd as a checklist with [ ] items and stable ids.',
    '- Do not remove required sections; add missing details if needed.',
    '',
    'Instruction:',
    req.instruction.trim(),
    '',
    'Current PROMPT.md:',
    req.docs.promptMd,
    '',
    'Current SPEC.md:',
    req.docs.specMd,
    '',
    'Current UI_SPEC.md:',
    req.docs.uiSpecMd,
    '',
    'Current ARCHITECTURE_PLAN.md:',
    req.docs.architecturePlanMd,
    '',
    'Current REGISTRY.md:',
    req.docs.registryMd,
    '',
    'Current IMPLEMENTATION_PLAN.md:',
    req.docs.implementationPlanMd,
  ].join('\n')
}

function parseJsonLoose(text: string): unknown {
  const trimmed = String(text || '').trim()
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  const slice = first !== -1 && last !== -1 && last > first ? trimmed.slice(first, last + 1) : trimmed
  return JSON.parse(slice)
}
