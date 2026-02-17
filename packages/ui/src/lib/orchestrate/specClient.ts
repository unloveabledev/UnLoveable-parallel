export type OrchestrateSpecDocument = {
  path: string;
  title: string;
  content: string;
};

export type OrchestrateSpecQuestion = {
  id: string;
  prompt: string;
  kind: 'short_text' | 'long_text';
  optional?: boolean;
  placeholder?: string;
};

export type OrchestrateFollowupResponse = {
  questions: OrchestrateSpecQuestion[];
};

export type OrchestrateSpecResponse = {
  specId: string;
  createdAt: string;
  questions?: OrchestrateSpecQuestion[];
  documents: OrchestrateSpecDocument[];
  orchestrationPackage: unknown;
};

export type OrchestrateSpecProgressEvent = {
  phase: string;
  message: string;
  percent: number;
};

export type OrchestrateDocAssistResponse = {
  docs: {
    promptMd: string;
    specMd: string;
    uiSpecMd: string;
    architecturePlanMd: string;
    registryMd: string;
    implementationPlanMd: string;
  };
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

export async function orchestrateGenerateSpec(input: { prompt: string; model: string; answers?: Record<string, string>; context?: Record<string, unknown> }): Promise<OrchestrateSpecResponse> {
  return fetchJson<OrchestrateSpecResponse>('/api/orchestrate/spec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: input.prompt,
      model: input.model,
      answers: input.answers ?? undefined,
      context: input.context ?? undefined,
    }),
  });
}

export async function orchestrateGenerateSpecStream(input: {
  prompt: string;
  model: string;
  answers?: Record<string, string>;
  context?: Record<string, unknown>;
  onProgress?: (event: OrchestrateSpecProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<OrchestrateSpecResponse> {
  const response = await fetch('/api/orchestrate/spec/stream', {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: input.prompt,
      model: input.model,
      answers: input.answers ?? undefined,
      context: input.context ?? undefined,
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as unknown;
    const message =
      json && typeof json === 'object' && 'error' in json
        ? String((json as { error?: { message?: unknown } }).error?.message ?? `${response.status} ${response.statusText}`)
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error('Missing response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: OrchestrateSpecResponse | null = null;
  let streamError: string | null = null;

  const handleFrame = (frame: string) => {
    const lines = frame.split('\n');
    let event = '';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    const dataText = dataLines.join('\n');
    if (!dataText) {
      return;
    }
    let data: unknown = null;
    try {
      data = JSON.parse(dataText);
    } catch {
      data = dataText;
    }

    if (event === 'spec.progress' && data && typeof data === 'object') {
      const evt = data as Partial<OrchestrateSpecProgressEvent>;
      if (typeof evt.message === 'string') {
        input.onProgress?.({
          phase: typeof evt.phase === 'string' ? evt.phase : 'unknown',
          message: evt.message,
          percent: typeof evt.percent === 'number' ? evt.percent : 0,
        });
      }
      return;
    }

    if (event === 'spec.error' && data && typeof data === 'object') {
      const msg = (data as { message?: unknown }).message;
      streamError = typeof msg === 'string' ? msg : 'Spec generation failed';
      return;
    }

    if (event === 'spec.result' && data && typeof data === 'object') {
      result = data as OrchestrateSpecResponse;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim()) {
        handleFrame(frame);
      }
      idx = buffer.indexOf('\n\n');
    }
    if (result || streamError) {
      break;
    }
  }

  if (streamError) {
    throw new Error(streamError);
  }
  if (result) {
    return result;
  }
  throw new Error('Spec generation stream ended without a result');
}

export async function orchestrateGenerateFollowup(input: { prompt: string; model: string; context?: Record<string, unknown> }): Promise<OrchestrateFollowupResponse> {
  return fetchJson<OrchestrateFollowupResponse>('/api/orchestrate/followup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: input.prompt, model: input.model, context: input.context ?? undefined }),
  });
}

export async function orchestrateDocAssist(input: {
  instruction: string;
  model: string;
  docs: {
    promptMd: string;
    specMd: string;
    uiSpecMd: string;
    architecturePlanMd: string;
    registryMd: string;
    implementationPlanMd: string;
  };
  context?: Record<string, unknown>;
}): Promise<OrchestrateDocAssistResponse> {
  return fetchJson<OrchestrateDocAssistResponse>('/api/orchestrate/doc-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instruction: input.instruction,
      model: input.model,
      docs: input.docs,
      context: input.context ?? undefined,
    }),
  });
}
