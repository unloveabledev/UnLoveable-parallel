import type { Response } from 'express'
import type { RunEvent } from './types.js'

export class SseHub {
  private readonly subscribers = new Map<string, Set<Response>>()

  subscribe(runId: string, response: Response): () => void {
    const set = this.subscribers.get(runId) ?? new Set<Response>()
    set.add(response)
    this.subscribers.set(runId, set)

    return () => {
      const current = this.subscribers.get(runId)
      if (!current) {
        return
      }

      current.delete(response)
      if (current.size === 0) {
        this.subscribers.delete(runId)
      }
    }
  }

  publish(event: RunEvent): void {
    const set = this.subscribers.get(event.runId)
    if (!set || set.size === 0) {
      return
    }

    const payload = this.formatEvent(event)
    for (const response of set) {
      response.write(payload)
    }
  }

  publishPing(runId: string): void {
    const set = this.subscribers.get(runId)
    if (!set || set.size === 0) {
      return
    }

    const frame = `event: ping\ndata: {"runId":"${runId}"}\n\n`
    for (const response of set) {
      response.write(frame)
    }
  }

  private formatEvent(event: RunEvent): string {
    return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
  }
}
