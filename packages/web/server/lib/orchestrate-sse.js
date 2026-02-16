export function normalizeOrchestrateBaseUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function parseSseBlock(block) {
  if (!block || typeof block !== 'string') {
    return null;
  }

  let id = null;
  let event = null;
  const dataLines = [];

  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('id:')) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^\s/, ''));
    }
  }

  if (dataLines.length === 0) {
    return {
      id,
      event,
      data: null,
      rawData: '',
    };
  }

  const rawData = dataLines.join('\n').trim();
  if (!rawData) {
    return {
      id,
      event,
      data: null,
      rawData,
    };
  }

  try {
    return {
      id,
      event,
      data: JSON.parse(rawData),
      rawData,
    };
  } catch {
    return {
      id,
      event,
      data: null,
      rawData,
    };
  }
}

export function normalizeOrchestrateEventFrame(block, runId, fallbackEventId) {
  const parsed = parseSseBlock(block);
  const data = parsed?.data;
  const payload = data && typeof data === 'object'
    ? data
    : parsed?.rawData
      ? { raw: parsed.rawData }
      : {};

  const candidateType =
    typeof parsed?.event === 'string' && parsed.event.length > 0
      ? parsed.event
      : typeof payload.type === 'string' && payload.type.length > 0
        ? payload.type
        : 'orchestrate.unknown';

  const candidateId =
    (typeof parsed?.id === 'string' && parsed.id.length > 0
      ? parsed.id
      : Number.isFinite(payload.eventId)
        ? String(payload.eventId)
        : typeof payload.id === 'string' && payload.id.length > 0
          ? payload.id
          : `${fallbackEventId}`);

  const candidateTs =
    typeof payload.ts === 'string' || typeof payload.ts === 'number'
      ? payload.ts
      : typeof payload.createdAt === 'string'
        ? payload.createdAt
        : Date.now();

  return {
    id: candidateId,
    ts: candidateTs,
    type: candidateType,
    runId: typeof payload.runId === 'string' && payload.runId.length > 0 ? payload.runId : runId,
    payload,
  };
}
