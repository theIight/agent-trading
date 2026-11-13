import type { LiqSide, LiqVenue } from '@wca/shared';
import type { Db } from '../db/index.ts';
import { parseBinanceForceOrder, parseOkxLiquidations, type RawLiquidation, type StoredLiquidation } from './model.ts';

// Collector thanh lý thật: Binance Futures `!forceOrder@arr` + OKX `liquidation-orders` (WebSocket công khai, không cần key).
// Binance chỉ đẩy lệnh thanh lý cuối cùng mỗi giây cho mỗi symbol → luôn đếm thiếu.

export const BINANCE_LIQ_WS = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
export const OKX_PUBLIC_WS = 'wss://ws.okx.com:8443/ws/v5/public';
/** OKX đóng kết nối sau 30 giây không có message → gửi `ping`. */
const OKX_PING_MS = 25_000;

export interface LiquidationCollectorOptions {
  /** Symbol chart = symbol Binance Futures (vd BTCUSDT). */
  symbol: string;
  okxInst?: { instId: string; ctVal: number };
  retainH: number;
  db: Db;
  wsFactory?: (url: string) => WebSocket;
  now?: () => number;
  log?: (msg: string) => void;
}

interface Endpoint {
  venue: LiqVenue;
  url: string;
}

export class LiquidationCollector {
  private sockets = new Map<LiqVenue, WebSocket>();
  private reconnectTimers = new Map<LiqVenue, ReturnType<typeof setTimeout>>();
  private delays = new Map<LiqVenue, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = true;
  /** Thanh lý đang gộp theo giây: key `${venue}:${giây}:${side}`. */
  private pending = new Map<string, { t: number; venue: LiqVenue; side: LiqSide; qty: number; notional: number }>();
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly now: () => number;

  constructor(private readonly opts: LiquidationCollectorOptions) {
    this.wsFactory = opts.wsFactory ?? (url => new WebSocket(url));
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get symbol(): string {
    return this.opts.symbol;
  }

  private endpoints(): Endpoint[] {
    const eps: Endpoint[] = [{ venue: 'binance', url: BINANCE_LIQ_WS }];
    if (this.opts.okxInst) eps.push({ venue: 'okx', url: OKX_PUBLIC_WS });
    return eps;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const ep of this.endpoints()) this.connect(ep);
    this.timers.push(setInterval(() => this.flush(this.now()), 2000));
    this.timers.push(
      setInterval(() => {
        const ws = this.sockets.get('okx');
        if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
      }, OKX_PING_MS),
    );
    this.timers.push(setInterval(() => this.prune(), 10 * 60_000));
    this.prune();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const t of this.reconnectTimers.values()) clearTimeout(t);
    this.reconnectTimers.clear();
    const sockets = [...this.sockets.values()];
    this.sockets.clear();
    for (const ws of sockets) ws.close();
    this.flush();
  }

  status(): { venue: LiqVenue; connected: boolean }[] {
    return this.endpoints().map(ep => ({ venue: ep.venue, connected: this.sockets.get(ep.venue)?.readyState === WebSocket.OPEN }));
  }

  /** Thanh lý đã lưu trong [from, to] (unix giây). */
  rows(from: number, to: number): StoredLiquidation[] {
    return this.opts.db
      .prepare('SELECT t, venue, side, price, qty FROM liquidations WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t')
      .all(this.opts.symbol, from, to) as StoredLiquidation[];
  }

  private connect(ep: Endpoint): void {
    if (this.stopped) return;
    const ws = this.wsFactory(ep.url);
    this.sockets.set(ep.venue, ws);
    ws.addEventListener('open', () => {
      this.delays.delete(ep.venue);
      if (ep.venue === 'okx') ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] }));
    });
    ws.addEventListener('message', ev => {
      if (this.sockets.get(ep.venue) !== ws) return;
      const text = String(ev.data);
      if (text === 'pong') return;
      try {
        this.handleMessage(ep.venue, JSON.parse(text));
      } catch {
        // Bỏ message hỏng.
      }
    });
    ws.addEventListener('close', () => {
      if (this.sockets.get(ep.venue) !== ws) return;
      this.sockets.delete(ep.venue);
      this.scheduleReconnect(ep);
    });
    ws.addEventListener('error', () => this.opts.log?.(`[liquidation] lỗi WebSocket ${ep.venue}`));
  }

  private scheduleReconnect(ep: Endpoint): void {
    if (this.stopped || this.reconnectTimers.has(ep.venue)) return;
    const delay = this.delays.get(ep.venue) ?? 1000;
    this.reconnectTimers.set(
      ep.venue,
      setTimeout(() => {
        this.reconnectTimers.delete(ep.venue);
        this.connect(ep);
      }, delay),
    );
    this.delays.set(ep.venue, Math.min(delay * 2, 60_000));
  }

  /** Xử lý một message (export cho test). */
  handleMessage(venue: LiqVenue, msg: unknown): void {
    const items: RawLiquidation[] = [];
    if (venue === 'binance') {
      const r = parseBinanceForceOrder(msg, this.opts.symbol);
      if (r) items.push(r);
    } else if (this.opts.okxInst) {
      items.push(...parseOkxLiquidations(msg, this.opts.okxInst.instId, this.opts.okxInst.ctVal));
    }
    for (const r of items) {
      const t = Math.floor(r.ts / 1000);
      const key = `${r.venue}:${t}:${r.side}`;
      const g = this.pending.get(key) ?? { t, venue: r.venue, side: r.side, qty: 0, notional: 0 };
      g.qty += r.qty;
      g.notional += r.qty * r.price;
      this.pending.set(key, g);
    }
  }

  /** Ghi các nhóm của những giây < `before` (giá = VWAP). */
  flush(before = Number.POSITIVE_INFINITY): void {
    const insert = this.opts.db.prepare('INSERT INTO liquidations (symbol, venue, t, side, price, qty) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [key, g] of this.pending) {
      if (g.t >= before) continue;
      this.pending.delete(key);
      insert.run(this.opts.symbol, g.venue, g.t, g.side, Math.round((g.notional / g.qty) * 100) / 100, Math.round(g.qty * 10000) / 10000);
    }
  }

  private prune(): void {
    this.opts.db.prepare('DELETE FROM liquidations WHERE symbol = ? AND t < ?').run(this.opts.symbol, this.now() - this.opts.retainH * 3600);
  }
}
