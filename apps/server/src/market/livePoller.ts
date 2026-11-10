import type { Candle, Timeframe } from '@wca/shared';
import type { MarketDataProvider } from './provider.ts';

export type LiveEvent = { candle: Candle; closed: boolean } | { error: string };
type Listener = (e: LiveEvent) => void;

interface Feed {
  listeners: Set<Listener>;
  timer: ReturnType<typeof setInterval>;
  lastTime?: number;
  lastJson?: string;
  inFlight: boolean;
}

/**
 * Realtime cho nguồn không có WebSocket (OANDA): poll 2 nến mới nhất theo chu kỳ,
 * chỉ chạy khi có người xem cặp symbol/tf đó. Khi xuất hiện nến mới → phát nến trước là `closed`.
 */
export class LivePoller {
  private feeds = new Map<string, Feed>();

  constructor(
    private readonly provider: MarketDataProvider,
    private readonly intervalMs = 2000,
  ) {}

  subscribe(symbol: string, tf: Timeframe, listener: Listener): () => void {
    const key = `${symbol}:${tf}`;
    let feed = this.feeds.get(key);
    if (!feed) {
      const f: Feed = { listeners: new Set(), inFlight: false, timer: setInterval(() => void this.poll(symbol, tf, f), this.intervalMs) };
      f.timer.unref?.();
      this.feeds.set(key, f);
      feed = f;
      void this.poll(symbol, tf, f);
    }
    feed.listeners.add(listener);
    return () => {
      feed.listeners.delete(listener);
      if (!feed.listeners.size) {
        clearInterval(feed.timer);
        this.feeds.delete(key);
      }
    };
  }

  /** Số feed đang chạy (test / health). */
  get activeFeeds(): number {
    return this.feeds.size;
  }

  async poll(symbol: string, tf: Timeframe, feed: Feed): Promise<void> {
    if (feed.inFlight) return;
    feed.inFlight = true;
    try {
      const candles = await this.provider.fetchKlines({ symbol, tf, limit: 2 });
      const last = candles.at(-1);
      if (!last) return;
      const emit = (e: LiveEvent) => feed.listeners.forEach(l => l(e));
      if (feed.lastTime !== undefined && last.time > feed.lastTime) {
        const prev = candles.find(c => c.time === feed.lastTime);
        if (prev) emit({ candle: prev, closed: true });
      }
      const json = JSON.stringify(last);
      if (json !== feed.lastJson) emit({ candle: last, closed: false });
      feed.lastTime = last.time;
      feed.lastJson = json;
    } catch (err) {
      feed.listeners.forEach(l => l({ error: (err as Error).message }));
    } finally {
      feed.inFlight = false;
    }
  }
}
