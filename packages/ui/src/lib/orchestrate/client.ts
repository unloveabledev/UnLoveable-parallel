export type OrchestrateNormalizedEvent = {
  id: string;
  ts: string | number;
  type: string;
  runId: string;
  payload: unknown;
};

export type OrchestrateRunSnapshot = {
  id: string;
  status: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  reason?: string | null;
  latestEventId?: string | null;
  summary?: { objective?: string; reason?: string | null };
  counters?: Record<string, unknown>;
  tasks?: unknown[];
  results?: unknown[];
  evidence?: unknown[];
  artifacts?: unknown[];
};

export type OrchestratePreviewStatus = {
  state: 'stopped' | 'starting' | 'ready' | 'error';
  runId: string;
  url: string | null;
  port: number | null;
  proxiedPath: string;
  startedAt: string | null;
  stoppedAt: string | null;
  error: string | null;
  logsTail?: string[];
};

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const json = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    const message =
      (json && typeof json === 'object' && 'error' in json && (json as { error?: { message?: unknown } }).error?.message)
        ? String((json as { error?: { message?: unknown } }).error?.message)
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  if (!json) {
    throw new Error('Empty response');
  }
  return json;
}

export async function orchestrateCreateRun(pkg: unknown): Promise<OrchestrateRunSnapshot> {
  return fetchJson<OrchestrateRunSnapshot>('/api/orchestrate/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pkg ?? {}),
  });
}

export async function orchestrateGetRun(runId: string): Promise<OrchestrateRunSnapshot> {
  const id = runId.trim();
  return fetchJson<OrchestrateRunSnapshot>(`/api/orchestrate/runs/${encodeURIComponent(id)}`, { method: 'GET' });
}

export async function orchestrateCancelRun(runId: string): Promise<OrchestrateRunSnapshot> {
  const id = runId.trim();
  return fetchJson<OrchestrateRunSnapshot>(`/api/orchestrate/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

export async function orchestrateGetPreview(runId: string): Promise<OrchestratePreviewStatus> {
  const id = runId.trim();
  return fetchJson<OrchestratePreviewStatus>(`/api/orchestrate/runs/${encodeURIComponent(id)}/preview`, { method: 'GET' });
}

export async function orchestrateStartPreview(runId: string): Promise<OrchestratePreviewStatus> {
  const id = runId.trim();
  return fetchJson<OrchestratePreviewStatus>(`/api/orchestrate/runs/${encodeURIComponent(id)}/preview/start`, { method: 'POST' });
}

export async function orchestrateStopPreview(runId: string): Promise<OrchestratePreviewStatus> {
  const id = runId.trim();
  return fetchJson<OrchestratePreviewStatus>(`/api/orchestrate/runs/${encodeURIComponent(id)}/preview/stop`, { method: 'POST' });
}

export function orchestrateSubscribeEvents(
  runId: string,
  handlers: {
    onEvent: (event: OrchestrateNormalizedEvent) => void;
    onError?: (error: unknown) => void;
    onOpen?: () => void;
  }
): () => void {
  const id = runId.trim();
  const source = new EventSource(`/api/orchestrate/runs/${encodeURIComponent(id)}/events`);

  const onMessage = (evt: MessageEvent) => {
    try {
      const parsed = JSON.parse(String(evt.data ?? 'null')) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return;
      }
      const obj = parsed as Record<string, unknown>;
      const eventId = typeof obj.id === 'string' ? obj.id : null;
      const type = typeof obj.type === 'string' ? obj.type : null;
      const run = typeof obj.runId === 'string' ? obj.runId : id;
      const ts = typeof obj.ts === 'string' || typeof obj.ts === 'number' ? (obj.ts as string | number) : Date.now();
      if (!eventId || !type) {
        return;
      }
      handlers.onEvent({ id: eventId, ts, type, runId: run, payload: obj.payload });
    } catch (error) {
      handlers.onError?.(error);
    }
  };

  const onError = (err: Event) => {
    handlers.onError?.(err);
  };

  const onOpen = () => {
    handlers.onOpen?.();
  };

  source.addEventListener('message', onMessage as EventListener);
  source.addEventListener('error', onError as EventListener);
  source.addEventListener('open', onOpen as EventListener);

  return () => {
    try {
      source.removeEventListener('message', onMessage as EventListener);
      source.removeEventListener('error', onError as EventListener);
      source.removeEventListener('open', onOpen as EventListener);
      source.close();
    } catch {
      // ignore
    }
  };
}
