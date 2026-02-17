import * as React from 'react';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { navigateToRoute } from '@/hooks/useRouter';
import { toast } from '@/components/ui';
import { AnimatedTabs } from '@/components/ui/animated-tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  orchestrateCancelRun,
  orchestrateGetRun,
  orchestrateGetPreview,
  orchestrateStartPreview,
  orchestrateStopPreview,
  orchestrateSubscribeEvents,
  type OrchestrateNormalizedEvent,
  type OrchestrateRunSnapshot,
  type OrchestratePreviewStatus,
} from '@/lib/orchestrate/client';
import { createRunEventState, reduceRunEvent, type RunEventState } from '@/lib/orchestrate/runEvents';
import { PreviewCard } from '@/components/orchestrate/PreviewCard';
import { GitSwarmPanel } from '@/components/orchestrate/GitSwarmPanel';

const formatTs = (ts: string | number): string => {
  try {
    const ms = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!Number.isFinite(ms)) return String(ts);
    return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  } catch {
    return String(ts);
  }
};

const isPreviewableUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
};

const tryPrettyJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

type OrchestratorStage = 'plan' | 'act' | 'check' | 'fix' | 'report';

const isOrchestratorStage = (value: unknown): value is OrchestratorStage =>
  value === 'plan' || value === 'act' || value === 'check' || value === 'fix' || value === 'report';

const getOrchestratorOutput = (event: OrchestrateNormalizedEvent): Record<string, unknown> | null => {
  if (!event.payload || typeof event.payload !== 'object') return null;
  const payload = event.payload as Record<string, unknown>;
  const output = payload.output;
  if (!output || typeof output !== 'object') return null;
  return output as Record<string, unknown>;
};

export const RunMonitorView: React.FC = () => {
  const runId = useUIStore((s) => s.activeRunId);
  const setActiveRunId = useUIStore((s) => s.setActiveRunId);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);

  const [run, setRun] = React.useState<OrchestrateRunSnapshot | null>(null);
  const [eventsState, setEventsState] = React.useState<RunEventState>(() => createRunEventState());
  const [streamStatus, setStreamStatus] = React.useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [selectedDetails, setSelectedDetails] = React.useState<{ title: string; value: unknown } | null>(null);
  const [livePreview, setLivePreview] = React.useState<OrchestratePreviewStatus | null>(null);

  type MonitorTab =
    | 'dashboard'
    | 'timeline'
    | 'orchestrator'
    | 'swarm'
    | 'gitSwarm'
    | 'artifacts'
    | 'preview'
    | 'git';

  const [activeTab, setActiveTab] = React.useState<MonitorTab>('dashboard');

  const loadRun = React.useCallback(async (id: string) => {
    const snapshot = await orchestrateGetRun(id);
    setRun(snapshot);
  }, []);

  const loadPreview = React.useCallback(async (id: string) => {
    const status = await orchestrateGetPreview(id);
    setLivePreview(status);
  }, []);

  React.useEffect(() => {
    if (!runId) {
      setRun(null);
      setEventsState(createRunEventState());
      setStreamStatus('idle');
      setActiveTab('dashboard');
      return;
    }

    let cancelled = false;

    setStreamStatus('connecting');
    void loadRun(runId).catch((error) => {
      if (cancelled) return;
      toast.error(error instanceof Error ? error.message : 'Failed to load run');
    });

    void loadPreview(runId).catch(() => {
      // ignore
    });

    const unsubscribe = orchestrateSubscribeEvents(runId, {
      onOpen: () => {
        if (cancelled) return;
        setStreamStatus('connected');
      },
      onEvent: (event: OrchestrateNormalizedEvent) => {
        if (cancelled) return;
        setEventsState((state) => reduceRunEvent(state, event));
      },
      onError: () => {
        if (cancelled) return;
        setStreamStatus('error');
      },
    });

    const poll = window.setInterval(() => {
      void loadRun(runId).catch(() => {
        // ignore
      });
      void loadPreview(runId).catch(() => {
        // ignore
      });
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      unsubscribe();
    };
  }, [loadPreview, loadRun, runId]);

  React.useEffect(() => {
    // When preview becomes ready, automatically jump to the Preview tab once.
    if (livePreview?.state === 'ready') {
      setActiveTab((prev) => (prev === 'dashboard' ? 'preview' : prev));
    }
  }, [livePreview?.state]);

  React.useEffect(() => {
    if (!runId) return;
    const last = eventsState.events[eventsState.events.length - 1];
    if (!last) return;
    if (last.type.startsWith('preview.')) {
      void loadPreview(runId).catch(() => {
        // ignore
      });
    }
  }, [eventsState.events, loadPreview, runId]);

  const handleBack = React.useCallback(() => {
    setActiveRunId(null);
    setActiveMainTab('chat');
    navigateToRoute({ tab: 'chat', runId: null });
  }, [setActiveMainTab, setActiveRunId]);

  const handleCancel = React.useCallback(async () => {
    if (!runId) return;
    try {
      const updated = await orchestrateCancelRun(runId);
      setRun(updated);
      toast.success('Cancel requested');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Cancel failed');
    }
  }, [runId]);

  const artifacts = React.useMemo(() => (Array.isArray(run?.artifacts) ? run?.artifacts : []), [run?.artifacts]);
  const evidence = React.useMemo(() => (Array.isArray(run?.evidence) ? run?.evidence : []), [run?.evidence]);
  const tasks = React.useMemo(() => (Array.isArray(run?.tasks) ? run?.tasks : []), [run?.tasks]);

  const orchestratorByStage = React.useMemo(() => {
    const latest: Partial<Record<OrchestratorStage, OrchestrateNormalizedEvent>> = {};
    for (const evt of eventsState.events) {
      if (!evt.type.startsWith('orchestrator.') || !evt.type.endsWith('.completed')) continue;
      const parts = evt.type.split('.');
      const stage = parts[1];
      if (!isOrchestratorStage(stage)) continue;
      latest[stage] = evt;
    }
    return latest;
  }, [eventsState.events]);

  React.useEffect(() => {
    if (previewUrl) return;
    for (const item of artifacts) {
      if (!item || typeof item !== 'object') continue;
      const uri = (item as Record<string, unknown>).uri;
      const next = isPreviewableUrl(uri);
      if (next) {
        setPreviewUrl(next);
        return;
      }
    }
  }, [artifacts, previewUrl]);

  if (!runId) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="max-w-lg text-center space-y-2">
          <div className="typography-ui-header font-semibold text-foreground">Run Monitor</div>
          <div className="typography-meta text-muted-foreground">
            No run selected. Start a Simple/Advanced Auto run to open a monitor.
          </div>
        </div>
      </div>
    );
  }

  const status = run?.status ?? 'unknown';

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Button type="button" variant="secondary" onClick={handleBack}>
            Back
          </Button>
          <div className="min-w-0">
            <div className="typography-ui-label text-foreground truncate">{runId}</div>
            <div className="typography-micro text-muted-foreground">
              Status: <span className="font-mono">{status}</span> · SSE: <span className="font-mono">{streamStatus}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => void loadRun(runId)}>
            Refresh
          </Button>
          <Button type="button" onClick={handleCancel} disabled={status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'timed_out'}>
            Cancel
          </Button>
        </div>
      </div>

      <div className="border-b border-border px-3 py-2">
        <AnimatedTabs<MonitorTab>
          value={activeTab}
          onValueChange={setActiveTab}
          size="sm"
          collapseLabelsOnSmall
          collapseLabelsOnNarrow
          tabs={[
            { value: 'dashboard', label: 'Dashboard' },
            { value: 'timeline', label: 'Timeline' },
            { value: 'orchestrator', label: 'Orchestrator' },
            { value: 'swarm', label: 'Swarm' },
            { value: 'gitSwarm', label: 'Git Swarm' },
            { value: 'artifacts', label: 'Artifacts' },
            { value: 'preview', label: 'Preview' },
            { value: 'git', label: 'Git' },
          ]}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full p-3">
          {activeTab === 'dashboard' ? (
            <Dashboard
              runId={runId}
              status={status}
              streamStatus={streamStatus}
              eventsCount={eventsState.events.length}
              tasksCount={tasks.length}
              artifactsCount={artifacts.length}
              evidenceCount={evidence.length}
              previewState={livePreview?.state ?? 'stopped'}
            />
          ) : null}

          {activeTab === 'timeline' ? (
            <Card title="Timeline" subtitle={`${eventsState.events.length} events`}>
              <ScrollableOverlay outerClassName="h-full" className="h-full">
                <div className="space-y-1">
                  {eventsState.events.map((evt) => (
                    <button
                      key={evt.id}
                      type="button"
                      className={cn(
                        'w-full text-left rounded-md border border-border px-2 py-1 transition-colors',
                        'bg-[var(--surface-elevated)] hover:bg-[var(--interactive-hover)]'
                      )}
                      onClick={() => setSelectedDetails({ title: `${evt.type} (event ${evt.id})`, value: evt })}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 typography-micro text-foreground truncate">
                          <span className="font-mono text-muted-foreground">{evt.id}</span> · <span className="font-mono">{evt.type}</span>
                        </div>
                        <div className="typography-micro text-muted-foreground font-mono shrink-0">{formatTs(evt.ts)}</div>
                      </div>
                    </button>
                  ))}
                  {eventsState.events.length === 0 ? (
                    <div className="typography-meta text-muted-foreground">Waiting for events…</div>
                  ) : null}
                </div>
              </ScrollableOverlay>
            </Card>
          ) : null}

          {activeTab === 'orchestrator' ? (
            <Card title="Orchestrator" subtitle="PLAN → ACT → CHECK → FIX → REPORT">
              <ScrollableOverlay outerClassName="h-full" className="h-full">
                <div className="space-y-1">
                  {(['plan', 'act', 'check', 'fix', 'report'] as OrchestratorStage[]).map((stage) => {
                    const evt = orchestratorByStage[stage];
                    if (!evt) {
                      return (
                        <div key={stage} className="rounded-md border border-border bg-[var(--surface-elevated)] px-2 py-1">
                          <div className="typography-micro text-muted-foreground font-mono">{stage.toUpperCase()} · waiting…</div>
                        </div>
                      );
                    }
                    const output = getOrchestratorOutput(evt);
                    const summary = output && typeof output.summary === 'string' ? output.summary : null;
                    const stageStatus = output && typeof output.status === 'string' ? output.status : null;
                    return (
                      <button
                        key={stage}
                        type="button"
                        className={cn(
                          'w-full text-left rounded-md border border-border px-2 py-1 transition-colors',
                          'bg-[var(--surface-elevated)] hover:bg-[var(--interactive-hover)]'
                        )}
                        onClick={() => setSelectedDetails({ title: `Orchestrator ${stage.toUpperCase()}`, value: output ?? evt })}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="typography-micro text-foreground font-mono truncate">{stage.toUpperCase()}</div>
                          <div className="typography-micro text-muted-foreground font-mono shrink-0">{stageStatus ?? 'completed'}</div>
                        </div>
                        {summary ? <div className="typography-micro text-muted-foreground line-clamp-2">{summary}</div> : null}
                      </button>
                    );
                  })}
                </div>
              </ScrollableOverlay>
            </Card>
          ) : null}

          {activeTab === 'swarm' ? (
            <Card title="Swarm" subtitle={`${tasks.length} tasks`}>
              <ScrollableOverlay outerClassName="h-full" className="h-full">
                <div className="space-y-1">
                  {tasks.map((task, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={cn(
                        'w-full text-left rounded-md border border-border px-2 py-1 transition-colors',
                        'bg-[var(--surface-elevated)] hover:bg-[var(--interactive-hover)]'
                      )}
                      onClick={() => setSelectedDetails({ title: 'Task', value: task })}
                    >
                      <div className="typography-micro text-foreground font-mono truncate">
                        {String((task as Record<string, unknown>)?.taskId ?? 'task')} · {String((task as Record<string, unknown>)?.status ?? 'unknown')}
                      </div>
                    </button>
                  ))}
                  {tasks.length === 0 ? <div className="typography-meta text-muted-foreground">No tasks yet.</div> : null}
                </div>
              </ScrollableOverlay>
            </Card>
          ) : null}

          {activeTab === 'gitSwarm' ? (
            <Card title="Git Swarm" subtitle="Branches, commits, merges">
              <ScrollableOverlay outerClassName="h-full" className="h-full">
                <GitSwarmPanel events={eventsState.events} onSelect={(title, value) => setSelectedDetails({ title, value })} />
              </ScrollableOverlay>
            </Card>
          ) : null}

          {activeTab === 'artifacts' ? (
            <Card title="Artifacts" subtitle={`${artifacts.length} artifacts · ${evidence.length} evidence`}>
              <ScrollableOverlay outerClassName="h-full" className="h-full">
                <div className="space-y-1">
                  {artifacts.map((artifact, idx) => {
                    if (!artifact || typeof artifact !== 'object') return null;
                    const uri = (artifact as Record<string, unknown>).uri;
                    const preview = isPreviewableUrl(uri);
                    return (
                      <button
                        key={idx}
                        type="button"
                        className={cn(
                          'w-full text-left rounded-md border border-border px-2 py-1 transition-colors',
                          'bg-[var(--surface-elevated)] hover:bg-[var(--interactive-hover)]'
                        )}
                        onClick={() => {
                          if (preview) setPreviewUrl(preview);
                          setSelectedDetails({ title: `Artifact ${(artifact as Record<string, unknown>).kind ?? 'artifact'}`, value: artifact });
                        }}
                      >
                        <div className="typography-micro text-foreground font-mono truncate">
                          {String((artifact as Record<string, unknown>).kind ?? 'artifact')} · {String(uri ?? '')}
                        </div>
                      </button>
                    );
                  })}
                  {artifacts.length === 0 ? <div className="typography-meta text-muted-foreground">No artifacts yet.</div> : null}
                </div>
              </ScrollableOverlay>
            </Card>
          ) : null}

          {activeTab === 'preview' ? (
            <Card title="Preview" subtitle={livePreview?.state ? `state: ${livePreview.state}` : 'Not available'}>
              <PreviewCard
                runId={runId}
                status={livePreview}
                iframeSrc={`/api/orchestrate/runs/${encodeURIComponent(runId)}/preview/`}
                onRefresh={() => void loadPreview(runId)}
                onStart={() => {
                  void orchestrateStartPreview(runId)
                    .then((next) => setLivePreview(next))
                    .catch((error) => toast.error(error instanceof Error ? error.message : 'Failed to start preview'));
                }}
                onStop={() => {
                  void orchestrateStopPreview(runId)
                    .then((next) => setLivePreview(next))
                    .catch((error) => toast.error(error instanceof Error ? error.message : 'Failed to stop preview'));
                }}
              />
            </Card>
          ) : null}

          {activeTab === 'git' ? (
            <Card title="Git" subtitle="Diff-related evidence">
              <ScrollableOverlay outerClassName="h-full" className="h-full">
                <div className="space-y-1">
                  {evidence
                    .filter((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).type ?? '') === 'diff')
                    .map((item, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className={cn(
                          'w-full text-left rounded-md border border-border px-2 py-1 transition-colors',
                          'bg-[var(--surface-elevated)] hover:bg-[var(--interactive-hover)]'
                        )}
                        onClick={() => setSelectedDetails({ title: 'Diff evidence', value: item })}
                      >
                        <div className="typography-micro text-foreground font-mono truncate">{String((item as Record<string, unknown>).uri ?? '')}</div>
                      </button>
                    ))}
                  {evidence.filter((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).type ?? '') === 'diff').length === 0 ? (
                    <div className="typography-meta text-muted-foreground">No diff evidence yet.</div>
                  ) : null}
                </div>
              </ScrollableOverlay>
            </Card>
          ) : null}
        </div>
      </div>

      <Dialog open={Boolean(selectedDetails)} onOpenChange={(open) => { if (!open) setSelectedDetails(null); }}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-auto" keyboardAvoid>
          <DialogHeader>
            <DialogTitle>{selectedDetails?.title ?? 'Details'}</DialogTitle>
            <DialogDescription>Event / artifact details (read-only).</DialogDescription>
          </DialogHeader>
          <pre className="whitespace-pre-wrap rounded-md border border-border bg-[var(--syntax-base-background)] p-3 text-xs text-[var(--syntax-base-foreground)]">
            {tryPrettyJson(selectedDetails?.value)}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const Card: React.FC<{ title: string; subtitle?: string; children: React.ReactNode }> = ({ title, subtitle, children }) => {
  return (
    <div className="h-full min-h-0 flex flex-col gap-2 rounded-md border border-border bg-[var(--surface-muted)] p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="typography-ui-label font-semibold text-foreground">{title}</div>
        {subtitle ? <div className="typography-micro text-muted-foreground font-mono truncate">{subtitle}</div> : null}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
};

const Dashboard: React.FC<{
  runId: string;
  status: string;
  streamStatus: string;
  eventsCount: number;
  tasksCount: number;
  artifactsCount: number;
  evidenceCount: number;
  previewState: string;
}> = ({ runId, status, streamStatus, eventsCount, tasksCount, artifactsCount, evidenceCount, previewState }) => {
  return (
    <div className="h-full min-h-0 grid gap-3 grid-cols-1 md:grid-cols-2">
      <StatCard label="Run" value={runId} mono />
      <StatCard label="Status" value={`${status} · SSE ${streamStatus}`} mono />
      <StatCard label="Timeline" value={`${eventsCount} events`} />
      <StatCard label="Swarm" value={`${tasksCount} tasks`} />
      <StatCard label="Artifacts" value={`${artifactsCount} artifacts`} />
      <StatCard label="Evidence" value={`${evidenceCount} evidence`} />
      <StatCard label="Live Preview" value={previewState} mono />
      <div className="rounded-md border border-border bg-[var(--surface-muted)] p-3">
        <div className="typography-ui-label font-semibold text-foreground">What to look for</div>
        <div className="typography-meta text-muted-foreground">
          Open Timeline for events, Preview for the iframe/logs, Git Swarm for worktrees/merges.
        </div>
      </div>
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => {
  return (
    <div className="rounded-md border border-border bg-[var(--surface-muted)] p-3">
      <div className="typography-micro text-muted-foreground">{label}</div>
      <div className={cn('typography-ui-label text-foreground truncate', mono ? 'font-mono' : null)}>{value}</div>
    </div>
  );
};
