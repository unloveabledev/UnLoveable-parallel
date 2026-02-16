import type { OrchestrateNormalizedEvent } from './client';

export type RunEventState = {
  events: OrchestrateNormalizedEvent[];
};

export const createRunEventState = (): RunEventState => ({ events: [] });

const toSortableNumber = (id: string): number | null => {
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
};

export function reduceRunEvent(state: RunEventState, event: OrchestrateNormalizedEvent): RunEventState {
  if (!event || typeof event.id !== 'string' || event.id.length === 0) {
    return state;
  }
  if (state.events.some((e) => e.id === event.id)) {
    return state;
  }

  const next = [...state.events, event];

  // Prefer numeric ordering by event id when possible.
  next.sort((a, b) => {
    const an = toSortableNumber(a.id);
    const bn = toSortableNumber(b.id);
    if (an !== null && bn !== null) {
      return an - bn;
    }
    return a.id.localeCompare(b.id);
  });

  return { events: next };
}
