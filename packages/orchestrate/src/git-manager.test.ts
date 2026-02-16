import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

import { GitManager } from './git-manager.js'

const runGit = (cwd: string, args: string[]) => {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8')
}

describe('GitManager', () => {
  it('creates worktrees, commits, and emits merge conflict deterministically', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrate-git-test-'))
    const worktreesRoot = path.join(repoDir, '.orchestrate-worktrees', 'run_1')

    runGit(repoDir, ['init', '-b', 'main'])
    runGit(repoDir, ['config', 'user.name', 'Test'])
    runGit(repoDir, ['config', 'user.email', 'test@example.com'])

    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'base\n', 'utf8')
    runGit(repoDir, ['add', '-A'])
    runGit(repoDir, ['commit', '-m', 'base'])

    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const emit = (type: string, data: Record<string, unknown>) => events.push({ type, data })

    const gm = new GitManager(
      {
        runId: 'run_1',
        repoPath: repoDir,
        worktreesRoot,
        baseBranch: 'main',
        integrationBranch: 'oc/integration/run_1',
        requireChecks: [],
        identity: { userName: 'Test', userEmail: 'test@example.com', sshCommand: null },
      },
      emit,
    )

    await gm.init()

    const a1 = await gm.ensureAgentWorktree('agent_1')
    const a2 = await gm.ensureAgentWorktree('agent_2')

    fs.writeFileSync(path.join(a1.path, 'file.txt'), 'agent1\n', 'utf8')
    fs.writeFileSync(path.join(a2.path, 'file.txt'), 'agent2\n', 'utf8')

    await gm.commitAll('agent_1', 'c1')
    await gm.commitAll('agent_2', 'c2')

    gm.enqueueMerge(a1.branch, gm.getIntegrationBranch(), 'agent_1')
    gm.enqueueMerge(a2.branch, gm.getIntegrationBranch(), 'agent_2')

    await gm.processMergeQueue()

    const mergeResults = events.filter((e) => e.type === 'git.merge.result')
    expect(mergeResults.length).toBeGreaterThanOrEqual(1)
    expect(mergeResults[0].data.status).toBe('success')
    // Second merge should conflict due to overlapping edits.
    expect(mergeResults.some((r) => r.data.status === 'conflict')).toBe(true)
  })
})
