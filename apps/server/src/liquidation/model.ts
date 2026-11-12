import type { LiquidationEvent, LiquidationHeatmap, LiqSide, LiqVenue } from '@wca/shared';

// Mô hình mức thanh lý ước tính (kiểu Coinglass) từ open interest + nến, và các hàm gộp thanh lý thật.
// Pure: không I/O, test trong tests/liquidation.test.ts.

export interface OiPoint {
  /** Unix giây của snapshot OI. */
  t: number;
  /** Open interest theo đồng gốc (BTC). */
  oi: number;
}

export interface ModelCandle {
  /** Unix giây mở nến (cùng chu kỳ OI, vd 5m). */
  time: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Khối lượng mua chủ động. */
  takerBuy: number;
}

export interface LeverageTier {
  lev: number;
  weight: number;
}

export interface LiqModelOptions {
  bucket: number;
  tiers: readonly LeverageTier[];
  /** Tỷ lệ ký quỹ duy trì (vd 0.004). */
  mmr: number;
}

/** `10:0.3,25:0.3,50:0.25,100:0.15` → tiers (trọng số chuẩn hoá về tổng 1); sai cú pháp → mặc định. */
export function parseLeverage(raw: string | undefined): LeverageTier[] {
  const def = [
    { lev: 10, weight: 0.3 },
    { lev: 25, weight: 0.3 },
    { lev: 50, weight: 0.25 },
    { lev: 100, weight: 0.15 },
  ];
  if (!raw) return def;
  const tiers = raw.split(',').map(p => {
    const [l, w] = p.split(':').map(Number);
    return { lev: l!, weight: w! };
  });
  if (!tiers.length || tiers.some(t => !(t.lev > 1) || !(t.weight > 0))) return def;
  const sum = tiers.reduce((s, t) => s + t.weight, 0);
  return tiers.map(t => ({ lev: t.lev, weight: t.weight / sum }));
}

export function liqPrice(entry: number, lev: number, mmr: number, side: LiqSide): number {
  return side === 'LONG' ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
}

/** Trạng thái các mức thanh lý đang mở: bucket giá (cận dưới) → khối lượng. */
export interface LiqLevels {
  long: Map<number, number>;
  short: Map<number, number>;
}

const bucketOf = (p: number, bucket: number) => Math.floor(p / bucket) * bucket;

/**
 * Áp một bước mô hình (một nến, ΔOI tương ứng):
 * 1. giá quét: mức long ≥ low và mức short ≤ high bị xoá (đã thanh lý);
 * 2. ΔOI > 0: vị thế mới ở giá điển hình, long = ΔOI × tỷ lệ mua chủ động, short = phần còn lại, rải theo đòn bẩy;
 *    ΔOI < 0: mọi mức giảm theo |ΔOI| / OI trước.
 */
export function stepLevels(lv: LiqLevels, c: ModelCandle, prevOi: number, oi: number, o: LiqModelOptions): void {
  for (const p of [...lv.long.keys()]) if (p + o.bucket > c.low) lv.long.delete(p);
  for (const p of [...lv.short.keys()]) if (p < c.high) lv.short.delete(p);
  const d = oi - prevOi;
  if (d > 0) {
    const entry = (c.high + c.low + c.close) / 3;
    const buy = c.volume > 0 ? Math.min(1, Math.max(0, c.takerBuy / c.volume)) : 0.5;
    for (const [side, qty] of [
      ['LONG', d * buy],
      ['SHORT', d * (1 - buy)],
    ] as const) {
      const m = side === 'LONG' ? lv.long : lv.short;
      for (const t of o.tiers) {
        const key = bucketOf(liqPrice(entry, t.lev, o.mmr, side), o.bucket);
        m.set(key, (m.get(key) ?? 0) + qty * t.weight);
      }
    }
  } else if (d < 0 && prevOi > 0) {
    const k = Math.max(0, 1 + d / prevOi);
    for (const m of [lv.long, lv.short]) for (const [p, q] of m) m.set(p, q * k);
  }
}

export interface HeatmapOptions extends LiqModelOptions {
  /** Độ dài cột (giây), bội số chu kỳ OI. */
  colSec: number;
  maxCols: number;
  /** Bỏ ô nhỏ hơn tỷ lệ này so với ô lớn nhất. */
  minRatio: number;
  /** Bỏ thêm các ô dưới phân vị này (0 = không bỏ). */
  keepQuantile?: number;
  /** Khối lượng ở phân vị này ứng với cường độ 255 (ô lớn hơn bị kẹp); 1 = ô lớn nhất. */
  scaleQuantile?: number;
}

export interface HeatmapResult {
  heatmap: LiquidationHeatmap | null;
  /** Các mức còn mở sau bước cuối. */
  levels: LiqLevels;
}

/**
 * Chạy mô hình trên chuỗi OI + nến (cùng chu kỳ), chụp trạng thái cuối mỗi cột.
 * Nến `time = t` ứng với OI chuyển từ snapshot `t` sang snapshot kế tiếp.
 */
export function buildHeatmap(oi: readonly OiPoint[], candles: readonly ModelCandle[], o: HeatmapOptions): HeatmapResult {
  const lv: LiqLevels = { long: new Map(), short: new Map() };
  const byTime = new Map(candles.map(c => [c.time, c]));
  const pts = [...oi].sort((a, b) => a.t - b.t);
  const snaps: { col: number; cells: Map<number, number> }[] = [];
  // Cột cuối = cột của bước cuối (nến mở tại snapshot OI áp chót).
  const firstCol = pts.length >= 2 ? Math.floor(pts.at(-2)!.t / o.colSec) * o.colSec - (o.maxCols - 1) * o.colSec : 0;
  const snapshot = (col: number) => {
    if (col < firstCol) return;
    const cells = new Map<number, number>();
    for (const m of [lv.long, lv.short]) for (const [p, q] of m) cells.set(p, (cells.get(p) ?? 0) + q);
    snaps.push({ col, cells });
  };
  let curCol: number | null = null;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const c = byTime.get(prev.t);
    const col = Math.floor(prev.t / o.colSec) * o.colSec;
    if (curCol !== null && col !== curCol) snapshot(curCol);
    curCol = col;
    if (c) stepLevels(lv, c, prev.oi, cur.oi, o);
  }
  if (curCol !== null) snapshot(curCol);
  if (!snaps.length) return { heatmap: null, levels: lv };

  let pMin = Infinity;
  const all: number[] = [];
  for (const s of snaps) for (const q of s.cells.values()) if (q > 0) all.push(q);
  all.sort((a, b) => a - b);
  const peak = all.at(-1) ?? 0;
  const quant = (x: number) => all[Math.min(all.length - 1, Math.max(0, Math.floor(x * (all.length - 1))))] ?? 0;
  const maxQty = (o.scaleQuantile ?? 1) >= 1 ? peak : quant(o.scaleQuantile!);
  const minQty = Math.max(peak * o.minRatio, o.keepQuantile ? quant(o.keepQuantile) : 0);
  for (const s of snaps) for (const [p, q] of s.cells) if (q >= minQty && p < pMin) pMin = p;
  if (!(maxQty > 0) || !Number.isFinite(pMin)) return { heatmap: null, levels: lv };
  const data = snaps.map(s => {
    const flat: number[] = [];
    for (const [p, q] of [...s.cells].sort((a, b) => a[0] - b[0])) {
      if (q < minQty) continue;
      flat.push(Math.round((p - pMin) / o.bucket), Math.max(1, Math.min(255, Math.round((255 * q) / maxQty))));
    }
    return flat;
  });
  return {
    heatmap: {
      colSec: o.colSec,
      bucket: o.bucket,
      priceMin: pMin,
      cols: snaps.map(s => s.col),
      data,
      maxQty: Math.round(maxQty * 1000) / 1000,
      asOf: pts.at(-1)!.t,
    },
    levels: lv,
  };
}

export interface LiqZone {
  side: LiqSide;
  low: number;
  high: number;
  qty: number;
}

/**
 * Vùng mức thanh lý dày nhất: cửa sổ `width` bucket liên tiếp, lấy `n` vùng không chồng nhau mỗi phía.
 * LONG (dưới giá) lấy từ `levels.long`, SHORT (trên giá) từ `levels.short`.
 */
export function topZones(levels: LiqLevels, price: number, bucket: number, n = 3, width = 3): LiqZone[] {
  const out: LiqZone[] = [];
  for (const side of ['SHORT', 'LONG'] as const) {
    const m = side === 'LONG' ? levels.long : levels.short;
    const keys = [...m.keys()].filter(p => (side === 'LONG' ? p < price : p >= price));
    const windows = keys.map(start => {
      let qty = 0;
      for (let k = 0; k < width; k++) qty += m.get(start + k * bucket) ?? 0;
      return { start, qty };
    });
    windows.sort((a, b) => b.qty - a.qty);
    const picked: { start: number; qty: number }[] = [];
    for (const w of windows) {
      if (picked.length >= n) break;
      if (picked.some(p => Math.abs(p.start - w.start) < width * bucket)) continue;
      picked.push(w);
    }
    for (const p of picked.sort((a, b) => (side === 'LONG' ? b.start - a.start : a.start - b.start))) {
      out.push({ side, low: p.start, high: p.start + width * bucket, qty: Math.round(p.qty * 1000) / 1000 });
    }
  }
  return out;
}

// ---------- Thanh lý thật ----------

export interface RawLiquidation {
  venue: LiqVenue;
  /** Unix ms. */
  ts: number;
  side: LiqSide;
  price: number;
  qty: number;
}

/** Message `forceOrder` của Binance Futures → thanh lý (S=SELL: long bị thanh lý). */
export function parseBinanceForceOrder(msg: unknown, symbol: string): RawLiquidation | null {
  const o = (msg as { o?: Record<string, unknown> })?.o;
  if (!o || o.s !== symbol) return null;
  const qty = Number(o.z ?? o.q);
  const price = Number(o.ap ?? o.p);
  const ts = Number(o.T);
  if (!(qty > 0) || !(price > 0) || !Number.isFinite(ts)) return null;
  return { venue: 'binance', ts, side: o.S === 'SELL' ? 'LONG' : 'SHORT', price, qty };
}

/** Message kênh `liquidation-orders` của OKX → các thanh lý của `instId` (sz hợp đồng × ctVal). */
export function parseOkxLiquidations(msg: unknown, instId: string, ctVal: number): RawLiquidation[] {
  const data = (msg as { data?: { instId?: string; details?: Record<string, string>[] }[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: RawLiquidation[] = [];
  for (const d of data) {
    if (d.instId !== instId) continue;
    for (const x of d.details ?? []) {
      const qty = Number(x.sz) * ctVal;
      const price = Number(x.bkPx);
      const ts = Number(x.ts);
      if (!(qty > 0) || !(price > 0) || !Number.isFinite(ts)) continue;
      // posSide long/short; chế độ net: side sell = đóng long.
      const side: LiqSide = x.posSide === 'long' ? 'LONG' : x.posSide === 'short' ? 'SHORT' : x.side === 'sell' ? 'LONG' : 'SHORT';
      out.push({ venue: 'okx', ts, side, price, qty });
    }
  }
  return out;
}

export interface StoredLiquidation {
  t: number;
  venue: LiqVenue;
  side: LiqSide;
  price: number;
  qty: number;
}

/** Gộp thanh lý theo nến (`tfSec`) + phía; bỏ cụm < `minQty`. Giá = VWAP. */
export function bucketLiquidations(rows: readonly StoredLiquidation[], tfSec: number, minQty: number): LiquidationEvent[] {
  const m = new Map<string, { t: number; side: LiqSide; qty: number; notional: number; venues: Set<LiqVenue> }>();
  for (const r of rows) {
    const t = Math.floor(r.t / tfSec) * tfSec;
    const key = `${t}:${r.side}`;
    const g = m.get(key) ?? { t, side: r.side, qty: 0, notional: 0, venues: new Set<LiqVenue>() };
    g.qty += r.qty;
    g.notional += r.qty * r.price;
    g.venues.add(r.venue);
    m.set(key, g);
  }
  return [...m.values()]
    .filter(g => g.qty >= minQty)
    .sort((a, b) => a.t - b.t)
    .map(g => ({
      t: g.t,
      side: g.side,
      price: Math.round((g.notional / g.qty) * 100) / 100,
      qty: Math.round(g.qty * 1000) / 1000,
      venues: [...g.venues].sort(),
    }));
}

/** Ngưỡng cụm theo khung: `minQty1m × √(tfSec / 60)`. */
export function bubbleMinQty(minQty1m: number, tfSec: number): number {
  return minQty1m * Math.sqrt(Math.max(1, tfSec / 60));
}
