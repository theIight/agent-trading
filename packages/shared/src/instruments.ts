// Nguồn dữ liệu theo symbol: crypto → Binance USDⓈ-M Futures, vàng/forex → OANDA (nếu cấu hình).

export type MarketSource = 'binance-futures' | 'oanda' | 'tiingo-okx';

export interface InstrumentInfo {
  symbol: string;
  source: MarketSource;
  /** Tên hiển thị trên chart, vd "XAUUSD · Vàng". */
  displayName: string;
  /** Nhãn nguồn cho legend, vd "OANDA (giá mid)". */
  sourceLabel: string;
  assetClass: 'crypto' | 'commodity' | 'forex';
  /**
   * `contract` = khối lượng thật của chính hợp đồng đang vẽ; `tick` = số lần đổi giá (OANDA);
   * `proxy` = khối lượng của thị trường khác ghép vào (XAUUSD: giá Tiingo + volume OKX XAU-USDT-SWAP).
   */
  volumeType: 'contract' | 'tick' | 'proxy';
  /** Realtime: WebSocket Binance trực tiếp từ trình duyệt, hoặc SSE do server poll. */
  live: 'binance-ws' | 'server-sse';
}

/** Danh sách chọn nhanh trên toolbar. */
export const WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'XAUUSD'] as const;

const NAMES: Record<string, string> = {
  XAUUSD: 'Vàng',
  XAGUSD: 'Bạc',
  BTCUSDT: 'Bitcoin',
  ETHUSDT: 'Ethereum',
};

/** `XAUUSD` → `XAU_USD` (mã instrument OANDA). */
export function oandaInstrument(symbol: string): string {
  return symbol.length === 6 ? `${symbol.slice(0, 3)}_${symbol.slice(3)}` : symbol;
}

export function describeInstrument(symbol: string, source: MarketSource, oandaPrice: 'M' | 'B' | 'A' = 'M'): InstrumentInfo {
  const name = NAMES[symbol];
  const displayName = name ? `${symbol} · ${name}` : symbol;
  if (source === 'tiingo-okx') {
    return {
      symbol,
      source,
      displayName,
      sourceLabel: 'giá Tiingo · volume OKX perp',
      assetClass: /^X(AU|AG|PT|PD)/.test(symbol) ? 'commodity' : 'forex',
      volumeType: 'proxy',
      live: 'server-sse',
    };
  }
  if (source === 'oanda') {
    const priceLabel = { M: 'giá mid', B: 'giá bid', A: 'giá ask' }[oandaPrice];
    return {
      symbol,
      source,
      displayName,
      sourceLabel: `OANDA (${priceLabel})`,
      assetClass: /^X(AU|AG|PT|PD)/.test(symbol) ? 'commodity' : 'forex',
      volumeType: 'tick',
      live: 'server-sse',
    };
  }
  return { symbol, source, displayName, sourceLabel: 'Binance Futures', assetClass: 'crypto', volumeType: 'contract', live: 'binance-ws' };
}
