import type { OrderflowLevel, WallSegment } from '@wca/shared';
import type { BookSample } from './localBook.ts';

// Tính order flow từ dữ liệu Binance (thuần, không I/O): tường thanh khoản bền, volume profile, CVD, hấp thụ.

export interface SpotCandle {
  /** Unix giây (open time). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Khối lượng mua chủ động (taker buy base volume). */
  takerBuy: number;
}

export interface BigTrade {
  /** Unix giây. */
  t: number;
  price: number;
  qty: number;
  /** Bên chủ động (aggressor). */
  side: 'BUY' | 'SELL';
}

export interface Wall {
  side: 'BID' | 'ASK';
  /** Cận dưới của bucket giá (spot). */
  price: number;
  size: number;
  /** Đứng liên tục bao nhiêu phút (≥ persistRatio × size hiện tại). */
  persistMin: number;
  /** Khối lượng lớn nhất của bucket trong cửa sổ. */
  maxSize: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface WallOptions {
  /** Tường = bucket ≥ k × median các bucket cùng phía. */
  k?: number;
  /** Bỏ tường đứng chưa đủ số phút này (chỉ áp dụng khi lịch sử đủ dài). */
  minPersistMin?: number;
  maxPerSide?: number;
  /** Bucket vẫn coi là "còn tường" khi size ≥ tỉ lệ này × size hiện tại. */
  persistRatio?: number;
  /** Số mẫu hụt liên tiếp cho phép (nhiễu). */
  gapTolerance?: number;
}

/** Tường thanh khoản trong mẫu mới nhất, kèm thời gian tồn tại; tường mới xuất hiện (dễ là spoof) bị loại. */
export function findWalls(samples: readonly BookSample[], opts: WallOptions = {}): Wall[] {
  const { k = 3, minPersistMin = 5, maxPerSide = 3, persistRatio = 0.5, gapTolerance = 1 } = opts;
  const latest = samples.at(-1);
  if (!latest) return [];
  const historyMin = (latest.t - samples[0]!.t) / 60;
  const maps = samples.map(s => ({ t: s.t, bids: new Map(s.bids), asks: new Map(s.asks) }));
  const out: Wall[] = [];
  for (const side of ['BID', 'ASK'] as const) {
    const levels = side === 'BID' ? latest.bids : latest.asks;
    const med = median(levels.map(l => l[1]));
    const walls: Wall[] = [];
    for (const [price, size] of levels) {
      if (!(med > 0) || size < k * med) continue;
      let start = latest.t;
      let misses = 0;
      let maxSize = size;
      for (let i = maps.length - 1; i >= 0; i--) {
        const m = maps[i]!;
        const q = (side === 'BID' ? m.bids : m.asks).get(price) ?? 0;
        maxSize = Math.max(maxSize, q);
        if (q >= persistRatio * size) {
          start = m.t;
          misses = 0;
        } else if (++misses > gapTolerance) {
          break;
        }
      }
      const persistMin = r2((latest.t - start) / 60);
      if (historyMin >= minPersistMin && persistMin < minPersistMin) continue;
      walls.push({ side, price, size, persistMin, maxSize: r3(maxSize) });
    }
    out.push(...walls.sort((a, b) => b.size - a.size).slice(0, maxPerSide));
  }
  return out;
}

export interface ProfileNode {
  /** Giữa bucket (spot). */
  price: number;
  volume: number;
}

export interface VolumeProfile {
  bucket: number;
  poc: ProfileNode;
  hvn: ProfileNode[];
  lvn: ProfileNode[];
  valueArea: { low: number; high: number };
}

/** Bucket profile: khoảng ~`target` bucket trên biên độ giá, làm tròn lên bội số bucket sổ lệnh. */
export function profileBucket(range: number, bookBucket: number, target = 80): number {
  if (!(range > 0) || !(bookBucket > 0)) return bookBucket;
  return Math.max(1, Math.ceil(range / target / bookBucket)) * bookBucket;
}

/** Volume profile từ nến 1m: volume mỗi nến chia đều cho các bucket trong [low, high]. */
export function volumeProfile(candles: readonly SpotCandle[], bucket: number): VolumeProfile | null {
  if (!candles.length || !(bucket > 0)) return null;
  const vol = new Map<number, number>();
  for (const c of candles) {
    const lo = Math.floor(c.low / bucket);
    const hi = Math.floor(c.high / bucket);
    const n = hi - lo + 1;
    for (let i = lo; i <= hi; i++) vol.set(i, (vol.get(i) ?? 0) + c.volume / n);
  }
  const keys = [...vol.keys()].sort((a, b) => a - b);
  const first = keys[0]!;
  const arr: number[] = [];
  for (let i = first; i <= keys.at(-1)!; i++) arr.push(vol.get(i) ?? 0);
  const node = (idx: number): ProfileNode => ({ price: r2((first + idx + 0.5) * bucket), volume: r3(arr[idx]!) });
  const total = arr.reduce((a, b) => a + b, 0);
  const mean = total / arr.length;
  let pocIdx = 0;
  arr.forEach((v, i) => {
    if (v > arr[pocIdx]!) pocIdx = i;
  });

  // Value area 70%: mở rộng từ POC về phía có volume lớn hơn.
  let lo = pocIdx;
  let hi = pocIdx;
  let acc = arr[pocIdx]!;
  while (acc < 0.7 * total && (lo > 0 || hi < arr.length - 1)) {
    const down = lo > 0 ? arr[lo - 1]! : -1;
    const up = hi < arr.length - 1 ? arr[hi + 1]! : -1;
    if (up >= down) acc += arr[++hi]!;
    else acc += arr[--lo]!;
  }

  const sm = arr.map((_, i) => {
    const w = arr.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  const isMax = (i: number) => i > 0 && i < sm.length - 1 && sm[i]! >= sm[i - 1]! && sm[i]! > sm[i + 1]!;
  const isMin = (i: number) => i > 0 && i < sm.length - 1 && sm[i]! <= sm[i - 1]! && sm[i]! < sm[i + 1]!;
  const hvn = sm
    .map((_, i) => i)
    .filter(i => isMax(i) && Math.abs(i - pocIdx) > 2 && arr[i]! >= 1.3 * mean)
    .sort((a, b) => arr[b]! - arr[a]!)
    .slice(0, 3);
  const peaks = [pocIdx, ...hvn];
  const inner = [Math.min(...peaks), Math.max(...peaks)];
  const lvn = sm
    .map((_, i) => i)
    .filter(i => isMin(i) && i > inner[0]! && i < inner[1]! && arr[i]! <= 0.5 * mean)
    .sort((a, b) => arr[a]! - arr[b]!)
    .slice(0, 2);
  return {
    bucket,
    poc: node(pocIdx),
    hvn: hvn.map(node),
    lvn: lvn.map(node),
    valueArea: { low: r2((first + lo) * bucket), high: r2((first + hi + 1) * bucket) },
  };
}

export interface CvdStats {
  /** Delta = mua chủ động − bán chủ động, theo đơn vị base (BTC). */
  total: number;
  last4h: number;
  last1h: number;
  priceChange4h: number;
  priceChange1h: number;
  /** Phân kỳ giá / CVD (tiếng Việt), null nếu không có. */
  divergence: string | null;
}

const delta = (c: SpotCandle) => 2 * c.takerBuy - c.volume;

/** CVD từ nến 1m (taker buy volume). */
export function cvdStats(candles: readonly SpotCandle[]): CvdStats | null {
  if (!candles.length) return null;
  const sumDelta = (cs: readonly SpotCandle[]) => r3(cs.reduce((a, c) => a + delta(c), 0));
  const last = (n: number) => candles.slice(-n);
  const change = (cs: readonly SpotCandle[]) => (cs.length ? r2(cs.at(-1)!.close - cs[0]!.open) : 0);
  const w4 = last(240);
  // CVD cộng dồn trong 4h để so đỉnh/đáy với giá.
  let cum = 0;
  const cvd = w4.map(c => (cum += delta(c)));
  const tail = 30;
  let divergence: string | null = null;
  if (w4.length > tail * 2) {
    const headIdx = w4.length - tail;
    const priorHigh = Math.max(...w4.slice(0, headIdx).map(c => c.high));
    const priorLow = Math.min(...w4.slice(0, headIdx).map(c => c.low));
    const priorCvdHigh = Math.max(...cvd.slice(0, headIdx));
    const priorCvdLow = Math.min(...cvd.slice(0, headIdx));
    const recentHigh = Math.max(...w4.slice(headIdx).map(c => c.high));
    const recentLow = Math.min(...w4.slice(headIdx).map(c => c.low));
    const recentCvdHigh = Math.max(...cvd.slice(headIdx));
    const recentCvdLow = Math.min(...cvd.slice(headIdx));
    if (recentHigh > priorHigh && recentCvdHigh < priorCvdHigh) {
      divergence = 'Giá lên đỉnh mới trong 4 giờ nhưng CVD không lên đỉnh mới (phân kỳ giảm: lực mua chủ động yếu dần)';
    } else if (recentLow < priorLow && recentCvdLow > priorCvdLow) {
      divergence = 'Giá xuống đáy mới trong 4 giờ nhưng CVD không xuống đáy mới (phân kỳ tăng: lực bán chủ động yếu dần / có hấp thụ)';
    }
  }
  return {
    total: sumDelta(candles),
    last4h: sumDelta(w4),
    last1h: sumDelta(last(60)),
    priceChange4h: change(w4),
    priceChange1h: change(last(60)),
    divergence,
  };
}

export interface Absorption {
  /** Cận dưới bucket (spot). */
  price: number;
  /** Bên chủ động bị hấp thụ: SELL = bên bán đập vào nhưng giá giữ (hỗ trợ), BUY = bên mua đẩy nhưng giá không qua (kháng cự). */
  aggressor: 'BUY' | 'SELL';
  qty: number;
  trades: number;
  lastAt: number;
}

export interface AbsorptionOptions {
  bucket: number;
  now: number;
  windowMin?: number;
  /** Tổng khối lượng chủ động tối thiểu tại một bucket. */
  minQty: number;
  /** Phải giữ được ít nhất chừng này phút sau lệnh lớn cuối. */
  holdMin?: number;
}

/**
 * Hấp thụ: lệnh market lớn dồn vào một bucket mà sau đó giá không xuyên qua quá 1 bucket.
 * Bán chủ động lớn ở đáy mà giá giữ → bên mua bị động hấp thụ (hỗ trợ); ngược lại ở đỉnh.
 */
export function findAbsorption(trades: readonly BigTrade[], candles: readonly SpotCandle[], opts: AbsorptionOptions): Absorption[] {
  const { bucket, now, windowMin = 120, minQty, holdMin = 5 } = opts;
  const from = now - windowMin * 60;
  const groups = new Map<string, Absorption>();
  for (const tr of trades) {
    if (tr.t < from || tr.t > now) continue;
    const price = Math.floor(tr.price / bucket) * bucket;
    const key = `${tr.side}:${price}`;
    const g = groups.get(key) ?? { price, aggressor: tr.side, qty: 0, trades: 0, lastAt: 0 };
    g.qty = r3(g.qty + tr.qty);
    g.trades += 1;
    g.lastAt = Math.max(g.lastAt, tr.t);
    groups.set(key, g);
  }
  const out: Absorption[] = [];
  for (const g of groups.values()) {
    if (g.qty < minQty || now - g.lastAt < holdMin * 60) continue;
    const after = candles.filter(c => c.time + 60 > g.lastAt && c.time <= now);
    if (!after.length) continue;
    const held =
      g.aggressor === 'SELL'
        ? Math.min(...after.map(c => c.low)) >= g.price - bucket
        : Math.max(...after.map(c => c.high)) < g.price + 2 * bucket;
    if (held) out.push(g);
  }
  return out.sort((a, b) => b.qty - a.qty);
}

export interface BinanceOrderflowSnapshot {
  symbol: string;
  venue: string;
  /** Unix giây. */
  asOf: number;
  historyMin: number;
  spotPrice: number;
  /** Giá chart của app (futures) lúc lấy, chỉ để tham khảo; null = không lấy được. Các mức giữ nguyên giá spot. */
  appPrice: number | null;
  bucket: number;
  unit: string;
  walls: Wall[];
  profile: VolumeProfile | null;
  cvd: CvdStats | null;
  bigTrades: BigTrade[];
  absorption: Absorption[];
  /** Các mức (giá Binance spot, không quy đổi), server gắn thẳng vào kết quả. */
  levels: OrderflowLevel[];
  notes: string[];
}

export interface SnapshotInput {
  symbol: string;
  venue: string;
  unit: string;
  now: number;
  bucket: number;
  samples: readonly BookSample[];
  candles: readonly SpotCandle[];
  trades: readonly BigTrade[];
  appPrice: number | null;
  /** Ngưỡng hấp thụ (tổng khối lượng chủ động tại một bucket). */
  absorptionMinQty: number;
  wallOptions?: WallOptions;
}

/** Lịch sử sổ lệnh tối thiểu để tin `persistMin`. */
export const MIN_HISTORY_MIN = 30;

export function buildSnapshot(inp: SnapshotInput): BinanceOrderflowSnapshot {
  const latest = inp.samples.at(-1);
  const spotPrice = latest?.mid ?? inp.candles.at(-1)?.close ?? 0;
  // Giữ nguyên giá Binance spot (không quy đổi theo chênh lệch spot/futures).
  const toApp = (p: number) => r2(p);
  const historyMin = latest ? r2((latest.t - inp.samples[0]!.t) / 60) : 0;
  const notes: string[] = [];
  if (!latest) notes.push('Chưa có dữ liệu sổ lệnh (collector chưa chạy hoặc mất kết nối) — không có tường thanh khoản');
  else if (historyMin < MIN_HISTORY_MIN) notes.push(`Sổ lệnh mới ghi được ${Math.round(historyMin)} phút — thời gian tồn tại của tường chưa đáng tin`);

  const walls = findWalls(inp.samples, inp.wallOptions);
  const range = inp.candles.length ? Math.max(...inp.candles.map(c => c.high)) - Math.min(...inp.candles.map(c => c.low)) : 0;
  const profile = volumeProfile(inp.candles, profileBucket(range, inp.bucket));
  const cvd = cvdStats(inp.candles);
  const recentTrades = inp.trades.filter(t => t.t >= inp.now - 4 * 3600 && t.t <= inp.now);
  const bigTrades = [...recentTrades].sort((a, b) => b.qty - a.qty).slice(0, 5);
  const absorption = findAbsorption(inp.trades, inp.candles, { bucket: inp.bucket, now: inp.now, minQty: inp.absorptionMinQty });

  const maxWall = Math.max(0, ...walls.map(w => w.size));
  const fmt = (x: number) => `${r3(x)} ${inp.unit}`;
  const levels: OrderflowLevel[] = [];
  for (const w of walls) {
    levels.push({
      kind: w.side === 'BID' ? 'BID_WALL' : 'ASK_WALL',
      sourcePrice: w.price,
      price: toApp(w.price),
      size: w.size,
      sizeSource: 'BOOK',
      persistMin: w.persistMin,
      strength: r2(0.3 + 0.7 * (maxWall ? w.size / maxWall : 0)),
      note: `${w.side === 'BID' ? 'Lệnh chờ mua' : 'Lệnh chờ bán'} ${fmt(w.size)} (spot ${w.price}–${w.price + inp.bucket}), đứng ${Math.round(w.persistMin)} phút` +
        (w.maxSize > w.size * 1.3 ? `, đã giảm từ ${fmt(w.maxSize)}` : ''),
    });
  }
  if (profile) {
    levels.push({
      kind: 'POC',
      sourcePrice: profile.poc.price,
      price: toApp(profile.poc.price),
      size: profile.poc.volume,
      sizeSource: 'VOLUME',
      strength: 0.7,
      note: `Mức khớp nhiều nhất 24 giờ (${fmt(profile.poc.volume)}); vùng giá trị ${toApp(profile.valueArea.low)}–${toApp(profile.valueArea.high)}`,
    });
    for (const n of profile.hvn.slice(0, 2)) {
      levels.push({ kind: 'HVN', sourcePrice: n.price, price: toApp(n.price), size: n.volume, sizeSource: 'VOLUME', strength: 0.5, note: `Vùng volume cao 24 giờ (${fmt(n.volume)})` });
    }
    for (const n of profile.lvn.slice(0, 1)) {
      levels.push({ kind: 'LVN', sourcePrice: n.price, price: toApp(n.price), size: n.volume, sizeSource: 'VOLUME', strength: 0.4, note: `Vùng volume thấp 24 giờ — giá dễ đi nhanh qua` });
    }
  }
  for (const a of absorption.slice(0, 2)) {
    levels.push({
      kind: 'ABSORPTION',
      sourcePrice: a.price,
      price: toApp(a.price),
      size: a.qty,
      sizeSource: 'TRADES',
      strength: 0.6,
      note:
        a.aggressor === 'SELL'
          ? `Bán chủ động lớn ${fmt(a.qty)} (${a.trades} lệnh) nhưng giá giữ được — bên mua hấp thụ`
          : `Mua chủ động lớn ${fmt(a.qty)} (${a.trades} lệnh) nhưng giá không vượt được — bên bán hấp thụ`,
    });
  }

  return {
    symbol: inp.symbol,
    venue: inp.venue,
    asOf: inp.now,
    historyMin,
    spotPrice,
    appPrice: inp.appPrice,
    bucket: inp.bucket,
    unit: inp.unit,
    walls,
    profile,
    cvd,
    bigTrades,
    absorption,
    levels: levels.slice(0, 12),
    notes,
  };
}

/** Mô tả CVD ngắn gọn (tiếng Việt). */
export function cvdText(cvd: CvdStats | null, unit: string): string {
  if (!cvd) return '';
  const sign = (x: number) => `${x >= 0 ? '+' : ''}${x}`;
  return (
    `CVD 24h ${sign(cvd.total)} ${unit}; 4h ${sign(cvd.last4h)} (giá ${sign(cvd.priceChange4h)}); 1h ${sign(cvd.last1h)} (giá ${sign(cvd.priceChange1h)})` +
    (cvd.divergence ? `. ${cvd.divergence}` : '')
  );
}

export interface WallSegmentOptions {
  bucket: number;
  /** Ngưỡng khối lượng tối thiểu để tính là tường (ORDERFLOW_WALL_MIN_<SYMBOL>). */
  minSize: number;
  /** Bucket ≥ k × median cùng phía mới là tường. */
  k?: number;
  /** Tường còn tồn tại khi size ≥ tỉ lệ này × đỉnh của nó. */
  persistRatio?: number;
  /** Số mẫu hụt liên tiếp cho phép. */
  gapTolerance?: number;
  /** Bỏ tường đứng ngắn hơn số phút này. */
  minDurationMin?: number;
  /** Hai mẫu cách nhau quá số giây này = mất dữ liệu → đóng mọi tường. */
  maxGapSec?: number;
}

interface OpenWall {
  side: 'BID' | 'ASK';
  price: number;
  start: number;
  lastSeen: number;
  firstMiss: number | null;
  peak: number;
  misses: number;
}

/**
 * Lịch sử tường từ các mẫu sổ lệnh: mỗi tường là một đoạn [start, end]. Khi tường biến mất (hoặc còn < persistRatio × đỉnh),
 * giá chạm bucket trong khoảng [lần cuối còn thấy, lần đầu hụt] → `consumed` (end = nến 1m chạm đầu tiên), không chạm → `pulled`.
 */
export function findWallSegments(samples: readonly BookSample[], candles: readonly SpotCandle[], opts: WallSegmentOptions): WallSegment[] {
  const { bucket, minSize, k = 3, persistRatio = 0.5, gapTolerance = 1, minDurationMin = 5, maxGapSec = 300 } = opts;
  const open = new Map<string, OpenWall>();
  const out: WallSegment[] = [];
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const latest = sorted.at(-1);

  const touched = (w: OpenWall, from: number, to: number, mids: number[]): number | null => {
    const hit = (lo: number, hi: number) => (w.side === 'BID' ? lo <= w.price + bucket : hi >= w.price);
    for (const c of candles) {
      if (c.time + 60 <= from || c.time > to) continue;
      if (hit(c.low, c.high)) return Math.max(from, c.time);
    }
    return mids.some(m => hit(m, m)) ? to : null;
  };
  const close = (w: OpenWall, mids: number[]) => {
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
      const th = Math.max(k * median(levels.map(l => l[1])), minSize);
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
    // Hụt trong ngưỡng nhiễu ở mẫu cuối → vẫn coi là còn tồn tại.
    if (latest && latest.t - w.start >= minDurationMin * 60) {
      out.push({ side: w.side, sourcePrice: w.price, start: w.start, end: null, peakSize: r3(w.peak), status: 'active' });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
