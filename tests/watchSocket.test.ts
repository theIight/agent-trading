import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchSocket, type SocketDeadReason } from '../apps/server/src/ws/watchSocket.ts';

/** Giả lập WebSocket Node 22: lỗi khi mở chỉ bắn `error`, `close()` lúc CONNECTING bắn lại `error`. */
class FakeWs extends EventTarget {
  readyState = 0;
  closeCalls = 0;
  close() {
    this.closeCalls++;
    if (this.readyState === 0) this.dispatchEvent(new Event('error'));
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  msg(data = '{}') {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function setup(opts: { idle?: number; ready?: number } = {}) {
  const ws = new FakeWs();
  if (opts.ready !== undefined) ws.readyState = opts.ready;
  const dead: SocketDeadReason[] = [];
  const msgs: unknown[] = [];
  let opened = 0;
  const watch = watchSocket(ws as unknown as WebSocket, {
    openTimeoutMs: 20_000,
    ...(opts.idle ? { idleTimeoutMs: opts.idle } : {}),
    onOpen: () => opened++,
    onMessage: ev => msgs.push(ev.data),
    onDead: r => dead.push(r),
  });
  return { ws, dead, msgs, watch, opened: () => opened };
}

describe('watchSocket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lỗi khi mở chỉ có error (không close) → báo chết một lần, không lặp', () => {
    const { ws, dead } = setup();
    ws.dispatchEvent(new Event('error'));
    ws.dispatchEvent(new Event('error'));
    expect(dead).toEqual(['error']);
    expect(ws.closeCalls).toBe(1);
  });

  it('close đến sau error → không báo chết lần hai', () => {
    const { ws, dead } = setup();
    ws.open();
    ws.dispatchEvent(new Event('error'));
    ws.dispatchEvent(new Event('close'));
    expect(dead).toEqual(['error']);
  });

  it('close bình thường → chết vì close', () => {
    const { ws, dead, opened } = setup();
    ws.open();
    expect(opened()).toBe(1);
    ws.dispatchEvent(new Event('close'));
    expect(dead).toEqual(['close']);
  });

  it('không mở được trong 20s → timeout mở', () => {
    const { dead } = setup();
    vi.advanceTimersByTime(19_999);
    expect(dead).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dead).toEqual(['timeout mở']);
  });

  it('đã mở thì không còn timeout mở', () => {
    const { ws, dead } = setup();
    ws.open();
    vi.advanceTimersByTime(60_000);
    expect(dead).toEqual([]);
  });

  it('im lặng quá idle → chết; message giữ kết nối sống', () => {
    const { ws, dead, msgs } = setup({ idle: 60_000 });
    ws.open();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(40_000);
      ws.msg(String(i));
    }
    expect(dead).toEqual([]);
    expect(msgs).toEqual(['0', '1', '2', '3', '4']);
    vi.advanceTimersByTime(60_000);
    expect(dead).toEqual(['im lặng']);
  });

  it('socket đã OPEN lúc gắn → bắt đầu đếm im lặng ngay', () => {
    const { dead } = setup({ idle: 60_000, ready: 1 });
    vi.advanceTimersByTime(60_000);
    expect(dead).toEqual(['im lặng']);
  });

  it('dispose: không báo chết, bỏ qua sự kiện sau đó', () => {
    const { ws, dead, msgs, watch } = setup({ idle: 1000 });
    ws.open();
    watch.dispose();
    ws.msg();
    ws.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(10_000);
    expect(dead).toEqual([]);
    expect(msgs).toEqual([]);
  });
});
