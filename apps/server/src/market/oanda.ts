import { oandaInstrument, type Candle, type Timeframe } from '@wca/shared';
import type { FetchKlinesParams, MarketDataProvider } from './provider.ts';

// OANDA v20 REST: nến `GET /v3/instruments/{instrument}/candles`. Volume = tick volume.
// Thời gian dùng header `Accept-Datetime-Format: UNIX` (giây, dạng chuỗi thập phân).

export const OANDA_HOSTS = {
  practice: 'https://api-fxpractice.oanda.com',
  live: 'https://api-fxtrade.oanda.com',
} as const;

const GRANULARITY: Record<Timeframe, string> = {
  '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30', '1h': 'H1', '4h': 'H4', '1d': 'D', '1w': 'W',
};

export interface OandaOptions {
  token?: string;
  env: keyof typeof OANDA_HOSTS;
  /** M = mid, B = bid, A = ask. */
  price: 'M' | 'B' | 'A';
  fetchImpl?: typeof fetch;
}

interface OandaCandle {
  complete: boolean;
  volume: number;
  time: string;
  mid?: OandaOhlc;
  bid?: OandaOhlc;
  ask?: OandaOhlc;
}
interface OandaOhlc { o: string; h: string; l: string; c: string }

const PRICE_KEY = { M: 'mid', B: 'bid', A: 'ask' } as const;

export function parseOandaCandles(body: { candles?: OandaCandle[] }, price: 'M' | 'B' | 'A'): Candle[] {
  const key = PRICE_KEY[price];
  return (body.candles ?? []).flatMap(c => {
    const p = c[key];
    if (!p) return [];
    return [{
      time: Math.floor(Number(c.time)),
      open: Number(p.o),
      high: Number(p.h),
      low: Number(p.l),
      close: Number(p.c),
      volume: c.volume,
    }];
  });
}

/** Tham số query cho một lần lấy nến (pure, để test). */
export function buildOandaCandleQuery(tf: Timeframe, limit: number, price: 'M' | 'B' | 'A', endTime?: number): URLSearchParams {
  const q = new URLSearchParams({
    granularity: GRANULARITY[tf],
    price,
    count: String(limit),
    // Căn nến ngày / H4 theo giờ New York 17:00 (mặc định của OANDA, khớp chart OANDA trên TradingView).
    dailyAlignment: '17',
    alignmentTimezone: 'America/New_York',
    weeklyAlignment: 'Sunday',
  });
  // `to` loại trừ mốc cuối → +1 giây để gồm nến có open time = endTime.
  if (endTime) q.set('to', String(endTime + 1));
  return q;
}

export class OandaProvider implements MarketDataProvider {
  readonly name = 'oanda';
  readonly maxLimit = 5000;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OandaOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.opts.token);
  }

  async fetchKlines({ symbol, tf, limit, endTime }: FetchKlinesParams): Promise<Candle[]> {
    if (!this.opts.token) throw new Error('Chưa cấu hình OANDA_API_TOKEN trong .env (cần cho XAUUSD từ OANDA)');
    const q = buildOandaCandleQuery(tf, Math.min(Math.max(limit, 1), this.maxLimit), this.opts.price, endTime);
    const url = `${OANDA_HOSTS[this.opts.env]}/v3/instruments/${oandaInstrument(symbol)}/candles?${q}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.opts.token}`, 'Accept-Datetime-Format': 'UNIX' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OANDA ${res.status}: ${body.slice(0, 200)}`);
    }
    return parseOandaCandles((await res.json()) as { candles?: OandaCandle[] }, this.opts.price);
  }
}
