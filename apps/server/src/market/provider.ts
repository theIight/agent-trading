import type { Candle, Timeframe } from '@wca/shared';

export interface FetchKlinesParams {
  symbol: string;
  tf: Timeframe;
  limit: number;
  /** open time (giây) của nến cuối cùng muốn lấy, để tải lịch sử cũ hơn. */
  endTime?: number;
}

export interface MarketDataProvider {
  readonly name: string;
  readonly maxLimit: number;
  fetchKlines(params: FetchKlinesParams): Promise<Candle[]>;
}
