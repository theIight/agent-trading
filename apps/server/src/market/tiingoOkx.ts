import { tfSeconds, type Candle, type Timeframe } from '@wca/shared';
import { mergeVolumes, OKX_BAR, type OkxVolumeClient } from './okx.ts';
import type { FetchKlinesParams, MarketDataProvider } from './provider.ts';
import { aggregateWeekly, weekStartUtc, type TiingoFxClient } from './tiingo.ts';
import type { LiveEvent } from './livePoller.ts';

// XAUUSD: giá vàng giao ngay từ Tiingo + volume hợp đồng OKX XAU-USDT-SWAP (proxy cho nỗ lực).

export interface TiingoOkxOptions {
  tiingo: TiingoFxClient;
  okx: OkxVolumeClient;
  /** symbol nội bộ → ticker Tiingo, vd XAUUSD → xauusd */
  tickerOf?: (symbol: string) => string;
}

const defaultTicker = (s: string) => s.toLowerCase();

export class TiingoOkxProvider implements MarketDataProvider {
  readonly name = 'tiingo-okx';
  readonly maxLimit = 1500;

  constructor(private readonly opts: TiingoOkxOptions) {}

  private ticker(symbol: string): string {
    return (this.opts.tickerOf ?? defaultTicker)(symbol);
  }

  /** Volume OKX cho dãy nến; lỗi OKX → giữ volume 0 (không chặn giá). */
  private async withVolume(price: Candle[], tf: Timeframe): Promise<Candle[]> {
    if (!price.length) return price;
    const step = tfSeconds(tf);
    // Nến ngày của Tiingo căn 00:00 UTC thì ghép thẳng với OKX 1Dutc; nếu không, cộng từ OKX 1H.
    const dailyAligned = tf !== '1d' || price.every(c => c.time % 86400 === 0);
    const bar = dailyAligned ? OKX_BAR[tf] : OKX_BAR['1h'];
    try {
      const vols = await this.opts.okx.volumes(bar, price[0]!.time, price.at(-1)!.time + step);
      return mergeVolumes(price, vols, () => step);
    } catch {
      return price;
    }
  }

  async fetchKlines({ symbol, tf, limit, endTime }: FetchKlinesParams): Promise<Candle[]> {
    if (tf === '1w') {
      // Tuần = gộp nến ngày (đã có volume); tuần vàng mở tối Chủ nhật.
      const daily = await this.opts.tiingo.fetchBars(this.ticker(symbol), '1d', Math.min(limit * 6 + 6, 1500), endTime);
      const weeks = aggregateWeekly(await this.withVolume(daily, '1d'));
      return (endTime ? weeks.filter(w => w.time <= weekStartUtc(endTime)) : weeks).slice(-limit);
    }
    const price = await this.opts.tiingo.fetchBars(this.ticker(symbol), tf, limit, endTime);
    return this.withVolume(price, tf);
  }

  /** Nến vừa lấy gần nhất (seed cho realtime). */
  async seed(symbol: string, tf: Timeframe): Promise<Candle | undefined> {
    return (await this.fetchKlines({ symbol, tf, limit: 2 })).at(-1);
  }

  get tiingo(): TiingoFxClient {
    return this.opts.tiingo;
  }

  get okx(): OkxVolumeClient {
    return this.opts.okx;
  }

  tickerFor(symbol: string): string {
    return this.ticker(symbol);
  }
}

/** Mốc mở nến chứa thời điểm `time` (khung ≤ 1d căn UTC; 1w theo tuần vàng). */
export function bucketStart(time: number, tf: Timeframe): number {
  if (tf === '1w') return weekStartUtc(time);
  const step = tfSeconds(tf);
  return Math.floor(time / step) * step;
}

/**
 * Cập nhật nến đang chạy bằng một quote (giá mid). Sang nến mới → trả `closed` là nến cũ.
 * Pure để test.
 */
export function applyQuote(current: Candle | null, quoteTime: number, mid: number, tf: Timeframe): { current: Candle; closed?: Candle } {
  const start = bucketStart(quoteTime, tf);
  if (current && start === current.time) {
    return { current: { ...current, high: Math.max(current.high, mid), low: Math.min(current.low, mid), close: mid } };
  }
  if (current && start < current.time) return { current }; // quote cũ, bỏ qua
  const next: Candle = { time: start, open: mid, high: mid, low: mid, close: mid, volume: 0 };
  return current ? { current: next, closed: current } : { current: next };
}

/** Parse message WebSocket Tiingo FX: `{"service":"fx","messageType":"A","data":["Q",ticker,date,bidSize,bid,mid,askSize,ask]}`. */
export function parseTiingoFxMessage(raw: string): { ticker: string; time: number; mid: number } | null {
  try {
    const m = JSON.parse(raw) as { messageType?: string; data?: unknown[] };
    if (m.messageType !== 'A' || !Array.isArray(m.data) || m.data[0] !== 'Q') return null;
    const time = Date.parse(String(m.data[2])) / 1000;
    const mid = Number(m.data[5]);
    if (!Number.isFinite(time) || !Number.isFinite(mid)) return null;
    return { ticker: String(m.data[1]).toLowerCase(), time, mid };
  } catch {
    return null;
  }
}

type Listener = (e: LiveEvent) => void;

interface Feed {
  symbol: string;
  tf: Timeframe;
  listeners: Set<Listener>;
  current: Candle | null;
  volTimer: ReturnType<typeof setInterval>;
}

/**
 * Realtime XAUUSD: 1 WebSocket Tiingo (giá mid) dùng chung cho mọi khung + poll OKX REST mỗi `volumePollMs`
 * để lấy volume nến đang chạy. Không tốn quota REST Tiingo ngoài 1 request seed mỗi feed.
 */
export class TiingoOkxLive {
  private ws: WebSocket | null = null;
  private feeds = new Map<string, Feed>();
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly provider: TiingoOkxProvider,
    private readonly volumePollMs = 3000,
    private readonly wsFactory: (url: string) => WebSocket = url => new WebSocket(url),
  ) {}

  subscribe(symbol: string, tf: Timeframe, listener: Listener): () => void {
    const key = `${symbol}:${tf}`;
    let feed = this.feeds.get(key);
    if (!feed) {
      const f: Feed = { symbol, tf, listeners: new Set(), current: null, volTimer: setInterval(() => void this.pollVolume(f), this.volumePollMs) };
      f.volTimer.unref?.();
      this.feeds.set(key, f);
      feed = f;
      void this.provider
        .seed(symbol, tf)
        .then(c => {
          if (c && !f.current) {
            f.current = c;
            this.emit(f, { candle: c, closed: false });
          }
        })
        .catch(err => this.emit(f, { error: (err as Error).message }));
      if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe(this.ws);
      else this.ensureSocket();
    }
    feed.listeners.add(listener);
    return () => {
      feed.listeners.delete(listener);
      if (!feed.listeners.size) {
        clearInterval(feed.volTimer);
        this.feeds.delete(key);
        if (!this.feeds.size) this.closeSocket();
      }
    };
  }

  get activeFeeds(): number {
    return this.feeds.size;
  }

  private emit(f: Feed, e: LiveEvent): void {
    f.listeners.forEach(l => l(e));
  }

  /** Áp một quote cho mọi feed cùng ticker (public để test). */
  onQuote(ticker: string, time: number, mid: number): void {
    for (const f of this.feeds.values()) {
      if (this.provider.tickerFor(f.symbol) !== ticker) continue;
      const r = applyQuote(f.current, time, mid, f.tf);
      if (r.closed) this.emit(f, { candle: r.closed, closed: true });
      if (r.current !== f.current) {
        f.current = r.current;
        this.emit(f, { candle: r.current, closed: false });
      }
    }
  }

  private async pollVolume(f: Feed): Promise<void> {
    if (!f.current) return;
    try {
      const rows = await this.provider.okx.latest(OKX_BAR[f.tf === '1w' ? '1d' : f.tf]);
      const cur = f.current;
      const end = bucketStart(cur.time, f.tf) + (f.tf === '1w' ? 7 * 86400 : tfSeconds(f.tf));
      const start = f.tf === '1w' ? cur.time - 86400 : cur.time;
      const vol = rows.filter(r => r.time >= start && r.time < end).reduce((s, r) => s + r.volume, 0);
      // 1w: chỉ cộng được nến ngày hiện tại → giữ phần volume đã có cộng thêm khi lớn hơn.
      const volume = f.tf === '1w' ? Math.max(cur.volume, vol) : vol;
      if (volume > 0 && volume !== cur.volume) {
        f.current = { ...cur, volume: Math.round(volume * 1000) / 1000 };
        this.emit(f, { candle: f.current, closed: false });
      }
    } catch {
      /* OKX lỗi tạm thời: giữ volume cũ */
    }
  }

  private ensureSocket(): void {
    if (this.ws || !this.provider.tiingo.token) return;
    const ws = this.wsFactory('wss://api.tiingo.com/fx');
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.sendSubscribe(ws);
    };
    ws.onmessage = ev => {
      const q = parseTiingoFxMessage(String(ev.data));
      if (q) this.onQuote(q.ticker, q.time, q.mid);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.feeds.size) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => this.ensureSocket(), delay);
      this.reconnectTimer.unref?.();
    };
    ws.onerror = () => ws.close();
  }

  private sendSubscribe(ws: WebSocket): void {
    const tickers = [...new Set([...this.feeds.values()].map(f => this.provider.tickerFor(f.symbol)))];
    ws.send(JSON.stringify({ eventName: 'subscribe', authorization: this.provider.tiingo.token, eventData: { thresholdLevel: 5, tickers } }));
  }

  private closeSocket(): void {
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
