import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, openStream, type SourceLike } from '../lib/stream-client.js';

class FakeSource implements SourceLike {
  static made: FakeSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, (e: MessageEvent<string>) => void>();
  constructor(readonly url: string) { FakeSource.made.push(this); }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) { this.listeners.set(type, fn); }
  close() { this.closed = true; this.readyState = 2; }
  emit(type: string, data: unknown, id = '') { this.listeners.get(type)!({ data: JSON.stringify(data), lastEventId: id } as MessageEvent<string>); }
}

const handlers = () => ({ hello: vi.fn(), block: vi.fn(), stats: vi.fn(), state: vi.fn() });

describe('openStream', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeSource.made = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('backs off 1 s doubling to 30 s, with jitter', () => {
    expect(backoffMs(0, () => 0.5)).toBe(1000);
    expect(backoffMs(3, () => 0.5)).toBe(8000);
    expect(backoffMs(9, () => 0.5)).toBe(30_000);
    expect(backoffMs(0, () => 0)).toBe(750);
  });

  it('delivers messages and reports the stream open', () => {
    const h = handlers();
    openStream(h, { makeSource: (u) => new FakeSource(u) });
    const s = FakeSource.made[0]!;
    expect(s.url).toBe('/api/stream');
    s.onopen!();
    s.emit('block', { n: 7 }, '7');
    expect(h.state).toHaveBeenCalledWith(true);
    expect(h.block).toHaveBeenCalledWith({ n: 7 });
  });

  it('retries a stream the browser gave up on (a 503), resuming from the last id', () => {
    const h = handlers();
    openStream(h, { makeSource: (u) => new FakeSource(u), random: () => 0.5 });
    const s = FakeSource.made[0]!;
    s.emit('block', { n: 41 }, '41');
    s.readyState = 2;
    s.onerror!();
    expect(h.state).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(999);
    expect(FakeSource.made).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSource.made[1]!.url).toBe('/api/stream?last=41');
    FakeSource.made[1]!.readyState = 2;
    FakeSource.made[1]!.onerror!();
    vi.advanceTimersByTime(2000);
    expect(FakeSource.made).toHaveLength(3);
  });

  it('leaves a reconnecting stream to the browser', () => {
    openStream(handlers(), { makeSource: (u) => new FakeSource(u) });
    FakeSource.made[0]!.onerror!(); // readyState CONNECTING: EventSource retries itself
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.made).toHaveLength(1);
  });

  it('reconnects a stream that went silent', () => {
    openStream(handlers(), { makeSource: (u) => new FakeSource(u), watchdogMs: 45_000, random: () => 0.5 });
    const s = FakeSource.made[0]!;
    s.onopen!();
    vi.advanceTimersByTime(45_000);
    expect(s.closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(FakeSource.made).toHaveLength(2);
  });

  it('stops for good when closed', () => {
    const stop = openStream(handlers(), { makeSource: (u) => new FakeSource(u) });
    stop();
    expect(FakeSource.made[0]!.closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(FakeSource.made).toHaveLength(1);
  });
});
