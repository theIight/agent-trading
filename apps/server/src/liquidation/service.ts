import type { LiquidationHeatmap, LiveLiquidations } from '@wca/shared';
import type { Db } from '../db/index.ts';
import type { LiquidationCollector } from './collector.ts';
import {
  bubbleMinQty,
  bucketLiquidations,
  buildHeatmap,
  topZones,
  type LeverageTier,
  type LiqLevels,
  type ModelCandle,
  type OiPoint,
  type StoredLiquidation,
} from './model.ts';

// Dịch vụ thanh lý: OI 5 phút + nến 5m Binance Futures (30 ngày) → heatmap ước tính; thanh lý thật từ collector.

export const BINANCE_FAPI = 'https://fapi.binance.com';
export const OI_STEP_SEC = 300;
/** Binance chỉ giữ OI history ~30 ngày. */
export const OI_HISTORY_DAYS = 29;
export const HEATMAP_MAX_COLS = 600;
export const HEATMAP_MIN_RATIO = 0.03;
/** Chỉ gửi ô từ phân vị 60 trở lên; phân vị 99 = màu đậm nhất (đa số ô nhỏ, thang tuyến tính theo ô lớn nhất thì gần như một màu). */
export const HEATMAP_KEEP_QUANTILE = 0.6;
export const HEATMAP_SCALE_QUANTILE = 0.99;
/** Số nến tối đa trả bong bóng thanh lý. */
export const BUBBLE_MAX_BARS = 500;

export interface LiquidationServiceOptions {
  db: Db;
  collectors: Record<string, Pick<LiquidationCollector, 'rows' | 'status'>>;
  buckets: Record<string, number>;
  minQty: Record<string, number>;
  tiers: readonly LeverageTier[];
  mmr: number;
  retainH: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

type RawKline = [number, string, string, string, string, string, number, string, number, string, ...unknown[]];

export class LiquidationService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly candleCache = new Map<string, ModelCandle[]>();
  /** Heatmap theo `${symbol}:${colSec}`, tính lại khi có OI mới. */
  private readonly heatCache = new Map<string, { asOf: number; result: { heatmap: LiquidationHeatmap | null; levels: LiqLevels } }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;

  constructor(private readonly opts: LiquidationServiceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get symbols(): string[] {
    return Object.keys(this.opts.collectors);
  }

  has(symbol: string): boolean {
    return symbol in this.opts.collectors;
  }

  /** Tải OI ngay rồi mỗi 5 phút. */
  start(): void {
    void this.syncAll();
    this.timer = setInterval(() => void this.syncAll(), OI_STEP_SEC * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  syncAll(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      for (const s of this.symbols) {
        try {
          await this.syncOi(s);
        } catch (err) {
          this.opts.log?.(`[liquidation] tải OI ${s} lỗi: ${(err as Error).message}`);
        }
      }
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  /** OI 5 phút: lần đầu 29 ngày, sau đó chỉ phần mới. */
  async syncOi(symbol: string): Promise<number> {
    const now = this.now();
    const last = (this.opts.db.prepare('SELECT MAX(t) AS t FROM open_interest WHERE symbol = ?').get(symbol) as { t: number | null }).t;
    let start = Math.max(last != null ? last + OI_STEP_SEC : 0, now - OI_HISTORY_DAYS * 86400);
    const insert = this.opts.db.prepare('INSERT OR REPLACE INTO open_interest (symbol, t, oi) VALUES (?, ?, ?)');
    let added = 0;
    while (start < now) {
      const end = Math.min(now, start + 500 * OI_STEP_SEC);
      const params = new URLSearchParams({ symbol, period: '5m', limit: '500', startTime: String(start * 1000), endTime: String(end * 1000) });
      const res = await this.fetchImpl(`${BINANCE_FAPI}/futures/data/openInterestHist?${params}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Binance openInterestHist ${res.status}`);
      const rows = (await res.json()) as { timestamp: number; sumOpenInterest: string }[];
      for (const r of rows) {
        const oi = Number(r.sumOpenInterest);
        if (!Number.isFinite(oi)) continue;
        insert.run(symbol, Math.floor(r.timestamp / 1000), oi);
        added++;
      }
      start = end + 1;
    }
    this.opts.db.prepare('DELETE FROM open_interest WHERE symbol = ? AND t < ?').run(symbol, now - 31 * 86400);
    return added;
  }

  oiPoints(symbol: string): OiPoint[] {
    return this.opts.db.prepare('SELECT t, oi FROM open_interest WHERE symbol = ? ORDER BY t').all(symbol) as OiPoint[];
  }

  /** Nến 5m Binance Futures đã đóng từ `from` (cache, chỉ tải phần mới). */
  async candles5m(symbol: string, from: number): Promise<ModelCandle[]> {
    const now = this.now();
    const cached = (this.candleCache.get(symbol) ?? []).filter(c => c.time >= from);
    const lastTime = cached.at(-1)?.time;
    const covered = cached.length && cached[0]!.time < from + OI_STEP_SEC;
    if (covered && lastTime !== undefined && lastTime + 2 * OI_STEP_SEC > now) return cached;
    let start = covered ? lastTime! + OI_STEP_SEC : from;
    const fresh: ModelCandle[] = [];
    while (start < now) {
      const params = new URLSearchParams({ symbol, interval: '5m', startTime: String(start * 1000), limit: '1500' });
      const res = await this.fetchImpl(`${BINANCE_FAPI}/fapi/v1/klines?${params}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Binance klines ${res.status}`);
      const rows = (await res.json()) as RawKline[];
      if (!rows.length) break;
      for (const k of rows) {
        fresh.push({ time: Math.floor(k[0] / 1000), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), takerBuy: Number(k[9]) });
      }
      start = Math.floor(rows.at(-1)![0] / 1000) + OI_STEP_SEC;
      if (rows.length < 1500) break;
    }
    const closed = fresh.filter(c => c.time + OI_STEP_SEC <= now);
    const merged = covered ? [...cached, ...closed.filter(c => c.time > lastTime!)] : closed;
    this.candleCache.set(symbol, merged);
    return merged;
  }

  /** Heatmap + mức còn mở cho độ dài cột `colSec` (cache tới khi có OI mới). */
  async heatmap(symbol: string, colSec: number): Promise<{ heatmap: LiquidationHeatmap | null; levels: LiqLevels }> {
    const col = Math.max(OI_STEP_SEC, Math.round(colSec / OI_STEP_SEC) * OI_STEP_SEC);
    const oi = this.oiPoints(symbol);
    const asOf = oi.at(-1)?.t ?? 0;
    const key = `${symbol}:${col}`;
    const hit = this.heatCache.get(key);
    if (hit && hit.asOf === asOf) return hit.result;
    const candles = oi.length ? await this.candles5m(symbol, oi[0]!.t) : [];
    const result = buildHeatmap(oi, candles, {
      bucket: this.opts.buckets[symbol] ?? 50,
      tiers: this.opts.tiers,
      mmr: this.opts.mmr,
      colSec: col,
      maxCols: HEATMAP_MAX_COLS,
      minRatio: HEATMAP_MIN_RATIO,
      keepQuantile: HEATMAP_KEEP_QUANTILE,
      scaleQuantile: HEATMAP_SCALE_QUANTILE,
    });
    this.heatCache.set(key, { asOf, result });
    return result;
  }

  /** Dữ liệu vẽ chart: bong bóng theo nến `tfSec` + heatmap. */
  async live(symbol: string, tfSec: number, heatmapAsOf?: number): Promise<LiveLiquidations> {
    const col = this.opts.collectors[symbol];
    if (!col) throw new Error(`Chưa bật thanh lý cho ${symbol}`);
    const now = this.now();
    const from = now - Math.min(this.opts.retainH * 3600, BUBBLE_MAX_BARS * tfSec);
    const events = bucketLiquidations(col.rows(from, now), tfSec, bubbleMinQty(this.opts.minQty[symbol] ?? 0, tfSec));
    const notes: string[] = [];
    let heatmap: LiquidationHeatmap | null = null;
    try {
      heatmap = (await this.heatmap(symbol, tfSec)).heatmap;
      if (heatmap && now - heatmap.asOf > 30 * 60) notes.push('OI chưa cập nhật > 30 phút — heatmap có thể cũ');
    } catch (err) {
      notes.push(`Không tính được heatmap: ${(err as Error).message}`);
    }
    const venues = col.status();
    for (const v of venues) if (!v.connected) notes.push(`Mất kết nối thanh lý ${v.venue === 'okx' ? 'OKX' : 'Binance'} — đang thử lại`);
    if (heatmap && heatmapAsOf === heatmap.asOf) return { symbol, events, heatmap: null, heatmapUnchanged: true, venues, notes };
    return { symbol, events, heatmap, venues, notes };
  }

  /** Tóm tắt cho agent (get_orderflow): thanh lý 24h + vùng heatmap dày nhất quanh `price`. */
  async summaryText(symbol: string, price: number | null): Promise<string | null> {
    const col = this.opts.collectors[symbol];
    if (!col) return null;
    const now = this.now();
    const rows = col.rows(now - 24 * 3600, now);
    const unit = symbol.endsWith('USDT') ? symbol.slice(0, -4) : '';
    const lines: string[] = [`Thanh lý thật 24h, đơn vị ${unit} (Binance + OKX; Binance chỉ đẩy 1 lệnh/giây nên đếm thiếu; chỉ có từ lúc server chạy):`];
    lines.push(...liquidationTotals(rows));
    const big = bucketLiquidations(rows, 300, 0)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5)
      .sort((a, b) => a.t - b.t);
    if (big.length) {
      lines.push('Cụm thanh lý lớn nhất (gộp 5 phút):');
      for (const e of big) lines.push(`- ${iso(e.t)} ${e.side === 'LONG' ? 'long bị thanh lý' : 'short bị thanh lý'} ${e.qty} @ ${e.price}`);
    }
    try {
      const { heatmap, levels } = await this.heatmap(symbol, OI_STEP_SEC);
      const ref = price ?? null;
      if (heatmap && ref != null) {
        const zones = topZones(levels, ref, this.opts.buckets[symbol] ?? 50);
        lines.push('', `Heatmap mức thanh lý ƯỚC TÍNH (mô hình OI Binance 29 ngày, đòn bẩy giả định; sai số có thể vài trăm $), giá hiện tại ${ref}:`);
        for (const z of zones) {
          lines.push(`- ${z.side === 'SHORT' ? 'Trên giá — short bị thanh lý' : 'Dưới giá — long bị thanh lý'} ${z.low}–${z.high}: ~${Math.round(z.qty)} ${unit}`);
        }
        if (!zones.length) lines.push('- (không có vùng đáng kể)');
      }
    } catch {
      lines.push('', 'Heatmap thanh lý: không tính được lúc này.');
    }
    return lines.join('\n');
  }
}

const iso = (t: number) => new Date(t * 1000).toISOString().replace(':00.000Z', 'Z');

export function liquidationTotals(rows: readonly StoredLiquidation[]): string[] {
  const sum = (venue: string, side: string) =>
    Math.round(rows.filter(r => r.venue === venue && r.side === side).reduce((s, r) => s + r.qty, 0) * 1000) / 1000;
  return (['binance', 'okx'] as const).map(v => `- ${v === 'okx' ? 'OKX' : 'Binance'}: long bị thanh lý ${sum(v, 'LONG')}, short bị thanh lý ${sum(v, 'SHORT')}`);
}
