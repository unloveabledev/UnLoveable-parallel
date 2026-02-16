import { randomUUID } from 'node:crypto'

export type GitEventEmitter = (type: string, data: Record<string, unknown>) => void

export type GitSwarmConfig = {
  enabled: boolean
  baseBranch: string
  integrationBranch: string
}

type AgentLane = {
  agentId: string
  branch: string
  worktreePath: string
  touchedFiles: Set<string>
}

type MergeItem = {
  fromBranch: string
  intoBranch: string
}

export class GitSwarmManager {
  private readonly emit: GitEventEmitter
  private readonly lanesByRun = new Map<string, Map<string, AgentLane>>()
  private readonly mergeQueues = new Map<string, MergeItem[]>()

  constructor(emit: GitEventEmitter) {
    this.emit = emit
  }

  initRun(runId: string, config: GitSwarmConfig): void {
    if (!config.enabled) return
    if (!this.lanesByRun.has(runId)) {
      this.lanesByRun.set(runId, new Map())
      this.mergeQueues.set(runId, [])
    }
    // Integration lane is implicit (no worktree path in MVP).
    this.emit('git.merge.queued', {
      runId,
      fromBranch: config.baseBranch,
      intoBranch: config.integrationBranch,
    })
  }

  ensureAgentLane(runId: string, agentId: string, branch: string, worktreePath: string): AgentLane {
    const lanes = this.lanesByRun.get(runId) ?? new Map()
    this.lanesByRun.set(runId, lanes)

    const existing = lanes.get(agentId)
    if (existing) {
      return existing
    }

    const lane: AgentLane = {
      agentId,
      branch,
      worktreePath,
      touchedFiles: new Set(),
    }
    lanes.set(agentId, lane)

    this.emit('git.worktree.created', {
      runId,
      agentId,
      branch,
      path: worktreePath,
    })

    return lane
  }

  recordTouchedFiles(runId: string, agentId: string, files: string[]): void {
    const lanes = this.lanesByRun.get(runId)
    const lane = lanes?.get(agentId)
    if (!lane) return

    for (const file of files) {
      if (file && typeof file === 'string') lane.touchedFiles.add(file)
    }

    this.emit('git.files.touched', {
      runId,
      agentId,
      files: files.filter((f) => typeof f === 'string' && f.length > 0),
    })
  }

  commit(runId: string, agentId: string, message: string): { sha: string; branch: string; files: string[] } | null {
    const lanes = this.lanesByRun.get(runId)
    const lane = lanes?.get(agentId)
    if (!lane) return null

    const sha = randomUUID().replaceAll('-', '').slice(0, 12)
    const files = Array.from(lane.touchedFiles)

    this.emit('git.commit', {
      runId,
      agentId,
      branch: lane.branch,
      sha,
      message,
      files,
    })

    return { sha, branch: lane.branch, files }
  }

  enqueueMerge(runId: string, fromBranch: string, intoBranch: string): void {
    const queue = this.mergeQueues.get(runId) ?? []
    this.mergeQueues.set(runId, queue)
    queue.push({ fromBranch, intoBranch })
    this.emit('git.merge.queued', { runId, fromBranch, intoBranch })
  }

  // MVP: deterministic merge queue that always succeeds.
  processMergeQueue(runId: string): void {
    const queue = this.mergeQueues.get(runId) ?? []
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) break
      this.emit('git.merge.attempt', { runId, fromBranch: item.fromBranch, intoBranch: item.intoBranch })
      this.emit('git.merge.result', { runId, fromBranch: item.fromBranch, intoBranch: item.intoBranch, status: 'success' })
    }
  }
}
