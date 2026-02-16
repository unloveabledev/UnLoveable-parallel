import * as React from 'react';
import { cn } from '@/lib/utils';
import type { OrchestrateNormalizedEvent } from '@/lib/orchestrate/client';
import { buildGitSwarmModel } from '@/lib/orchestrate/gitSwarmModel';

export const GitSwarmPanel: React.FC<{
  events: OrchestrateNormalizedEvent[];
  onSelect: (title: string, value: unknown) => void;
}> = ({ events, onSelect }) => {
  const model = React.useMemo(() => buildGitSwarmModel(events), [events]);
  const lanes = Object.values(model.lanes);

  if (lanes.length === 0 && model.merges.length === 0) {
    return <div className="typography-meta text-muted-foreground">No git swarm activity yet.</div>;
  }

  return (
    <div className="space-y-3">
      {lanes.map((lane) => (
        <div key={lane.branch} className="rounded-md border border-border bg-[var(--surface-elevated)] p-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className="typography-ui-label text-foreground font-mono truncate">{lane.branch}</div>
            <div className="typography-micro text-muted-foreground font-mono truncate">{lane.agentId}</div>
          </div>
          {lane.path ? <div className="typography-micro text-muted-foreground font-mono truncate">{lane.path}</div> : null}
          {lane.filesTouched.length > 0 ? (
            <div className="typography-micro text-muted-foreground mt-1">Touched: {lane.filesTouched.slice(0, 6).join(', ')}{lane.filesTouched.length > 6 ? '…' : ''}</div>
          ) : null}

          <div className="mt-2 space-y-1">
            {lane.commits.map((c) => (
              <button
                key={c.sha + c.eventId}
                type="button"
                className={cn(
                  'w-full text-left rounded-md border border-border px-2 py-1 transition-colors',
                  'bg-[var(--surface-background)] hover:bg-[var(--interactive-hover)]'
                )}
                onClick={() => onSelect(`Commit ${c.sha}`, c)}
              >
                <div className="typography-micro text-foreground font-mono truncate">{c.sha} · {c.message || 'commit'}</div>
                {c.files.length > 0 ? (
                  <div className="typography-micro text-muted-foreground font-mono truncate">
                    {c.files.slice(0, 4).join(', ')}{c.files.length > 4 ? '…' : ''}
                  </div>
                ) : null}
              </button>
            ))}
            {lane.commits.length === 0 ? (
              <div className="typography-micro text-muted-foreground">No commits yet.</div>
            ) : null}
          </div>
        </div>
      ))}

      {model.merges.length > 0 ? (
        <div className="rounded-md border border-border bg-[var(--surface-elevated)] p-2">
          <div className="typography-ui-label text-foreground">Merges</div>
          <div className="mt-2 space-y-1">
            {model.merges.map((m) => (
              <button
                key={m.eventId}
                type="button"
                className={cn(
                  'w-full text-left rounded-md border border-border px-2 py-1 transition-colors',
                  'bg-[var(--surface-background)] hover:bg-[var(--interactive-hover)]'
                )}
                onClick={() => onSelect(`Merge ${m.fromBranch} -> ${m.intoBranch}`, m)}
              >
                <div className="typography-micro text-foreground font-mono truncate">
                  {m.fromBranch} → {m.intoBranch} · {m.status}
                </div>
                {m.conflicts.length > 0 ? (
                  <div className="typography-micro text-[var(--status-warning)] font-mono truncate">
                    Conflicts: {m.conflicts.join(', ')}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};
