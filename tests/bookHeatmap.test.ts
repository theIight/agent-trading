import { describe, expect, it } from 'vitest';
import { buildHeatColumns } from '../apps/server/src/orderflow/bookHeatmap.ts';
import { BinanceOrderflow } from '../apps/server/src/orderflow/binanceOrderflow.ts';
import type { BookSample } from '../apps/server/src/orderflow/localBook.ts';

const sample = (t: number, bids: [number, number][], asks: [number, number][] = []): BookSample => ({ t, mid: 100, bids, asks });

describe('buildHeatColumns', () => {
  it('trung bình theo số mẫu trong cột, bucket vắng = 0, bid + ask cộng chung', () => {
    const cols = buildHeatColumns(
      [
        sample(0, [[90, 4]], [[110, 2]]),
        sample(10, [[90, 2]], [[90, 1]]), // bid và ask cùng bucket → cộng
        sample(70, [[100, 6]]),
      ],
      { colSec: 60, bucket: 10, basisAt: t => t / 10 },
    );
    expect(cols).toEqual([
      { t: 0, shift: 1, data: [9, 3.5, 11, 1] }, // (4+2+1)/2, 2/2; shift = basis tại mẫu cuối (t=10)
      { t: 60, shift: 7, data: [10, 6] },
    ]);
  });

  it('cột đã đầy dùng basis tại cuối cột; bỏ ô quá nhỏ so với ô lớn nhất cột', () => {
    const cols = buildHeatColumns([sample(0, [[90, 1000], [80, 0.5]]), sample(200, [[90, 1]])], {
      colSec: 60,
      bucket: 10,
      basisAt: t => t,
      minFrac: 0.001,
    });
    expect(cols[0]).toEqual({ t: 0, shift: 0, data: [9, 1000] });
    expect(cols[1]!.t).toBe(180);
    expect(cols[1]!.shift).toBe(200);
  });

  it('dữ liệu rỗng / tham số sai → rỗng', () => {
    expect(buildHeatColumns([], { colSec: 60, bucket: 10, basisAt: () => 0 })).toEqual([]);
    expect(buildHeatColumns([sample(0, [[1, 1]])], { colSec: 0, bucket: 10, basisAt: () => 0 })).toEqual([]);
  });
});

describe('BinanceOrderflow.bookHeatmap', () => {
  const NOW = 1_800_000_000 - (1_800_000_000 % 3600);
  function make(now: { v: number }) {
    const book = Array.from({ length: 3 * 360 }, (_, i) => sample(NOW - 3 * 3600 + i * 10, [[1000, 2]], [[1100, 1]]));
    let reads = 0;
    const of = new BinanceOrderflow({
      collectors: {
        BTCUSDT: {
          samples: () => [],
          rawSamples: (from, to) => {
            reads++;
            return book.filter(s => s.t >= from && s.t <= to);
          },
          trades: () => [],
          status: () => ({ symbol: 'BTCUSDT', sourceSymbol: 'BTCUSDT', market: 'spot', coverLow: 0, coverHigh: 0, connected: true, synced: true, since: 0, lastSampleAt: now.v, historyMin: 180, spotPrice: 1000 }),
        },
      },
      buckets: { BTCUSDT: 10 },
      absorptionQty: {},
      offsets: { BTCUSDT: 30 },
      fetchImpl: (async () => new Response('[]')) as typeof fetch,
      now: () => now.v,
    });
    return { of, reads: () => reads };
  }

  it('cột theo khung, basis dự phòng, cột đang chạy đánh dấu partialLast, after chỉ trả cột sau', async () => {
    const now = { v: NOW - 30 };
    const { of } = make(now);
    const h = await of.bookHeatmap('BTCUSDT', 900);
    expect(h.colSec).toBe(900);
    expect(h.cols[0]).toBe(NOW - 3 * 3600);
    expect(h.cols.at(-1)).toBe(NOW - 900);
    expect(h.partialLast).toBe(true);
    expect(h.shift.every(x => x === 30)).toBe(true);
    expect(h.data[0]).toEqual([100, 2, 110, 1]);
    expect(h.unit).toBe('BTC');

    const inc = await of.bookHeatmap('BTCUSDT', 900, NOW - 1800);
    expect(inc.cols).toEqual([NOW - 900]);
  });

  it('khung < 1 phút bị nâng lên 60s; giới hạn số cột', async () => {
    const now = { v: NOW };
    const { of } = make(now);
    const h = await of.bookHeatmap('BTCUSDT', 30);
    expect(h.colSec).toBe(60);
    expect(h.cols.length).toBeLessThanOrEqual(720);
    expect(h.cols.length).toBe(180);
  });

  it('cột đã đóng được cache, lần sau chỉ đọc mẫu mới', async () => {
    const now = { v: NOW - 30 };
    const { of } = make(now);
    const a = await of.bookHeatmap('BTCUSDT', 60);
    now.v += 60;
    const b = await of.bookHeatmap('BTCUSDT', 60);
    expect(b.cols.length).toBeGreaterThanOrEqual(a.cols.length);
    expect(b.data.slice(0, a.cols.length - 2)).toEqual(a.data.slice(0, a.cols.length - 2));
  });

  it('symbol chưa bật → lỗi', async () => {
    const { of } = make({ v: NOW });
    await expect(of.bookHeatmap('ETHUSDT', 60)).rejects.toThrow(/Chưa bật/);
  });
});
