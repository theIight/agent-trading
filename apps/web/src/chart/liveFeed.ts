import type { Candle, Timeframe } from '@wca/shared';

// Binance đã chuyển market stream của USDⓈ-M Futures sang `/market/ws`; đường `/ws` cũ vẫn mở kết nối nhưng không gửi dữ liệu.
const WS_BASE = 'wss://fstream.binance.com/market/ws';
/** Kết nối mở mà không có message trong khoảng này → coi như chết, kết nối lại (để rộng cho symbol ít giao dịch). */
export const LIVE_STALE_MS = 60_000;

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
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let gotData = false;

  // Không có dữ liệu trong LIVE_STALE_MS → đóng để kết nối lại (tránh "Live" mà nến đứng yên).
  const armWatchdog = (sock: WebSocket) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => sock.close(), LIVE_STALE_MS);
  };

  const connect = () => {
    onStatus?.('connecting');
    gotData = false;
    const sock = new WebSocket(`${WS_BASE}/${symbol.toLowerCase()}@kline_${tf}`);
    ws = sock;
    sock.onopen = () => armWatchdog(sock);
    sock.onmessage = ev => {
      armWatchdog(sock);
      // Chỉ báo "Live" khi đã thực sự nhận dữ liệu.
      if (!gotData) {
        gotData = true;
        retry = 0;
        onStatus?.('open');
      }
      const msg = JSON.parse(ev.data as string) as BinanceKlineMsg;
      if (msg.e !== 'kline') return;
      const k = msg.k;
      onCandle(
        { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v },
        k.x,
      );
    };
    sock.onclose = () => {
      clearTimeout(watchdog);
      // Kết nối cũ đã hủy (đổi symbol/khung) đóng muộn: không được ghi đè trạng thái của kết nối mới.
      if (stopped || ws !== sock) return;
      onStatus?.('closed');
      const delay = Math.min(30_000, 1000 * 2 ** retry++);
      timer = setTimeout(connect, delay);
    };
    sock.onerror = () => sock.close();
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(watchdog);
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
