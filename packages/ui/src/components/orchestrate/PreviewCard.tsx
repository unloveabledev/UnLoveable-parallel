import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { OrchestratePreviewStatus } from '@/lib/orchestrate/client';

export const PreviewCard: React.FC<{
  runId: string;
  status: OrchestratePreviewStatus | null;
  iframeSrc: string;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
}> = ({ runId, status, iframeSrc, onStart, onStop, onRefresh }) => {
  const state = status?.state ?? 'stopped';
  const logs = Array.isArray(status?.logsTail) ? status?.logsTail : [];
  const hasIframe = state === 'ready';

  return (
    <div className="h-full min-h-0 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="typography-ui-label text-foreground">Live Preview</div>
          <div className="typography-micro text-muted-foreground font-mono truncate">
            {runId} · {state}
            {status?.port ? ` · port ${status.port}` : ''}
          </div>
          {status?.error ? (
            <div className="typography-micro text-[var(--status-error)]">{status.error}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button type="button" variant="secondary" onClick={onRefresh}>
            Refresh
          </Button>
          {state === 'ready' || state === 'starting' ? (
            <Button type="button" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button type="button" onClick={onStart}>
              Start
            </Button>
          )}
        </div>
      </div>

      {hasIframe ? (
        <div className="min-h-0 flex-1 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="typography-micro text-muted-foreground font-mono truncate">{iframeSrc}</div>
            <a
              href={iframeSrc}
              target="_blank"
              rel="noreferrer"
              className="typography-micro text-foreground hover:underline"
            >
              Open
            </a>
          </div>
          <iframe
            title="live-preview"
            src={iframeSrc}
            className={cn('flex-1 min-h-0 w-full rounded-md border border-border bg-[var(--surface-elevated)]')}
          />
        </div>
      ) : (
        <div className="typography-meta text-muted-foreground">
          {state === 'starting' ? 'Starting preview…' : 'Preview is not running.'}
        </div>
      )}

      {logs.length > 0 ? (
        <pre className="max-h-[160px] overflow-auto rounded-md border border-border bg-[var(--syntax-base-background)] p-2 text-xs text-[var(--syntax-base-foreground)]">
          {logs.join('\n')}
        </pre>
      ) : null}
    </div>
  );
};
