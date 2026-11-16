import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../apps/server/src/db/index.ts';
import { BookCollector } from '../apps/server/src/orderflow/collector.ts';
import { LiquidationCollector } from '../apps/server/src/liquidation/collector.ts';

/** Giả lập WebSocket Node 22: mở thất bại chỉ bắn `error`, không có `close`. */
class FakeWs extends EventTarget {
  readyState = 0;
  constructor(readonly url: string) {
    super();
  }
  close() {
    this.readyState = 3;
  }
  send() {}
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  fail() {
    this.dispatchEvent(new Event('error'));
  }
  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ data }) }));
  }
}

describe('kết nối lại WebSocket khi mở thất bại (Node 22 không bắn close)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('BookCollector: error không kèm close → kết nối lại theo backoff, rồi đồng bộ khi mở được', async () => {
    const sockets: FakeWs[] = [];
    const logs: string[] = [];
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ lastUpdateId: 100, bids: [['100', '1']], asks: [['101', '1']] }));
    }) as typeof fetch;
    const col = new BookCollector({
      symbol: 'BTCUSDT', bucket: 1, sampleSec: 3600, retainH: 24, resyncMin: 600, bigTradeQty: 1, db: openDb(':memory:'), fetchImpl,
      wsFactory: url => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
      log: m => logs.push(m),
    });
    col.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.fail();
    sockets[0]!.fail();
    expect(col.status().connected).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.fail();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    sockets[2]!.open();
    expect(col.status().connected).toBe(true);
    // Snapshot "kết nối" chạy khi mở; sổ chỉ synced sau diff đầu tiên nối tiếp snapshot.
    await vi.waitFor(() => expect(fetchCalls).toBe(1));
    await vi.advanceTimersByTimeAsync(0);
    sockets[2]!.emit({ e: 'depthUpdate', U: 100, u: 101, b: [['100', '2']], a: [] });
    expect(col.status().synced).toBe(true);
    expect(logs.filter(l => l.includes('mất'))).toHaveLength(1);
    expect(logs.some(l => l.includes('đã kết nối lại'))).toBe(true);
    col.stop();
  });

  it('BookCollector: không mở được trong 20s / im lặng 60s → kết nối lại', () => {
    const sockets: FakeWs[] = [];
    const col = new BookCollector({
      symbol: 'BTCUSDT', bucket: 1, sampleSec: 3600, retainH: 24, resyncMin: 600, bigTradeQty: 1, db: openDb(':memory:'),
      fetchImpl: (async () => new Response('{}', { status: 500 })) as typeof fetch,
      wsFactory: url => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });
    col.start();
    vi.advanceTimersByTime(20_000 + 1000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    vi.advanceTimersByTime(60_000 + 2000);
    expect(sockets).toHaveLength(3);
    col.stop();
    vi.advanceTimersByTime(600_000);
    expect(sockets).toHaveLength(3);
  });

  it('LiquidationCollector: error không kèm close → kết nối lại từng sàn', () => {
    const sockets: FakeWs[] = [];
    const col = new LiquidationCollector({
      symbol: 'BTCUSDT', okxInst: { instId: 'BTC-USDT-SWAP', ctVal: 0.01 }, retainH: 72, db: openDb(':memory:'),
      wsFactory: url => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });
    col.start();
    expect(sockets).toHaveLength(2);
    for (const ws of [...sockets]) ws.fail();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(4);
    for (const ws of sockets.slice(2)) ws.open();
    expect(col.status().every(s => s.connected)).toBe(true);
    col.stop();
  });
});
