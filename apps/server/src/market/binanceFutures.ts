import type { Candle } from '@wca/shared';
import type { FetchKlinesParams, MarketDataProvider } from './provider.ts';

const BASE_URL = 'https://fapi.binance.com';

type RawKline = [number, string, string, string, string, string, ...unknown[]];

export function parseBinanceKline(row: RawKline): Candle {
  return {
    time: Math.floor(row[0] / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

export class BinanceFuturesProvider implements MarketDataProvider {
  readonly name = 'binance-futures';
  readonly maxLimit = 1500;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async fetchKlines({ symbol, tf, limit, endTime }: FetchKlinesParams): Promise<Candle[]> {
    const params = new URLSearchParams({
      symbol,
      interval: tf,
      limit: String(Math.min(Math.max(limit, 1), this.maxLimit)),
    });
    // endTime của Binance tính bằng ms và bao gồm nến có openTime <= endTime.
    if (endTime) params.set('endTime', String(endTime * 1000));
    const res = await this.fetchImpl(`${BASE_URL}/fapi/v1/klines?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Binance ${res.status}: ${body.slice(0, 200)}`);
    }
    const rows = (await res.json()) as RawKline[];
    return rows.map(parseBinanceKline);
  }
}
