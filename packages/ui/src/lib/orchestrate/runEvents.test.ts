import { describe, expect, it } from 'bun:test';

import { createRunEventState, reduceRunEvent } from './runEvents';

describe('runEvents reducer', () => {
  it('dedupes by id', () => {
    const s0 = createRunEventState();
    const e = { id: '1', ts: 0, type: 'x', runId: 'r', payload: {} };
    const s1 = reduceRunEvent(s0, e);
    const s2 = reduceRunEvent(s1, e);
    expect(s2.events.length).toBe(1);
  });

  it('sorts numerically when possible', () => {
    let s = createRunEventState();
    s = reduceRunEvent(s, { id: '10', ts: 0, type: 'a', runId: 'r', payload: {} });
    s = reduceRunEvent(s, { id: '2', ts: 0, type: 'b', runId: 'r', payload: {} });
    expect(s.events.map((e) => e.id)).toEqual(['2', '10']);
  });
});
