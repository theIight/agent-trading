/** Nến OHLCV. `time` = open time tính bằng giây (UTC), khớp định dạng lightweight-charts. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KlinesResponse {
  symbol: string;
  tf: string;
  candles: Candle[];
  /** true nếu nến cuối đang chạy (chưa đóng). */
  lastCandleForming: boolean;
  source: 'live' | 'cache';
}

/** Số nến tối thiểu MCP trả cho agent (limit nhỏ hơn tự nâng lên): Wyckoff cần đủ bối cảnh. */
export const MIN_KLINE_BARS = 100;

/** Biến môi trường runner truyền cho MCP để biết lượt phân tích đang chạy (mặc định khi agent bỏ sót tham số). */
export const RUN_CONTEXT_ENV = { analysisId: 'WCA_ANALYSIS_ID', symbol: 'WCA_SYMBOL', primaryTf: 'WCA_PRIMARY_TF' } as const;

const SYMBOL_ALIASES: Record<string, string> = { GOLD: 'XAUUSD', SILVER: 'XAGUSD' };

/** Chuẩn hoá symbol: chữ hoa, bỏ ký tự lạ (`XAU_USD` → `XAUUSD`), alias `GOLD` → `XAUUSD`. */
export function normalizeSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return SYMBOL_ALIASES[s] ?? s;
}
