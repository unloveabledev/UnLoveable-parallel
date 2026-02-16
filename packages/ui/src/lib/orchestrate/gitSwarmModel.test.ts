import { describe, expect, it } from 'bun:test';

import { buildGitSwarmModel } from './gitSwarmModel';

describe('gitSwarmModel', () => {
  it('builds lanes from events', () => {
    const model = buildGitSwarmModel([
      { id: '1', ts: 0, type: 'git.worktree.created', runId: 'r', payload: { agentId: 'a1', branch: 'b1', path: '/tmp/b1' } },
      { id: '2', ts: 0, type: 'git.commit', runId: 'r', payload: { agentId: 'a1', branch: 'b1', sha: 'abc', message: 'm', files: ['x'] } },
      { id: '3', ts: 0, type: 'git.merge.result', runId: 'r', payload: { fromBranch: 'b1', intoBranch: 'integration', status: 'success' } },
    ]);

    expect(Object.keys(model.lanes)).toEqual(['b1']);
    expect(model.lanes['b1'].commits.length).toBe(1);
    expect(model.merges.length).toBe(1);
  });
});
