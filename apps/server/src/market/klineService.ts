import { tfSeconds, type Candle, type KlinesResponse, type Timeframe } from '@wca/shared';
import type { Db } from '../db/index.ts';
import type { MarketDataProvider } from './provider.ts';

export interface GetKlinesOptions {
  symbol: string;
  tf: Timeframe;
  limit: number;
  endTime?: number;
  /** Chỉ trả nến đã đóng (dùng cho agent). */
  closedOnly?: boolean;
}

interface MemoEntry {
  at: number;
  candles: Candle[];
}

export function isCandleClosed(candle: Candle, tf: Timeframe, nowSec: number): boolean {
  return candle.time + tfSeconds(tf) <= nowSec;
}

/**
 * Lấy klines từ provider, lưu vào SQLite; khi provider lỗi thì trả dữ liệu cache.
 * Có memo ngắn hạn trong bộ nhớ cho request "mới nhất" để UI/agent không gọi sàn liên tục.
 */
export class KlineService {
  private memo = new Map<string, MemoEntry>();
  private readonly upsert;
  private readonly selectLatest;
  private readonly selectBefore;

  constructor(
    private readonly db: Db,
    private readonly provider: MarketDataProvider,
    private readonly memoTtlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {
    this.upsert = db.prepare(
      `INSERT INTO klines (symbol, tf, open_time, open, high, low, close, volume)
       VALUES (@symbol, @tf, @time, @open, @high, @low, @close, @volume)
       ON CONFLICT(symbol, tf, open_time) DO UPDATE SET
         open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`,
    );
    this.selectLatest = db.prepare(
      `SELECT open_time AS time, open, high, low, close, volume FROM klines
       WHERE symbol = ? AND tf = ? ORDER BY open_time DESC LIMIT ?`,
    );
    this.selectBefore = db.prepare(
      `SELECT open_time AS time, open, high, low, close, volume FROM klines
       WHERE symbol = ? AND tf = ? AND open_time <= ? ORDER BY open_time DESC LIMIT ?`,
    );
  }

  async getKlines(opts: GetKlinesOptions): Promise<KlinesResponse> {
    const { symbol, tf, endTime, closedOnly = false } = opts;
    const limit = Math.min(Math.max(opts.limit, 1), this.provider.maxLimit);
    // Lấy dư 1 nến để còn đủ `limit` nến sau khi bỏ nến đang chạy.
    const fetchLimit = closedOnly ? Math.min(limit + 1, this.provider.maxLimit) : limit;

    let candles: Candle[];
    let source: KlinesResponse['source'] = 'live';
    try {
      candles = await this.fetchWithMemo(symbol, tf, fetchLimit, endTime);
    } catch (err) {
      candles = this.readCache(symbol, tf, fetchLimit, endTime);
      if (!candles.length) throw err;
      source = 'cache';
    }

    const nowSec = Math.floor(this.now() / 1000);
    const last = candles.at(-1);
    let lastCandleForming = Boolean(last && !isCandleClosed(last, tf, nowSec));
    if (closedOnly && lastCandleForming) {
      candles = candles.slice(0, -1);
      lastCandleForming = false;
    }
    return { symbol, tf, candles: candles.slice(-limit), lastCandleForming, source };
  }

  private async fetchWithMemo(symbol: string, tf: Timeframe, limit: number, endTime?: number): Promise<Candle[]> {
    const key = `${symbol}|${tf}|${limit}|${endTime ?? 'latest'}`;
    const hit = this.memo.get(key);
    if (hit && this.now() - hit.at < this.memoTtlMs) return hit.candles;
    const candles = await this.provider.fetchKlines({ symbol, tf, limit, endTime });
    this.save(symbol, tf, candles);
    this.memo.set(key, { at: this.now(), candles });
    if (this.memo.size > 200) this.memo.delete(this.memo.keys().next().value as string);
    return candles;
  }

  private save(symbol: string, tf: Timeframe, candles: Candle[]): void {
    const tx = this.db.transaction((rows: Candle[]) => {
      for (const c of rows) this.upsert.run({ symbol, tf, ...c });
    });
    tx(candles);
  }

  readCache(symbol: string, tf: Timeframe, limit: number, endTime?: number): Candle[] {
    const rows = (endTime
      ? this.selectBefore.all(symbol, tf, endTime, limit)
      : this.selectLatest.all(symbol, tf, limit)) as Candle[];
    return rows.reverse();
  }
}
