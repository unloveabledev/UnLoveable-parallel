import { describe, expect, it } from 'bun:test';

import {
  normalizeOrchestrateBaseUrl,
  normalizeOrchestrateEventFrame,
  parseSseBlock,
} from './orchestrate-sse.js';

describe('orchestrate sse helpers', () => {
  it('normalizes base URL', () => {
    expect(normalizeOrchestrateBaseUrl('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(normalizeOrchestrateBaseUrl('https://example.com/api///')).toBe('https://example.com/api');
    expect(normalizeOrchestrateBaseUrl('ftp://example.com')).toBe(null);
  });

  it('parses SSE block with id/event/data', () => {
    const parsed = parseSseBlock('id: 7\nevent: run.created\ndata: {"runId":"run_1"}\n');
    expect(parsed).toEqual({
      id: '7',
      event: 'run.created',
      data: { runId: 'run_1' },
      rawData: '{"runId":"run_1"}',
    });
  });

  it('normalizes event frames into a stable envelope', () => {
    const normalized = normalizeOrchestrateEventFrame(
      'id: 3\nevent: worker.task.started\ndata: {"runId":"run_1","taskId":"t1","createdAt":"2025-01-01T00:00:00.000Z"}\n',
      'run_1',
      99,
    );

    expect(normalized.id).toBe('3');
    expect(normalized.type).toBe('worker.task.started');
    expect(normalized.runId).toBe('run_1');
    expect(normalized.ts).toBe('2025-01-01T00:00:00.000Z');
    expect(typeof normalized.payload).toBe('object');
  });

  it('falls back when upstream frame is malformed', () => {
    const normalized = normalizeOrchestrateEventFrame('event: ???\ndata: not-json\n', 'run_2', 12);
    expect(normalized.id).toBe('12');
    expect(normalized.runId).toBe('run_2');
    expect(normalized.type).toBe('???');
    expect(normalized.payload).toEqual({ raw: 'not-json' });
  });
});
