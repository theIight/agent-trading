import type { Candle, Timeframe } from '@wca/shared';

const WS_BASE = 'wss://fstream.binance.com/ws';

interface BinanceKlineMsg {
  e: 'kline';
  k: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean };
}

/**
 * Nến realtime từ WebSocket Binance Futures (trình duyệt kết nối trực tiếp).
 * Tự kết nối lại với backoff khi mất kết nối. Trả về hàm hủy.
 */
export function subscribeLiveKlines(
  symbol: string,
  tf: Timeframe,
  onCandle: (candle: Candle, closed: boolean) => void,
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void,
): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    onStatus?.('connecting');
    ws = new WebSocket(`${WS_BASE}/${symbol.toLowerCase()}@kline_${tf}`);
    ws.onopen = () => {
      retry = 0;
      onStatus?.('open');
    };
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data as string) as BinanceKlineMsg;
      if (msg.e !== 'kline') return;
      const k = msg.k;
      onCandle(
        { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v },
        k.x,
      );
    };
    ws.onclose = () => {
      // Kết nối cũ đã hủy (đổi symbol/khung) đóng muộn: không được ghi đè trạng thái của kết nối mới.
      if (stopped) return;
      onStatus?.('closed');
      const delay = Math.min(30_000, 1000 * 2 ** retry++);
      timer = setTimeout(connect, delay);
    };
    ws.onerror = () => ws?.close();
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}

/**
 * Nến realtime qua SSE `/api/live` (server poll nguồn không có WebSocket, vd OANDA).
 * EventSource tự kết nối lại khi rớt mạng.
 */
export function subscribeServerLive(
  symbol: string,
  tf: Timeframe,
  onCandle: (candle: Candle, closed: boolean) => void,
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void,
  onError?: (message: string) => void,
): () => void {
  onStatus?.('connecting');
  const es = new EventSource(`/api/live?${new URLSearchParams({ symbol, tf })}`);
  es.onopen = () => onStatus?.('open');
  es.onerror = () => onStatus?.(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting');
  es.onmessage = msg => {
    try {
      const e = JSON.parse(msg.data as string) as { candle?: Candle; closed?: boolean; error?: string };
      if (e.error) onError?.(e.error);
      else if (e.candle) onCandle(e.candle, Boolean(e.closed));
    } catch {
      /* bỏ qua dòng lỗi */
    }
  };
  return () => es.close();
}
