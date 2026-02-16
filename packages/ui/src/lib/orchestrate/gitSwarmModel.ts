import type { OrchestrateNormalizedEvent } from './client';

export type GitCommitNode = {
  agentId: string;
  branch: string;
  sha: string;
  message: string;
  files: string[];
  eventId: string;
  ts: string | number;
};

export type GitMergeEdge = {
  fromBranch: string;
  intoBranch: string;
  status: 'queued' | 'attempt' | 'success' | 'conflict' | 'failed';
  conflicts: string[];
  eventId: string;
  ts: string | number;
};

export type GitSwarmModel = {
  lanes: Record<string, { agentId: string; branch: string; path?: string | null; commits: GitCommitNode[]; filesTouched: string[] }>;
  merges: GitMergeEdge[];
};

export const createGitSwarmModel = (): GitSwarmModel => ({ lanes: {}, merges: [] });

const asObj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function buildGitSwarmModel(events: OrchestrateNormalizedEvent[]): GitSwarmModel {
  const model: GitSwarmModel = createGitSwarmModel();

  for (const evt of events) {
    if (!evt.type.startsWith('git.')) continue;
    const payload = asObj(evt.payload) ?? {};

    if (evt.type === 'git.worktree.created') {
      const agentId = String(payload.agentId ?? 'agent');
      const branch = String(payload.branch ?? agentId);
      const path = typeof payload.path === 'string' ? payload.path : null;
      const key = branch;
      const lane = model.lanes[key] ?? { agentId, branch, path, commits: [], filesTouched: [] };
      model.lanes[key] = { ...lane, agentId, branch, path };
      continue;
    }

    if (evt.type === 'git.files.touched') {
      const agentId = String(payload.agentId ?? 'agent');
      const files = Array.isArray(payload.files) ? payload.files.map(String) : [];
      // Best-effort: lane by agent id.
      const existingKey = Object.keys(model.lanes).find((k) => model.lanes[k]?.agentId === agentId) ?? agentId;
      const lane = model.lanes[existingKey] ?? { agentId, branch: existingKey, path: null, commits: [], filesTouched: [] };
      const merged = Array.from(new Set([...lane.filesTouched, ...files]));
      model.lanes[existingKey] = { ...lane, filesTouched: merged };
      continue;
    }

    if (evt.type === 'git.commit') {
      const agentId = String(payload.agentId ?? 'agent');
      const branch = String(payload.branch ?? agentId);
      const sha = String(payload.sha ?? '');
      const message = String(payload.message ?? '');
      const files = Array.isArray(payload.files) ? payload.files.map(String) : [];
      const key = branch;
      const lane = model.lanes[key] ?? { agentId, branch, path: null, commits: [], filesTouched: [] };
      lane.commits.push({ agentId, branch, sha, message, files, eventId: evt.id, ts: evt.ts });
      model.lanes[key] = lane;
      continue;
    }

    if (evt.type === 'git.merge.queued' || evt.type === 'git.merge.attempt' || evt.type === 'git.merge.result') {
      const fromBranch = String(payload.fromBranch ?? '');
      const intoBranch = String(payload.intoBranch ?? '');
      const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts.map(String) : [];
      let status: GitMergeEdge['status'] = 'queued';
      if (evt.type === 'git.merge.attempt') status = 'attempt';
      if (evt.type === 'git.merge.result') {
        const s = String(payload.status ?? 'failed');
        status = s === 'success' ? 'success' : s === 'conflict' ? 'conflict' : 'failed';
      }
      model.merges.push({ fromBranch, intoBranch, status, conflicts, eventId: evt.id, ts: evt.ts });
      continue;
    }
  }

  // Sort commits by event id (numeric when possible).
  for (const lane of Object.values(model.lanes)) {
    lane.commits.sort((a, b) => Number(a.eventId) - Number(b.eventId));
  }

  return model;
}
