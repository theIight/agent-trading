import type { Db } from '../db/index.ts';
import { LocalBook, sampleBook, type BookSample, type DepthDiff, type DepthSnapshot } from './localBook.ts';
import type { BigTrade } from './calc.ts';

// Collector sổ lệnh + lệnh khớp lớn của Binance spot (WebSocket công khai, không cần key).
// Mỗi `sampleSec` giây gom sổ lệnh theo bucket và ghi SQLite để có "heatmap" (tường đứng bao lâu) qua các lần restart.

export const BINANCE_SPOT_REST = 'https://api.binance.com';
export const BINANCE_SPOT_WS = 'wss://stream.binance.com:9443';

export interface CollectorOptions {
  symbol: string;
  bucket: number;
  sampleSec: number;
  retainH: number;
  /** Snapshot lại định kỳ để làm mới vùng giá phủ được. */
  resyncMin: number;
  /** Tổng lệnh chủ động cùng phía trong 1 giây ≥ khối lượng này được lưu (giống bong bóng Bookmap). */
  bigTradeQty: number;
  db: Db;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WebSocket;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface CollectorStatus {
  symbol: string;
  connected: boolean;
  synced: boolean;
  /** Unix giây: mẫu sổ lệnh cũ nhất còn lưu. */
  since: number | null;
  lastSampleAt: number | null;
  historyMin: number;
  spotPrice: number | null;
  error?: string;
}

interface SampleRow {
  t: number;
  data: string;
}

export class BookCollector {
  private readonly book = new LocalBook();
  private ws: WebSocket | null = null;
  private buffer: DepthDiff[] = [];
  private syncing = false;
  private stopped = true;
  private timers: ReturnType<typeof setInterval>[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private lastError: string | undefined;
  /** Lệnh chủ động đang gộp theo giây: key `${giây}:${side}`. */
  private pendingTrades = new Map<string, { t: number; side: 'BUY' | 'SELL'; qty: number; notional: number }>();
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly now: () => number;

  constructor(private readonly opts: CollectorOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsFactory = opts.wsFactory ?? (url => new WebSocket(url));
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get symbol(): string {
    return this.opts.symbol;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.timers.push(setInterval(() => this.takeSample(), this.opts.sampleSec * 1000));
    this.timers.push(setInterval(() => void this.resync('định kỳ'), this.opts.resyncMin * 60_000));
    this.timers.push(setInterval(() => this.prune(), 10 * 60_000));
    this.prune();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.book.reset();
  }

  status(): CollectorStatus {
    const range = this.opts.db
      .prepare('SELECT MIN(t) AS lo, MAX(t) AS hi FROM book_samples WHERE symbol = ?')
      .get(this.opts.symbol) as { lo: number | null; hi: number | null };
    return {
      symbol: this.opts.symbol,
      connected: this.ws?.readyState === WebSocket.OPEN,
      synced: this.book.isSynced,
      since: range.lo,
      lastSampleAt: range.hi,
      historyMin: range.lo != null && range.hi != null ? Math.round((range.hi - range.lo) / 60) : 0,
      spotPrice: this.book.mid() ?? null,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /** Mẫu sổ lệnh liên tục gần nhất trong [from, to] (bỏ đoạn trước khoảng mất dữ liệu > 5 phút). */
  samples(from: number, to: number): BookSample[] {
    const rows = this.opts.db
      .prepare('SELECT t, data FROM book_samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t')
      .all(this.opts.symbol, from, to) as SampleRow[];
    let start = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i]!.t - rows[i - 1]!.t > 300) start = i;
    return rows.slice(start).map(r => JSON.parse(r.data) as BookSample);
  }

  /** Mọi mẫu trong [from, to] (kể cả qua khoảng mất dữ liệu). */
  rawSamples(from: number, to: number): BookSample[] {
    const rows = this.opts.db
      .prepare('SELECT t, data FROM book_samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t')
      .all(this.opts.symbol, from, to) as SampleRow[];
    return rows.map(r => JSON.parse(r.data) as BookSample);
  }

  trades(from: number, to: number): BigTrade[] {
    return this.opts.db
      .prepare('SELECT t, price, qty, side FROM big_trades WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t')
      .all(this.opts.symbol, from, to) as BigTrade[];
  }

  // ---------- WebSocket ----------
  private connect(): void {
    if (this.stopped) return;
    const s = this.opts.symbol.toLowerCase();
    const ws = this.wsFactory(`${BINANCE_SPOT_WS}/stream?streams=${s}@depth@100ms/${s}@aggTrade`);
    this.ws = ws;
    this.buffer = [];
    this.book.reset();
    ws.addEventListener('open', () => {
      this.reconnectDelay = 1000;
      void this.resync('kết nối');
    });
    ws.addEventListener('message', ev => {
      if (this.ws !== ws) return;
      try {
        this.onMessage(JSON.parse(String(ev.data)) as { data?: Record<string, unknown> });
      } catch {
        // Bỏ message hỏng.
      }
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.book.reset();
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      this.lastError = 'Lỗi WebSocket Binance';
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
  }

  /** Xử lý một message của combined stream (export cho test qua `handleMessage`). */
  handleMessage(msg: { data?: Record<string, unknown> }): void {
    this.onMessage(msg);
  }

  private onMessage(msg: { data?: Record<string, unknown> }): void {
    const d = msg.data;
    if (!d) return;
    if (d.e === 'depthUpdate') {
      const diff: DepthDiff = { U: Number(d.U), u: Number(d.u), b: d.b as DepthDiff['b'], a: d.a as DepthDiff['a'] };
      if (this.syncing || this.book.lastUpdateId < 0) {
        this.buffer.push(diff);
        if (this.buffer.length > 5000) this.buffer.shift();
        return;
      }
      if (this.book.applyDiff(diff) === 'gap') {
        this.buffer.push(diff);
        void this.resync('mất chuỗi update');
      }
    } else if (d.e === 'aggTrade') {
      const qty = Number(d.q);
      const price = Number(d.p);
      if (!Number.isFinite(qty) || !Number.isFinite(price)) return;
      const t = Math.floor(Number(d.T) / 1000);
      // Sang giây mới → chốt các giây trước.
      for (const g of this.pendingTrades.values()) if (g.t < t) this.flushTrades(t);
      const side = d.m ? 'SELL' : 'BUY';
      const key = `${t}:${side}`;
      const g = this.pendingTrades.get(key) ?? { t, side, qty: 0, notional: 0 };
      g.qty += qty;
      g.notional += qty * price;
      this.pendingTrades.set(key, g);
    }
  }

  /** Ghi các nhóm lệnh của những giây < `before` đạt ngưỡng (giá = VWAP). */
  flushTrades(before = Number.POSITIVE_INFINITY): void {
    for (const [key, g] of this.pendingTrades) {
      if (g.t >= before) continue;
      this.pendingTrades.delete(key);
      if (g.qty < this.opts.bigTradeQty) continue;
      this.opts.db
        .prepare('INSERT INTO big_trades (symbol, t, price, qty, side) VALUES (?, ?, ?, ?, ?)')
        .run(this.opts.symbol, g.t, Math.round((g.notional / g.qty) * 100) / 100, Math.round(g.qty * 1000) / 1000, g.side);
    }
  }

  /** Snapshot REST rồi áp các diff đang buffer. */
  async resync(reason: string): Promise<void> {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    try {
      for (let attempt = 0; attempt < 3 && !this.stopped; attempt++) {
        const snap = await this.fetchSnapshot();
        this.book.applySnapshot(snap);
        const pending = this.buffer;
        this.buffer = [];
        let gap = false;
        for (const diff of pending) {
          if (this.book.applyDiff(diff) === 'gap') {
            gap = true;
            break;
          }
        }
        if (!gap) {
          this.lastError = undefined;
          this.opts.log?.(`[orderflow] ${this.opts.symbol} đồng bộ sổ lệnh (${reason}), lastUpdateId=${this.book.lastUpdateId}`);
          return;
        }
        // Snapshot cũ hơn diff đang có: buffer lại phần còn thiếu và thử lại.
        this.book.reset();
      }
      this.lastError = 'Không đồng bộ được sổ lệnh sau 3 lần thử';
    } catch (err) {
      this.lastError = `Snapshot sổ lệnh lỗi: ${(err as Error).message}`;
      this.book.reset();
      setTimeout(() => void this.resync('thử lại'), 10_000).unref?.();
    } finally {
      this.syncing = false;
    }
  }

  private async fetchSnapshot(): Promise<DepthSnapshot> {
    const res = await this.fetchImpl(`${BINANCE_SPOT_REST}/api/v3/depth?symbol=${this.opts.symbol}&limit=5000`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    return (await res.json()) as DepthSnapshot;
  }

  // ---------- Mẫu & dọn dẹp ----------
  /** Gom sổ lệnh hiện tại và ghi DB (export cho test). */
  takeSample(): BookSample | null {
    this.flushTrades(this.now());
    if (!this.book.isSynced) return null;
    const s = sampleBook(this.book, this.opts.bucket, this.now());
    if (!s) return null;
    this.opts.db
      .prepare('INSERT OR REPLACE INTO book_samples (symbol, t, data) VALUES (?, ?, ?)')
      .run(this.opts.symbol, s.t, JSON.stringify(s));
    return s;
  }

  private prune(): void {
    const cutoff = this.now() - this.opts.retainH * 3600;
    this.opts.db.prepare('DELETE FROM book_samples WHERE symbol = ? AND t < ?').run(this.opts.symbol, cutoff);
    this.opts.db.prepare('DELETE FROM big_trades WHERE symbol = ? AND t < ?').run(this.opts.symbol, cutoff);
  }
}
