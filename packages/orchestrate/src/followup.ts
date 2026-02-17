import { z } from 'zod'
import type { OpenCodeAdapter } from './opencode-adapter.js'
import type { RunRecord } from './types.js'

export type FollowupQuestion = {
  id: string
  prompt: string
  kind: 'short_text' | 'long_text'
  optional?: boolean
  placeholder?: string
}

export type FollowupResponse = {
  questions: FollowupQuestion[]
}

const followupSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        prompt: z.string().min(1),
        kind: z.enum(['short_text', 'long_text']),
        optional: z.boolean().optional(),
        placeholder: z.string().optional(),
      }),
    )
    .max(5),
})

export async function generateFollowups(input: {
  adapter: OpenCodeAdapter
  run: RunRecord
  model: { providerID: string; modelID: string }
  directory: string | null
  prompt: string
}): Promise<FollowupResponse> {
  const { sessionId } = await input.adapter.createSession(input.run)
  const runWithSession = { ...input.run, sessionId }

  try {
    // We rely on OpenCode adapter to support text prompting; in practice this will be OpenCodeHttpAdapter.
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
      return { questions: [] }
    }

    const text = await adapterAny.sendPromptAndWaitForText({
      sessionId,
      directory: input.directory,
      model: input.model,
      agentName: 'build',
      timeoutMs: 30_000,
      text: buildFollowupPrompt(input.prompt),
    })

    const parsed = parseJson(text)
    const validated = followupSchema.safeParse(parsed)
    if (!validated.success) {
      return { questions: [] }
    }

    // Deduplicate + normalize.
    const seen = new Set<string>()
    const questions = validated.data.questions
      .map((q) => ({
        ...q,
        id: q.id.trim(),
        prompt: q.prompt.trim(),
        placeholder: typeof q.placeholder === 'string' ? q.placeholder : undefined,
      }))
      .filter((q) => {
        if (!q.id || seen.has(q.id)) return false
        seen.add(q.id)
        return true
      })

    return { questions }
  } finally {
    if (runWithSession.sessionId) {
      await input.adapter.cancelSession(runWithSession.sessionId).catch(() => null)
    }
  }
}

function buildFollowupPrompt(userPrompt: string): string {
  return [
    'You are helping generate a project spec. Ask targeted follow-up questions ONLY if needed.',
    '',
    'Return EXACTLY one JSON object, no code fences, no extra keys:',
    '{ "questions": Array<{"id": string, "prompt": string, "kind": "short_text"|"long_text", "optional"?: boolean, "placeholder"?: string}> }',
    '',
    'Rules:',
    '- Ask 0-5 questions max.',
    '- Questions must be prompt-specific and high-signal.',
    '- If the prompt is sufficiently specific, return an empty questions array.',
    '- Prefer questions that reduce ambiguity in deliverables, scope, and validation.',
    '- Use stable ids (snake_case).',
    '',
    'User prompt:',
    userPrompt.trim(),
  ].join('\n')
}

function parseJson(text: string): unknown {
  const trimmed = String(text || '').trim()
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  const slice = first !== -1 && last !== -1 && last > first ? trimmed.slice(first, last + 1) : trimmed
  return JSON.parse(slice)
}
