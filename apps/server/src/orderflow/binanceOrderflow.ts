import { BOOK_HEATMAP_HOURS, BOOK_HEATMAP_MAX_COLS, type BookHeatmap, type WallSegment } from '@wca/shared';
import { buildHeatColumns, colStart, type HeatColumn } from './bookHeatmap.ts';
import { basisByMinute, buildSnapshot, findWallSegments, medianBasis, type BinanceOrderflowSnapshot, type SpotCandle } from './calc.ts';
import type { BookSample } from './localBook.ts';
import type { BookMarket } from './localBook.ts';
import { BINANCE_FUTURES_REST, BINANCE_SPOT_REST, BookCollector, type CollectorStatus } from './collector.ts';

// Order flow Binance (spot hoặc USDⓈ-M futures): quản lý collector theo symbol chart, lấy nến 1m nguồn (taker buy)
// và dựng bản tóm tắt cho agent. Giá nguồn được quy đổi về giá chart bằng basis ổn định.

/** Nguồn Binance của một symbol chart. */
export interface OrderflowSourceRef {
  market: BookMarket;
  symbol: string;
}

/** Nguồn của symbol chart (mặc định: spot cùng tên). */
export function sourceOf(sources: Record<string, OrderflowSourceRef> | undefined, symbol: string): OrderflowSourceRef {
  return sources?.[symbol] ?? { market: 'spot', symbol };
}

/** Tên nguồn hiển thị cho agent/panel. */
export function venueLabel(src: OrderflowSourceRef): string {
  return src.market === 'futures' ? `Binance Futures ${src.symbol} perp` : 'Binance spot';
}

export interface OrderflowSource {
  samples(from: number, to: number): ReturnType<BookCollector['samples']>;
  rawSamples(from: number, to: number): BookSample[];
  trades(from: number, to: number): ReturnType<BookCollector['trades']>;
  status(): CollectorStatus;
}

export interface BinanceOrderflowOptions {
  collectors: Record<string, OrderflowSource>;
  /** Symbol chart → nguồn Binance; thiếu = spot cùng tên. */
  sources?: Record<string, OrderflowSourceRef>;
  buckets: Record<string, number>;
  absorptionQty: Record<string, number>;
  /** Ngưỡng khối lượng tối thiểu của tường (lịch sử tường), theo symbol. */
  wallMin?: Record<string, number>;
  /** Offset dự phòng giá nguồn − giá chart theo symbol (khi không tính được basis). */
  offsets?: Record<string, number>;
  /** Nến 1m của chart ĐÃ ĐÓNG ~24h, để tính basis; không có → dùng offset dự phòng. */
  chartCandles?: (symbol: string) => Promise<readonly { time: number; close: number }[]>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Cửa sổ dữ liệu: sổ lệnh 4 giờ gần nhất để tính tường (persistMin tối đa 240); nến/lệnh lớn 24 giờ. */
export const BOOK_WINDOW_MIN = 240;
export const TRADE_WINDOW_H = 24;

type RawSpotKline = [number, string, string, string, string, string, number, string, number, string, ...unknown[]];

export function parseSpotKline(k: RawSpotKline): SpotCandle {
  return {
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    takerBuy: Number(k[9]),
  };
}

/** Đơn vị khối lượng theo symbol Binance (XAUUSDT: 1 hợp đồng = 1 oz). */
export function sizeUnit(sourceSymbol: string): string {
  const base = sourceSymbol.endsWith('USDT') ? sourceSymbol.slice(0, -4) : '';
  return base === 'XAU' || base === 'PAXG' ? 'oz' : base;
}

/** Bản live dùng lại trong khoảng này (nhiều tab / poll dồn). */
export const LIVE_CACHE_SEC = 10;
/** Cửa sổ lịch sử tường trên chart. */
export const WALL_HISTORY_H = 24;

export interface LiveOrderflowSnapshot extends BinanceOrderflowSnapshot {
  /** Lịch sử tường 24h (giá chart = spot − basis: hiện tại cho tường còn tồn tại, lúc kết thúc cho tường đã hết). */
  wallSegments: WallSegment[];
}

export class BinanceOrderflow {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Nến 1m nguồn đã đóng theo symbol: chỉ tải thêm phần mới. */
  private readonly candleCache = new Map<string, SpotCandle[]>();
  private readonly liveCache = new Map<string, { at: number; snap: Promise<LiveOrderflowSnapshot> }>();
  /** Mẫu sổ lệnh đã parse theo symbol: chỉ đọc thêm mẫu mới từ SQLite. */
  private readonly sampleCache = new Map<string, BookSample[]>();
  /** Nến chart đã đóng theo symbol, cache theo phút đóng gần nhất. */
  private readonly chartCache = new Map<string, { minute: number; candles: readonly { time: number; close: number }[] }>();
  /** Cột heatmap sổ lệnh đã đóng (và đã qua 1 phút để basis ổn định) theo `symbol:colSec`. */
  private readonly heatCache = new Map<string, HeatColumn[]>();
  /** Số request klines đã gọi (để test cache). */
  klineRequests = 0;

  constructor(private readonly opts: BinanceOrderflowOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get symbols(): string[] {
    return Object.keys(this.opts.collectors);
  }

  has(symbol: string): boolean {
    return symbol in this.opts.collectors;
  }

  status(symbol: string): CollectorStatus | null {
    return this.opts.collectors[symbol]?.status() ?? null;
  }

  source(symbol: string): OrderflowSourceRef {
    return sourceOf(this.opts.sources, symbol);
  }

  /** Nến 1m nguồn (spot / futures Binance) ĐÃ ĐÓNG trong `hours` giờ tới `now` (cache, chỉ tải phần mới). */
  async spotCandles(symbol: string, now: number, hours = TRADE_WINDOW_H): Promise<SpotCandle[]> {
    const from = now - hours * 3600;
    const cached = (this.candleCache.get(symbol) ?? []).filter(c => c.time >= from && c.time + 60 <= now);
    const lastTime = cached.at(-1)?.time;
    // Đã có nến đóng mới nhất → không gọi Binance.
    if (cached.length && cached[0]!.time < from + 60 && lastTime !== undefined && lastTime + 120 > now) return cached;
    const startSec = cached.length && cached[0]!.time < from + 60 ? lastTime! + 60 : from;
    const fresh = await this.fetchSpotCandles(symbol, startSec, now);
    const merged = startSec === from ? fresh : [...cached, ...fresh.filter(c => c.time > lastTime!)];
    this.candleCache.set(symbol, merged);
    return merged;
  }

  private async fetchSpotCandles(symbol: string, fromSec: number, now: number): Promise<SpotCandle[]> {
    const out: SpotCandle[] = [];
    const src = this.source(symbol);
    const base = src.market === 'futures' ? `${BINANCE_FUTURES_REST}/fapi/v1/klines` : `${BINANCE_SPOT_REST}/api/v3/klines`;
    let start = fromSec * 1000;
    const end = now * 1000;
    while (start < end) {
      const params = new URLSearchParams({ symbol: src.symbol, interval: '1m', startTime: String(start), endTime: String(end), limit: '1000' });
      this.klineRequests++;
      const res = await this.fetchImpl(`${base}?${params}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Binance ${src.market} klines ${res.status}`);
      const rows = (await res.json()) as RawSpotKline[];
      if (!rows.length) break;
      out.push(...rows.map(parseSpotKline));
      start = rows.at(-1)![0] + 60_000;
      if (rows.length < 1000) break;
    }
    return out.filter(c => c.time + 60 <= now);
  }

  /** Mẫu sổ lệnh trong `hours` giờ tới `now` (cache, chỉ đọc mẫu mới). */
  historySamples(symbol: string, now: number, hours = WALL_HISTORY_H): BookSample[] {
    const src = this.opts.collectors[symbol];
    if (!src) return [];
    const from = now - hours * 3600;
    const cached = (this.sampleCache.get(symbol) ?? []).filter(s => s.t >= from);
    const lastT = cached.at(-1)?.t;
    const fresh = src.rawSamples(lastT !== undefined ? lastT + 1 : from, now);
    const merged = [...cached, ...fresh];
    this.sampleCache.set(symbol, merged);
    return merged;
  }

  /**
   * Basis nguồn − chart tại thời điểm bất kỳ: trung vị 60 phút `close nguồn − close chart` (chỉ đổi khi có nến đóng mới).
   * Thiếu dữ liệu → offset dự phòng (`fallback = true`).
   */
  async basisFn(symbol: string, now: number): Promise<{ at: (t: number) => number; current: number; fallback: boolean }> {
    const fallbackValue = this.opts.offsets?.[symbol] ?? 0;
    let chart: readonly { time: number; close: number }[] = [];
    if (this.opts.chartCandles) {
      const minute = Math.floor(now / 60) * 60;
      const hit = this.chartCache.get(symbol);
      if (hit && hit.minute === minute) chart = hit.candles;
      else {
        try {
          chart = await this.opts.chartCandles(symbol);
          this.chartCache.set(symbol, { minute, candles: chart });
        } catch {
          chart = hit?.candles ?? [];
        }
      }
    }
    const byMin = basisByMinute(await this.spotCandles(symbol, now), chart);
    const lastClosed = Math.floor(now / 60) * 60 - 60;
    // Thị trường nghỉ (vàng cuối tuần): không có cặp nến mới → dùng basis của phút gần nhất còn dữ liệu.
    const lastPair = [...byMin.keys()].reduce((m, t) => (t <= lastClosed && t > m ? t : m), -Infinity);
    const cur = medianBasis(byMin, lastClosed) ?? (Number.isFinite(lastPair) ? medianBasis(byMin, lastPair) : null);
    const current = cur ?? fallbackValue;
    return { at: t => medianBasis(byMin, Math.min(Math.floor(t / 60) * 60, lastClosed)) ?? current, current, fallback: cur === null };
  }

  /** Lịch sử tường 24h (chưa quy đổi giá). */
  async wallSegments(symbol: string, now: number): Promise<WallSegment[]> {
    const candles = await this.spotCandles(symbol, now);
    return findWallSegments(this.historySamples(symbol, now), candles, {
      bucket: this.opts.buckets[symbol] ?? 10,
      minSize: this.opts.wallMin?.[symbol] ?? 0,
    });
  }

  /**
   * Heatmap sổ lệnh 24h theo cột `colSec` (≥ 60). `after` = mở cột ĐÃ ĐÓNG cuối cùng client có → chỉ trả cột sau đó.
   * Cột đã đóng (cộng 1 phút cho basis ổn định) được cache, mỗi lần chỉ tính cột mới + cột đang chạy.
   */
  async bookHeatmap(symbol: string, colSecIn: number, after?: number): Promise<BookHeatmap> {
    const src = this.opts.collectors[symbol];
    if (!src) throw new Error(`Chưa bật order flow Binance cho ${symbol}`);
    const now = this.now();
    const colSec = Math.max(60, Math.floor(colSecIn));
    const bucket = this.opts.buckets[symbol] ?? 10;
    const from = colStart(Math.max(now - BOOK_HEATMAP_HOURS * 3600, now - (BOOK_HEATMAP_MAX_COLS - 1) * colSec), colSec);
    const basis = await this.basisFn(symbol, now);
    const key = `${symbol}:${colSec}`;
    const cached = (this.heatCache.get(key) ?? []).filter(c => c.t >= from);
    const freshFrom = cached.length ? cached.at(-1)!.t + colSec : from;
    const samples = this.historySamples(symbol, now, BOOK_HEATMAP_HOURS).filter(s => s.t >= freshFrom && s.t <= now);
    const fresh = buildHeatColumns(samples, { colSec, bucket, basisAt: t => basis.at(t) });
    const stable = (c: HeatColumn) => c.t + colSec + 60 <= now;
    const closedFresh = fresh.filter(stable);
    const cols = [...cached, ...closedFresh];
    this.heatCache.set(key, cols);
    const all = [...cols, ...fresh.filter(c => !stable(c))];
    const out = after !== undefined && Number.isFinite(after) ? all.filter(c => c.t > after) : all;
    const last = out.at(-1);
    return {
      symbol,
      colSec,
      bucket,
      cols: out.map(c => c.t),
      shift: out.map(c => c.shift),
      data: out.map(c => c.data),
      unit: sizeUnit(this.source(symbol).symbol),
      partialLast: Boolean(last && last.t + colSec > now),
      asOf: now,
    };
  }

  /** Order flow hiện tại cho chart (dùng lại bản tính trong LIVE_CACHE_SEC giây). */
  live(symbol: string, appPrice: () => Promise<number | null>): Promise<LiveOrderflowSnapshot> {
    const now = this.now();
    const hit = this.liveCache.get(symbol);
    if (hit && now - hit.at < LIVE_CACHE_SEC) return hit.snap;
    const snap = appPrice().then(async p => {
      const base = await this.snapshot(symbol, p);
      const basis = await this.basisFn(symbol, base.asOf);
      const segs = await this.wallSegments(symbol, base.asOf);
      // Tường đã kết thúc: basis lúc kết thúc → giá cố định mãi; tường còn tồn tại: basis hiện tại.
      const wallSegments = segs.map(sg => ({
        ...sg,
        price: Math.round((sg.sourcePrice - (sg.end === null ? base.offset : basis.at(sg.end))) * 100) / 100,
      }));
      return { ...base, wallSegments };
    });
    this.liveCache.set(symbol, { at: now, snap });
    snap.catch(() => this.liveCache.delete(symbol));
    return snap;
  }

  /** Bản tóm tắt order flow tại `now`; quy đổi bằng basis ổn định; `appPrice` = giá chart lúc đó (tham khảo). */
  async snapshot(symbol: string, appPrice: number | null): Promise<BinanceOrderflowSnapshot> {
    const src = this.opts.collectors[symbol];
    if (!src) throw new Error(`Chưa bật order flow Binance cho ${symbol}`);
    const ref = this.source(symbol);
    const now = this.now();
    const candles = await this.spotCandles(symbol, now);
    const bucket = this.opts.buckets[symbol] ?? 10;
    const basis = await this.basisFn(symbol, now);
    const snap = buildSnapshot({
      symbol,
      venue: venueLabel(ref),
      unit: sizeUnit(ref.symbol),
      now,
      bucket,
      samples: src.samples(now - BOOK_WINDOW_MIN * 60, now),
      candles,
      trades: src.trades(now - TRADE_WINDOW_H * 3600, now),
      appPrice,
      absorptionMinQty: this.opts.absorptionQty[symbol] ?? Number.POSITIVE_INFINITY,
      offset: basis.current,
    });
    if (basis.fallback) snap.notes.push(`Chưa đủ dữ liệu nến chart để tính basis — dùng offset dự phòng ${basis.current}`);
    const st = src.status();
    if (ref.market === 'futures' && st.coverHigh > st.coverLow) {
      const half = Math.round(((st.coverHigh - st.coverLow) / 2) * 10) / 10;
      snap.notes.push(`Sổ lệnh futures chỉ phủ khoảng ±${half} quanh giá (snapshot 1000 mức); tường xa hơn không thấy được`);
    }
    return snap;
  }
}
