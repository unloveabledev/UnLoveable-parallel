import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export type GitIdentity = {
  userName: string | null
  userEmail: string | null
  sshCommand: string | null
}

export type GitManagerConfig = {
  runId: string
  repoPath: string
  worktreesRoot: string
  baseBranch: string
  integrationBranch: string
  requireChecks: string[]
  identity: GitIdentity
}

export type GitWorktreeLane = {
  agentId: string
  branch: string
  path: string
}

export type GitManagerEventEmitter = (type: string, data: Record<string, unknown>) => void

type MergeItem = {
  fromBranch: string
  intoBranch: string
  agentId?: string | null
}

export class GitManager {
  private readonly emit: GitManagerEventEmitter
  private readonly cfg: GitManagerConfig
  private readonly lanes = new Map<string, GitWorktreeLane>()
  private readonly mergeQueue: MergeItem[] = []
  private integrationWorktreePath: string | null = null

  constructor(config: GitManagerConfig, emit: GitManagerEventEmitter) {
    this.cfg = config
    this.emit = emit
  }

  async init(): Promise<void> {
    ensureDir(this.cfg.worktreesRoot)

    await this.assertGitRepo()

    // Ensure integration worktree.
    const integrationPath = path.join(this.cfg.worktreesRoot, 'integration')
    this.integrationWorktreePath = integrationPath
    await this.ensureIntegrationWorktree(integrationPath)
  }

  getIntegrationBranch(): string {
    return this.cfg.integrationBranch
  }

  async ensureAgentWorktree(agentId: string): Promise<GitWorktreeLane> {
    const existing = this.lanes.get(agentId)
    if (existing) {
      return existing
    }

    const branch = `oc/${this.cfg.runId}/${sanitizeRef(agentId)}`
    const worktreePath = path.join(this.cfg.worktreesRoot, sanitizePathSegment(agentId))

    // Create from integration branch head so merges are deterministic.
    await this.git(['worktree', 'add', '-B', branch, worktreePath, this.cfg.integrationBranch], this.cfg.repoPath)
    await this.configureIdentity(worktreePath)

    const lane: GitWorktreeLane = { agentId, branch, path: worktreePath }
    this.lanes.set(agentId, lane)
    this.emit('git.worktree.created', {
      runId: this.cfg.runId,
      agentId,
      branch,
      path: worktreePath,
    })
    return lane
  }

  async getTouchedFiles(worktreePath: string): Promise<string[]> {
    const out = await this.git(['diff', '--name-only'], worktreePath)
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  }

  async commitAll(agentId: string, message: string): Promise<{ sha: string; files: string[] } | null> {
    const lane = this.lanes.get(agentId)
    if (!lane) {
      return null
    }

    await this.git(['add', '-A'], lane.path)
    const files = (await this.git(['diff', '--cached', '--name-only'], lane.path))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)

    if (files.length === 0) {
      return null
    }

    await this.git(['commit', '-m', message], lane.path)
    const sha = (await this.git(['rev-parse', 'HEAD'], lane.path)).trim()

    this.emit('git.files.touched', {
      runId: this.cfg.runId,
      agentId,
      files,
    })

    this.emit('git.commit', {
      runId: this.cfg.runId,
      agentId,
      branch: lane.branch,
      sha,
      message,
      files,
    })

    return { sha, files }
  }

  enqueueMerge(fromBranch: string, intoBranch: string, agentId?: string | null): void {
    this.mergeQueue.push({ fromBranch, intoBranch, agentId: agentId ?? null })
    this.emit('git.merge.queued', {
      runId: this.cfg.runId,
      fromBranch,
      intoBranch,
    })
  }

  async processMergeQueue(): Promise<void> {
    const integrationPath = this.integrationWorktreePath
    if (!integrationPath) {
      throw new Error('GitManager not initialized')
    }

    while (this.mergeQueue.length > 0) {
      const item = this.mergeQueue.shift()
      if (!item) {
        break
      }

      this.emit('git.merge.attempt', {
        runId: this.cfg.runId,
        fromBranch: item.fromBranch,
        intoBranch: item.intoBranch,
      })

      const result = await this.tryMerge(integrationPath, item.fromBranch)
      this.emit('git.merge.result', {
        runId: this.cfg.runId,
        fromBranch: item.fromBranch,
        intoBranch: item.intoBranch,
        status: result.status,
        conflicts: result.conflicts,
      })

      if (result.status !== 'success') {
        return
      }

      if (this.cfg.requireChecks.length > 0) {
        const ok = await this.runChecks(integrationPath)
        if (!ok) {
          this.emit('git.merge.result', {
            runId: this.cfg.runId,
            fromBranch: item.fromBranch,
            intoBranch: item.intoBranch,
            status: 'failed',
            conflicts: [],
          })
          return
        }
      }
    }
  }

  async cleanup(): Promise<void> {
    // Remove agent worktrees.
    for (const lane of this.lanes.values()) {
      await this.safeWorktreeRemove(lane.path)
    }
    this.lanes.clear()

    if (this.integrationWorktreePath) {
      await this.safeWorktreeRemove(this.integrationWorktreePath)
      this.integrationWorktreePath = null
    }

    await this.git(['worktree', 'prune'], this.cfg.repoPath).catch(() => {})
  }

  private async assertGitRepo(): Promise<void> {
    const out = await this.git(['rev-parse', '--is-inside-work-tree'], this.cfg.repoPath)
    if (!out.trim().includes('true')) {
      throw new Error(`Not a git repository: ${this.cfg.repoPath}`)
    }
  }

  private async ensureIntegrationWorktree(integrationPath: string): Promise<void> {
    // Ensure base branch exists locally.
    await this.git(['fetch', '--all', '--prune'], this.cfg.repoPath).catch(() => {})

    // Create/update integration branch at base.
    await this.git(['branch', '-f', this.cfg.integrationBranch, this.cfg.baseBranch], this.cfg.repoPath).catch(() => {})

    if (fs.existsSync(integrationPath)) {
      // Best-effort: ensure it is pointing to the right branch.
      await this.git(['checkout', this.cfg.integrationBranch], integrationPath).catch(() => {})
      await this.configureIdentity(integrationPath)
      return
    }

    await this.git(['worktree', 'add', '-B', this.cfg.integrationBranch, integrationPath, this.cfg.baseBranch], this.cfg.repoPath)
    await this.configureIdentity(integrationPath)
  }

  private async configureIdentity(worktreePath: string): Promise<void> {
    if (this.cfg.identity.userName) {
      await this.git(['config', 'user.name', this.cfg.identity.userName], worktreePath)
    }
    if (this.cfg.identity.userEmail) {
      await this.git(['config', 'user.email', this.cfg.identity.userEmail], worktreePath)
    }
  }

  private async tryMerge(integrationPath: string, fromBranch: string): Promise<{ status: 'success' | 'conflict' | 'failed'; conflicts: string[] }> {
    try {
      await this.git(['merge', '--no-ff', '--no-edit', fromBranch], integrationPath)
      return { status: 'success', conflicts: [] }
    } catch {
      const conflicts = await this.git(['diff', '--name-only', '--diff-filter=U'], integrationPath)
        .catch(() => '')
        .then((raw) => raw.split('\n').map((l) => l.trim()).filter(Boolean))

      await this.git(['merge', '--abort'], integrationPath).catch(() => {})

      if (conflicts.length > 0) {
        return { status: 'conflict', conflicts }
      }
      return { status: 'failed', conflicts: [] }
    }
  }

  private async runChecks(cwd: string): Promise<boolean> {
    for (const cmd of this.cfg.requireChecks) {
      const ok = await runShellCommand(cmd, cwd)
      if (!ok) {
        return false
      }
    }
    return true
  }

  private async safeWorktreeRemove(worktreePath: string): Promise<void> {
    // git worktree remove is executed from the main repo.
    await this.git(['worktree', 'remove', '--force', worktreePath], this.cfg.repoPath).catch(() => {})
  }

  private git(args: string[], cwd: string): Promise<string> {
    const env: Record<string, string> = {
      ...process.env,
      ...(this.cfg.identity.sshCommand ? { GIT_SSH_COMMAND: this.cfg.identity.sshCommand } : {}),
      ...(this.cfg.identity.userName ? { GIT_AUTHOR_NAME: this.cfg.identity.userName, GIT_COMMITTER_NAME: this.cfg.identity.userName } : {}),
      ...(this.cfg.identity.userEmail ? { GIT_AUTHOR_EMAIL: this.cfg.identity.userEmail, GIT_COMMITTER_EMAIL: this.cfg.identity.userEmail } : {}),
    }

    return runGitCommand(args, cwd, env)
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function sanitizeRef(input: string): string {
  return input
    .trim()
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .slice(0, 80) || 'agent'
}

function sanitizePathSegment(input: string): string {
  return input.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64) || 'agent'
}

async function runGitCommand(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(stderr.trim() || `git ${args.join(' ')} failed`))
      }
    })
  })
}

async function runShellCommand(command: string, cwd: string): Promise<boolean> {
  if (!command.trim()) {
    return true
  }
  const parts = command.split(' ').filter(Boolean)
  const bin = parts[0]
  const args = parts.slice(1)
  return await new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: 'ignore' })
    child.once('close', (code) => resolve(code === 0))
    child.once('error', () => resolve(false))
  })
}
