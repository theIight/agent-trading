import { buildSnapshot, type BinanceOrderflowSnapshot, type SpotCandle } from './calc.ts';
import { BINANCE_SPOT_REST, BookCollector, type CollectorStatus } from './collector.ts';

// Order flow Binance spot: quản lý collector theo symbol, lấy nến 1m spot (taker buy) và dựng bản tóm tắt cho agent.

export interface OrderflowSource {
  samples(from: number, to: number): ReturnType<BookCollector['samples']>;
  trades(from: number, to: number): ReturnType<BookCollector['trades']>;
  status(): CollectorStatus;
}

export interface BinanceOrderflowOptions {
  collectors: Record<string, OrderflowSource>;
  buckets: Record<string, number>;
  absorptionQty: Record<string, number>;
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

export function sizeUnit(symbol: string): string {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : '';
}

export class BinanceOrderflow {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

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

  /** Nến 1m spot ĐÃ ĐÓNG trong `hours` giờ tới `now`. */
  async spotCandles(symbol: string, now: number, hours = TRADE_WINDOW_H): Promise<SpotCandle[]> {
    const out: SpotCandle[] = [];
    let start = (now - hours * 3600) * 1000;
    const end = now * 1000;
    while (start < end) {
      const params = new URLSearchParams({ symbol, interval: '1m', startTime: String(start), endTime: String(end), limit: '1000' });
      const res = await this.fetchImpl(`${BINANCE_SPOT_REST}/api/v3/klines?${params}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Binance spot klines ${res.status}`);
      const rows = (await res.json()) as RawSpotKline[];
      if (!rows.length) break;
      out.push(...rows.map(parseSpotKline));
      start = rows.at(-1)![0] + 60_000;
      if (rows.length < 1000) break;
    }
    return out.filter(c => c.time + 60 <= now);
  }

  /** Bản tóm tắt order flow tại `now`; `appPrice` = giá chart lúc đó (để tính basis spot → chart). */
  async snapshot(symbol: string, appPrice: number | null): Promise<BinanceOrderflowSnapshot> {
    const src = this.opts.collectors[symbol];
    if (!src) throw new Error(`Chưa bật order flow Binance cho ${symbol}`);
    const now = this.now();
    const candles = await this.spotCandles(symbol, now);
    const bucket = this.opts.buckets[symbol] ?? 10;
    return buildSnapshot({
      symbol,
      venue: 'Binance spot',
      unit: sizeUnit(symbol),
      now,
      bucket,
      samples: src.samples(now - BOOK_WINDOW_MIN * 60, now),
      candles,
      trades: src.trades(now - TRADE_WINDOW_H * 3600, now),
      appPrice,
      absorptionMinQty: this.opts.absorptionQty[symbol] ?? Number.POSITIVE_INFINITY,
    });
  }
}
