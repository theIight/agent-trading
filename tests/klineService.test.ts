import { describe, expect, it } from 'vitest';
import type { Candle } from '@wca/shared';
import { openDb } from '../apps/server/src/db/index.ts';
import { KlineService } from '../apps/server/src/market/klineService.ts';
import { parseBinanceKline } from '../apps/server/src/market/binanceFutures.ts';
import type { FetchKlinesParams, MarketDataProvider } from '../apps/server/src/market/provider.ts';

const H1 = 3600;
const T0 = 1_700_000_000 - (1_700_000_000 % H1);

function makeCandles(n: number, start = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: start + i * H1,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 10 + i,
  }));
}

class FakeProvider implements MarketDataProvider {
  name = 'fake';
  maxLimit = 1500;
  calls: FetchKlinesParams[] = [];
  fail = false;
  constructor(private data: Candle[]) {}
  async fetchKlines(p: FetchKlinesParams): Promise<Candle[]> {
    this.calls.push(p);
    if (this.fail) throw new Error('network down');
    const rows = p.endTime ? this.data.filter(c => c.time <= p.endTime!) : this.data;
    return rows.slice(-p.limit);
  }
}

describe('parseBinanceKline', () => {
  it('chuyển openTime ms → giây và chuỗi → số', () => {
    expect(parseBinanceKline([1700000000000, '1', '2', '0.5', '1.5', '100', 0])).toEqual({
      time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100,
    });
  });
});

describe('KlineService', () => {
  // 10 nến 1h; "now" nằm giữa nến cuối → nến cuối đang chạy.
  const data = makeCandles(10);
  const nowMs = (T0 + 9 * H1 + 1800) * 1000;

  it('đánh dấu nến cuối đang chạy và closedOnly bỏ nến đó', async () => {
    const svc = new KlineService(openDb(':memory:'), new FakeProvider(data), 0, () => nowMs);
    const all = await svc.getKlines({ symbol: 'BTCUSDT', tf: '1h', limit: 10 });
    expect(all.candles).toHaveLength(10);
    expect(all.lastCandleForming).toBe(true);

    const closed = await svc.getKlines({ symbol: 'BTCUSDT', tf: '1h', limit: 5, closedOnly: true });
    expect(closed.candles).toHaveLength(5);
    expect(closed.lastCandleForming).toBe(false);
    expect(closed.candles.at(-1)!.time).toBe(T0 + 8 * H1);
  });

  it('fallback về cache SQLite khi provider lỗi', async () => {
    const provider = new FakeProvider(data);
    const svc = new KlineService(openDb(':memory:'), provider, 0, () => nowMs);
    await svc.getKlines({ symbol: 'BTCUSDT', tf: '1h', limit: 10 });
    provider.fail = true;
    const res = await svc.getKlines({ symbol: 'BTCUSDT', tf: '1h', limit: 4 });
    expect(res.source).toBe('cache');
    expect(res.candles.map(c => c.time)).toEqual(data.slice(-4).map(c => c.time));
  });

  it('memo trong TTL không gọi lại provider', async () => {
    const provider = new FakeProvider(data);
    const svc = new KlineService(openDb(':memory:'), provider, 10_000, () => nowMs);
    await svc.getKlines({ symbol: 'BTCUSDT', tf: '1h', limit: 10 });
    await svc.getKlines({ symbol: 'BTCUSDT', tf: '1h', limit: 10 });
    expect(provider.calls).toHaveLength(1);
  });

  it('ném lỗi khi provider lỗi và cache rỗng', async () => {
    const provider = new FakeProvider(data);
    provider.fail = true;
    const svc = new KlineService(openDb(':memory:'), provider, 0, () => nowMs);
    await expect(svc.getKlines({ symbol: 'BTCUSDT', tf: '1h', limit: 5 })).rejects.toThrow('network down');
  });
});
