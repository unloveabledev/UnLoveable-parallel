export type OrchestrateSpecDocument = {
  path: string;
  title: string;
  content: string;
};

export type OrchestrateSpecResponse = {
  specId: string;
  createdAt: string;
  documents: OrchestrateSpecDocument[];
  orchestrationPackage: unknown;
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

export async function orchestrateGenerateSpec(input: { prompt: string; model: string }): Promise<OrchestrateSpecResponse> {
  return fetchJson<OrchestrateSpecResponse>('/api/orchestrate/spec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: input.prompt, model: input.model }),
  });
}
