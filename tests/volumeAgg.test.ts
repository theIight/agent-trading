import { describe, expect, it } from 'vitest';
import type { VolumeAggBar } from '@wca/shared';
import { openDb } from '../apps/server/src/db/index.ts';
import { barOpen, closedBarTimes, findSpikes, mergeBars } from '../apps/server/src/volumeAgg/calc.ts';
import { makeVolumeFetcher } from '../apps/server/src/volumeAgg/sources.ts';
import { VolumeAggService } from '../apps/server/src/volumeAgg/service.ts';

const SYM = { binanceFut: 'BTCUSDT', binanceSpot: 'BTCUSDT', bybit: 'BTCUSDT', okx: 'BTC-USDT-SWAP' };

describe('mốc nến', () => {
  it('tuần mở thứ Hai UTC; chỉ nến đã đóng', () => {
    // 2026-11-12 (thứ Năm) → tuần mở 2026-11-09 thứ Hai
    expect(new Date(barOpen(Date.UTC(2026, 10, 12, 9) / 1000, '1w') * 1000).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(barOpen(1_794_182_400 + 3 * 86400, '1w')).toBe(1_794_182_400); // 2026-11-02 thứ Hai (khớp nến tuần Binance/OKX/Bybit)
    expect(closedBarTimes(3725, '1m', 3)).toEqual([3540, 3600, 3660]);
    expect(closedBarTimes(7200, '1h', 2)).toEqual([0, 3600]);
  });
});

const bar = (time: number, perp: number | null, spot: number | null, okx: number | null = perp === null ? null : 1): VolumeAggBar =>
  mergeBars([time], {
    binanceFut: new Map(perp === null ? [] : [[time, perp - 2]]),
    okx: new Map(okx === null ? [] : [[time, okx]]),
    bybit: new Map(perp === null ? [] : [[time, 1]]),
    binanceSpot: new Map(spot === null ? [] : [[time, spot]]),
  })[0]!;

describe('gộp + đột biến', () => {
  it('perp = tổng 3 sàn, spot riêng, cờ đủ dữ liệu', () => {
    const [b] = mergeBars([60], { binanceFut: new Map([[60, 10]]), okx: new Map([[60, 5]]), bybit: new Map(), binanceSpot: new Map([[60, 2]]) });
    expect(b).toEqual({ time: 60, perp: 15, spot: 2, venues: { binanceFut: 10, okx: 5, bybit: null, binanceSpot: 2 }, perpComplete: false });
  });

  it('phân loại BOTH / SPOT / PERP theo trung vị 20 nến trước', () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(i * 60, 10, 1));
    bars.push(bar(1200, 40, 1)); // perp ×4
    bars.push(bar(1260, 10, 5)); // spot ×5
    bars.push(bar(1320, 50, 4)); // cả hai
    bars.push(bar(1380, 25, 2)); // dưới ngưỡng
    expect(findSpikes(bars, { x: 3 })).toEqual([
      { time: 1200, kind: 'PERP', perpX: 4, spotX: 1 },
      { time: 1260, kind: 'SPOT', perpX: 1, spotX: 5 },
      { time: 1320, kind: 'BOTH', perpX: 5, spotX: 4 },
    ]);
  });

  it('nến thiếu sàn perp không báo đột biến perp; thiếu lịch sử → không tính', () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(i * 60, 10, 1));
    bars.push(bar(1200, 40, 1, null)); // thiếu OKX → perp không tính
    expect(findSpikes(bars, { x: 3 })).toEqual([]);
    expect(findSpikes([bar(0, 10, 1), bar(60, 100, 50)], { x: 3 })).toEqual([]); // < 15 nến trước
  });
});

describe('nguồn từng sàn', () => {
  it('đơn vị đồng gốc, chỉ nến đã đóng, phân trang OKX/Bybit lùi dần, OKX 1D dùng bản UTC', async () => {
    const now = 600 + 30; // nến 600 đang chạy (1m)
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      if (u.hostname.includes('binance')) {
        return new Response(JSON.stringify([0, 60, 600].map(t => [t * 1000, '1', '1', '1', '1', String(t / 60 + 0.5)])));
      }
      if (u.hostname.includes('okx')) {
        const after = Number(u.searchParams.get('after')) / 1000;
        const rows = Array.from({ length: 100 }, (_, i) => after - 60 * (i + 1)).filter(t => t >= 0).map(t => [String(t * 1000), '1', '1', '1', '1', '999', String(t / 60), '0', '1']);
        return new Response(JSON.stringify({ code: '0', data: rows }));
      }
      const rows = [600, 540, 0].map(t => [String(t * 1000), '1', '1', '1', '1', String(t / 60 + 0.25), '0']);
      return new Response(JSON.stringify({ retCode: 0, result: { list: rows } }));
    }) as typeof fetch;
    const f = makeVolumeFetcher(fetchImpl, () => now, 0);
    expect([...(await f('binanceFut', SYM, '1m', 0, 540))]).toEqual([
      [0, 0.5],
      [60, 1.5],
    ]);
    expect([...(await f('bybit', SYM, '1m', 0, 540))]).toEqual([
      [540, 9.25],
      [0, 0.25],
    ]);
    const okx = await f('okx', SYM, '1m', 0, 540);
    expect(okx.get(540)).toBe(9);
    expect(okx.get(0)).toBe(0);
    expect(okx.size).toBe(10);
    await f('okx', SYM, '1d', 0, 0);
    expect(urls.at(-1)).toContain('bar=1Dutc');
  });

  it('429 → thử lại', async () => {
    let n = 0;
    const fetchImpl = (async () => (++n === 1 ? new Response('', { status: 429 }) : new Response(JSON.stringify([[0, '1', '1', '1', '1', '7']])))) as typeof fetch;
    const f = makeVolumeFetcher(fetchImpl, () => 120, 0);
    // retryMs mặc định 1s: chấp nhận chờ trong test để kiểm tra đường thử lại.
    expect([...(await f('binanceSpot', SYM, '1m', 0, 0))]).toEqual([[0, 7]]);
    expect(n).toBe(2);
  }, 5000);
});

describe('VolumeAggService', () => {
  it('cache SQLite: lần sau chỉ tải nến mới; sàn lỗi → ghi chú, không thử lại ngay', async () => {
    const db = openDb(':memory:');
    let now = 60 * 30 + 5;
    const calls: string[] = [];
    const svc = new VolumeAggService({
      db,
      symbols: { BTCUSDT: SYM },
      spikeX: 3,
      now: () => now,
      fetcher: async (venue, _s, _tf, from, to) => {
        calls.push(`${venue}:${from}-${to}`);
        if (venue === 'bybit') throw new Error('HTTP 500');
        const m = new Map<number, number>();
        for (let t = from; t <= to; t += 60) m.set(t, venue === 'binanceSpot' ? 1 : 10);
        return m;
      },
    });
    const r1 = await svc.get('BTCUSDT', '1m', 20);
    expect(r1.bars).toHaveLength(20);
    expect(r1.bars[0]).toMatchObject({ perp: 20, spot: 1, perpComplete: false });
    expect(r1.notes).toEqual(['Bybit perp: lỗi tải (HTTP 500)']);
    expect(calls.sort()).toEqual(['binanceFut:600-1740', 'binanceSpot:600-1740', 'bybit:600-1740', 'okx:600-1740']);
    calls.length = 0;
    now += 60; // một nến mới đóng
    await svc.get('BTCUSDT', '1m', 20);
    // nến mới luôn tải; Bybit chỉ thử nến mới (nến cũ vừa lỗi < 120s)
    expect(calls.sort()).toEqual(['binanceFut:1800-1800', 'binanceSpot:1800-1800', 'bybit:1800-1800', 'okx:1800-1800']);
    // chart tải thêm lịch sử (limit lớn hơn): nến cũ hơn khoảng đã thử vẫn được tải ngay
    calls.length = 0;
    await svc.get('BTCUSDT', '1m', 25);
    // (Bybit vẫn lỗi: chỉ khoảng 1800 vừa thử bị hoãn, phần còn lại thử lại)
    expect(calls.sort()).toEqual(['binanceFut:360-540', 'binanceSpot:360-540', 'bybit:360-1740', 'okx:360-540']);
  });
});
