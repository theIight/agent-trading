import { describe, expect, it } from 'vitest';
import type { WallSegment } from '@wca/shared';
import type { BookSample } from '../apps/server/src/orderflow/localBook.ts';
import { findWallSegments, median, WallTracker, type SpotCandle, type WallSegmentOptions } from '../apps/server/src/orderflow/calc.ts';
import { BinanceOrderflow } from '../apps/server/src/orderflow/binanceOrderflow.ts';

// Bản tính lại từ đầu trước khi chuyển sang WallTracker (giữ nguyên để đối chiếu kết quả).
function referenceWallSegments(samples: readonly BookSample[], candles: readonly SpotCandle[], opts: WallSegmentOptions): WallSegment[] {
  const { bucket, minSize, k = 3, persistRatio = 0.5, gapTolerance = 1, minDurationMin = 5, maxGapSec = 300 } = opts;
  type W = { side: 'BID' | 'ASK'; price: number; start: number; lastSeen: number; firstMiss: number | null; peak: number; misses: number };
  const med = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const open = new Map<string, W>();
  const out: WallSegment[] = [];
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const latest = sorted.at(-1);
  const touched = (w: W, from: number, to: number, mids: number[]): number | null => {
    const hit = (lo: number, hi: number) => (w.side === 'BID' ? lo <= w.price + bucket : hi >= w.price);
    for (const c of candles) {
      if (c.time + 60 <= from || c.time > to) continue;
      if (hit(c.low, c.high)) return Math.max(from, c.time);
    }
    return mids.some(m => hit(m, m)) ? to : null;
  };
  const close = (w: W, mids: number[]) => {
    const to = w.firstMiss ?? w.lastSeen;
    const at = touched(w, w.lastSeen, to, mids);
    const end = at ?? w.lastSeen;
    if (end - w.start >= minDurationMin * 60) {
      out.push({ side: w.side, sourcePrice: w.price, start: w.start, end, peakSize: r3(w.peak), status: at !== null ? 'consumed' : 'pulled' });
    }
  };
  let prevT: number | null = null;
  let prevMid: number | null = null;
  for (const s of sorted) {
    if (prevT !== null && s.t - prevT > maxGapSec) {
      for (const w of open.values()) close(w, prevMid !== null ? [prevMid] : []);
      open.clear();
    }
    for (const side of ['BID', 'ASK'] as const) {
      const levels = side === 'BID' ? s.bids : s.asks;
      const sizes = new Map(levels);
      const th = Math.max(k * med(levels.map(l => l[1])), minSize);
      for (const [key, w] of open) {
        if (w.side !== side) continue;
        const q = sizes.get(w.price) ?? 0;
        if (q >= persistRatio * w.peak && q > 0) {
          w.lastSeen = s.t;
          w.peak = Math.max(w.peak, q);
          w.misses = 0;
          w.firstMiss = null;
        } else {
          w.misses += 1;
          w.firstMiss ??= s.t;
          if (w.misses > gapTolerance) {
            close(w, [s.mid, ...(prevMid !== null ? [prevMid] : [])]);
            open.delete(key);
          }
        }
      }
      for (const [price, q] of levels) {
        const key = `${side}:${price}`;
        if (q >= th && !open.has(key)) open.set(key, { side, price, start: s.t, lastSeen: s.t, firstMiss: null, peak: q, misses: 0 });
      }
    }
    prevT = s.t;
    prevMid = s.mid;
  }
  for (const w of open.values()) {
    if (latest && latest.t - w.start >= minDurationMin * 60) {
      out.push({ side: w.side, sourcePrice: w.price, start: w.start, end: null, peakSize: r3(w.peak), status: 'active' });
    }
  }
  return out;
}

const norm = (segs: WallSegment[]) =>
  [...segs].sort((a, b) => a.start - b.start || (a.end ?? Infinity) - (b.end ?? Infinity) || a.side.localeCompare(b.side) || a.sourcePrice - b.sourcePrice);

/** PRNG có seed (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = 1_800_000_000; // chia hết cho 60

/** Mẫu mỗi 10s (có vài khoảng mất dữ liệu > 5 phút), tường xuất hiện / nhiễu / biến mất ngẫu nhiên; nến 1m theo mid. */
function scenario(seed: number, n = 900) {
  const r = rng(seed);
  const bucket = 10;
  let mid = 70000;
  let t = T0;
  const walls = new Map<number, number>(); // giá → size
  const samples: BookSample[] = [];
  const midsByMin = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    t += r() < 0.004 ? 400 + Math.floor(r() * 300) : 10;
    mid += (r() - 0.5) * 30;
    if (r() < 0.08) walls.set(Math.round((mid + (r() - 0.5) * 600) / bucket) * bucket, 20 + Math.floor(r() * 60));
    for (const p of [...walls.keys()]) if (r() < 0.01) walls.delete(p);
    const base = Math.floor(mid / bucket) * bucket;
    const bids: [number, number][] = [];
    const asks: [number, number][] = [];
    for (let j = 1; j <= 40; j++) {
      bids.push([base - j * bucket, 1 + Math.floor(r() * 3)]);
      asks.push([base + j * bucket, 1 + Math.floor(r() * 3)]);
    }
    const put = (arr: [number, number][], p: number, q: number) => {
      const lv = arr.find(l => l[0] === p);
      if (lv) lv[1] = q;
      else arr.push([p, q]);
    };
    for (const [p, q] of walls) {
      if (r() < 0.05) continue; // nhiễu: hụt 1 mẫu
      const size = r() < 0.03 ? Math.floor(q * 0.3) : q; // đôi khi tụt dưới 50% đỉnh
      put(p < mid ? bids : asks, p, size);
    }
    samples.push({ t, mid, bids, asks });
    const m = Math.floor(t / 60) * 60;
    if (!midsByMin.has(m)) midsByMin.set(m, []);
    midsByMin.get(m)!.push(mid);
  }
  const candles: SpotCandle[] = [];
  for (let m = T0; m <= t + 60; m += 60) {
    const xs = midsByMin.get(m) ?? [mid];
    const lo = Math.min(...xs) - r() * 40;
    const hi = Math.max(...xs) + r() * 40;
    candles.push({ time: m, open: lo, high: hi, low: lo, close: hi, volume: 1, takerBuy: 0.5 });
  }
  return { samples, candles, opts: { bucket, minSize: 8 } };
}

describe('median (quickselect)', () => {
  it('giống sort với mảng lẻ, chẵn, trùng giá trị, rỗng', () => {
    const r = rng(7);
    const ref = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
    };
    expect(median([])).toBe(0);
    for (let n = 1; n < 60; n++) {
      const xs = Array.from({ length: n }, () => Math.floor(r() * 5));
      expect(median(xs)).toBe(ref(xs));
      const ys = Array.from({ length: n }, () => r() * 100);
      expect(median(ys)).toBe(ref(ys));
    }
  });
});

describe('WallTracker (lịch sử tường tính tăng dần)', () => {
  it('findWallSegments khớp bản tính cũ trên dữ liệu ngẫu nhiên', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { samples, candles, opts } = scenario(seed);
      const got = findWallSegments(samples, candles, opts);
      expect(got.length).toBeGreaterThan(3);
      expect(norm(got)).toEqual(norm(referenceWallSegments(samples, candles, opts)));
    }
  });

  it('push theo lô bất kỳ (nến chỉ có tới lúc đó) cho kết quả giống tính một lần', () => {
    for (const seed of [11, 12, 13]) {
      const { samples, candles, opts } = scenario(seed);
      const full = norm(referenceWallSegments(samples, candles, opts));
      const lastT = samples.at(-1)!.t;
      for (const size of [1, 7, 100]) {
        const tracker = new WallTracker(opts);
        for (let i = 0; i < samples.length; i += size) {
          const batch = samples.slice(0, i + size); // gửi lại cả mẫu cũ: tracker phải tự bỏ
          const upTo = batch.at(-1)!.t;
          tracker.push(batch, candles.filter(c => c.time + 60 <= upTo));
        }
        tracker.push([], candles.filter(c => c.time <= lastT));
        expect(tracker.processed).toBe(samples.length);
        expect(norm(tracker.segments())).toEqual(full);
      }
    }
  });

  it('tường mất khi nến chưa phủ: tạm pulled theo mid, có nến chạm thì thành consumed', () => {
    const mk = (i: number): BookSample => ({
      t: T0 + i * 10,
      mid: 70050,
      bids: [[69950, 1], [69960, 1], [69970, 1], ...(i < 60 ? ([[70000, 40]] as [number, number][]) : [])],
      asks: [[70150, 1], [70160, 1], [70170, 1]],
    });
    const samples = Array.from({ length: 80 }, (_, i) => mk(i));
    const tracker = new WallTracker({ bucket: 10, minSize: 8 });
    const flat = (n: number) => Array.from({ length: n }, (_, i): SpotCandle => ({ time: T0 + i * 60, open: 70030, high: 70080, low: 70030, close: 70080, volume: 1, takerBuy: 0.5 }));
    tracker.push(samples, flat(9)); // nến tới T0+540, tường hụt từ T0+600
    expect(tracker.segments()).toEqual([{ side: 'BID', sourcePrice: 70000, start: T0, end: T0 + 590, peakSize: 40, status: 'pulled' }]);
    const touch: SpotCandle = { time: T0 + 540, open: 70005, high: 70060, low: 70005, close: 70060, volume: 1, takerBuy: 0.5 };
    tracker.push([], [...flat(9), touch, ...flat(12).slice(10)]);
    expect(tracker.segments()).toEqual([{ side: 'BID', sourcePrice: 70000, start: T0, end: T0 + 590, peakSize: 40, status: 'consumed' }]);
  });

  it('cửa sổ: bỏ tường kết thúc trước from, cắt start của tường bắt đầu trước from', () => {
    const samples = Array.from({ length: 200 }, (_, i): BookSample => ({
      t: T0 + i * 10,
      mid: 70050,
      bids: [[69950, 1], [69960, 1], [69970, 1], ...(i < 60 ? ([[70000, 40]] as [number, number][]) : []), [69800, 30]],
      asks: [[70150, 1], [70160, 1], [70170, 1]],
    }));
    const tracker = new WallTracker({ bucket: 10, minSize: 8 });
    tracker.push(samples, []);
    const from = T0 + 1000;
    expect(tracker.segments(from)).toEqual([{ side: 'BID', sourcePrice: 69800, start: from, end: null, peakSize: 30, status: 'active' }]);
    // Còn < 5 phút sau khi cắt → chưa trả.
    expect(tracker.segments(T0 + 1990 - 200)).toEqual([]);
  });

  it('BinanceOrderflow.wallSegments chỉ xử lý mẫu mới ở lần gọi sau', async () => {
    const { samples } = scenario(21, 300);
    let now = samples[150]!.t;
    const of = new BinanceOrderflow({
      collectors: {
        BTCUSDT: {
          samples: () => [],
          rawSamples: (from: number, to: number) => samples.filter(x => x.t >= from && x.t <= to),
          trades: () => [],
          status: () => ({ symbol: 'BTCUSDT', sourceSymbol: 'BTCUSDT', market: 'spot' as const, coverLow: 0, coverHigh: 0, connected: true, synced: true, since: null, lastSampleAt: null, historyMin: 0, spotPrice: null }),
        },
      },
      buckets: { BTCUSDT: 10 },
      absorptionQty: {},
      wallMin: { BTCUSDT: 8 },
      fetchImpl: (async () => new Response('[]')) as typeof fetch,
      now: () => now,
    });
    await of.wallSegments('BTCUSDT', now);
    const tracker = of.wallTrackers.get('BTCUSDT')!;
    expect(tracker.processed).toBe(151);
    now = samples[160]!.t;
    await of.wallSegments('BTCUSDT', now);
    expect(tracker.processed).toBe(161);
  });
});

describe('BinanceOrderflow.bookWindowSamples (mẫu 4h cho snapshot, lấy từ cache)', () => {
  const status = () => ({ symbol: 'BTCUSDT', sourceSymbol: 'BTCUSDT', market: 'spot' as const, coverLow: 0, coverHigh: 0, connected: true, synced: true, since: null, lastSampleAt: null, historyMin: 0, spotPrice: null });
  const make = (store: BookSample[], now: () => number) =>
    new BinanceOrderflow({
      collectors: {
        BTCUSDT: {
          samples: () => {
            throw new Error('snapshot không được đọc lại SQLite');
          },
          rawSamples: (from: number, to: number) => store.filter(x => x.t >= from && x.t <= to),
          trades: () => [],
          status,
        },
      },
      buckets: { BTCUSDT: 10 },
      absorptionQty: {},
      fetchImpl: (async () => new Response('[]')) as typeof fetch,
      now,
    });
  // Cách cũ của collector.samples: mẫu trong [from, to], bỏ phần trước khoảng mất dữ liệu > 300s cuối cùng.
  const reference = (store: BookSample[], from: number, to: number) => {
    const rows = store.filter(x => x.t >= from && x.t <= to);
    let start = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i]!.t - rows[i - 1]!.t > 300) start = i;
    return rows.slice(start);
  };

  it('giống collector.samples, kể cả khi có khoảng mất dữ liệu', () => {
    const { samples } = scenario(31, 3000); // ~8h, có vài khoảng mất dữ liệu
    for (const idx of [100, 1500, 2200, 2999]) {
      const now = samples[idx]!.t + 3;
      const of = make(samples, () => now);
      expect(of.bookWindowSamples('BTCUSDT', now).map(s => s.t)).toEqual(reference(samples, now - 240 * 60, now).map(s => s.t));
    }
  });

  it('snapshot dùng mẫu từ cache (không gọi collector.samples), bỏ phần trước khoảng mất dữ liệu', async () => {
    const t0 = T0;
    const mk = (t: number): BookSample => ({ t, mid: 70050, bids: [[70000, 40], [69990, 1], [69980, 1], [69970, 1]], asks: [[70100, 1], [70110, 1], [70120, 1]] });
    const store = [...Array.from({ length: 30 }, (_, i) => mk(t0 + i * 10)), ...Array.from({ length: 60 }, (_, i) => mk(t0 + 1000 + i * 10))];
    const now = t0 + 1000 + 59 * 10;
    const of = make(store, () => now);
    const snap = await of.snapshot('BTCUSDT', null);
    expect(snap.historyMin).toBe(9.83); // chỉ đoạn sau khoảng mất dữ liệu 710s
    expect(snap.walls).toEqual([expect.objectContaining({ side: 'BID', price: 70000, size: 40 })]);
  });
});
