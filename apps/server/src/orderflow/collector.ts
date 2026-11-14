import { roundPrice } from '@wca/shared';
import type { Db } from '../db/index.ts';
import { LocalBook, applyDiffsToLevels, nearCoverEdge, sampleBook, type BookLevels, type BookMarket, type BookSample, type DepthDiff, type DepthSnapshot } from './localBook.ts';
import type { BigTrade } from './calc.ts';

// Collector sổ lệnh + lệnh khớp lớn của Binance spot / USDⓈ-M futures (WebSocket công khai, không cần key).
// Mỗi `sampleSec` giây gom sổ lệnh theo bucket và ghi SQLite để có "heatmap" (tường đứng bao lâu) qua các lần restart.

export const BINANCE_SPOT_REST = 'https://api.binance.com';
export const BINANCE_SPOT_WS = 'wss://stream.binance.com:9443';
export const BINANCE_FUTURES_REST = 'https://fapi.binance.com';
/** Futures tách WebSocket: sổ lệnh ở `/public`, lệnh khớp ở `/market` (đường cũ `/stream` không gửi aggTrade). */
export const BINANCE_FUTURES_WS = 'wss://fstream.binance.com';

export interface StreamEndpoint {
  url: string;
  /** Socket này mang sổ lệnh (đóng → reset sổ lệnh). */
  depth: boolean;
}

/** URL WebSocket theo market. */
export function streamEndpoints(market: BookMarket, sourceSymbol: string): StreamEndpoint[] {
  const s = sourceSymbol.toLowerCase();
  if (market === 'futures') {
    return [
      { url: `${BINANCE_FUTURES_WS}/public/stream?streams=${s}@depth@100ms`, depth: true },
      { url: `${BINANCE_FUTURES_WS}/market/stream?streams=${s}@aggTrade`, depth: false },
    ];
  }
  return [{ url: `${BINANCE_SPOT_WS}/stream?streams=${s}@depth@100ms/${s}@aggTrade`, depth: true }];
}

/** URL snapshot sổ lệnh REST (spot tối đa 5000 mức, futures 1000). */
export function depthSnapshotUrl(market: BookMarket, sourceSymbol: string): string {
  return market === 'futures'
    ? `${BINANCE_FUTURES_REST}/fapi/v1/depth?symbol=${sourceSymbol}&limit=1000`
    : `${BINANCE_SPOT_REST}/api/v3/depth?symbol=${sourceSymbol}&limit=5000`;
}

export interface CollectorOptions {
  /** Symbol trên chart (khoá lưu DB). */
  symbol: string;
  /** Symbol trên Binance (mặc định = symbol). */
  sourceSymbol?: string;
  market?: BookMarket;
  bucket: number;
  /** Chỉ lấy mẫu mức trong ±N% quanh mid (0 = không giới hạn). */
  sampleRangePct?: number;
  sampleSec: number;
  retainH: number;
  /** Snapshot lại định kỳ để làm mới vùng giá phủ được. */
  resyncMin: number;
  /** Giá còn cách mép vùng phủ < N% độ rộng phía đó → snapshot lại (0 = tắt). */
  edgeResyncPct?: number;
  /** Khoảng cách tối thiểu giữa 2 lần snapshot do chạm mép (giây). */
  edgeResyncMinSec?: number;
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
  sourceSymbol: string;
  market: BookMarket;
  /** Vùng giá snapshot sổ lệnh phủ được (0 khi chưa đồng bộ). */
  coverLow: number;
  coverHigh: number;
  connected: boolean;
  synced: boolean;
  /** Unix giây: mẫu sổ lệnh cũ nhất còn lưu. */
  since: number | null;
  lastSampleAt: number | null;
  historyMin: number;
  spotPrice: number | null;
  /** Số mức đang giữ ngoài vùng phủ snapshot (đã nhận diff). */
  farLevels?: number;
  lastResyncReason?: string | null;
  error?: string;
}

/** Lý do snapshot lại mà luồng diff vẫn liền mạch → giữ được các mức ngoài vùng phủ mới. */
const CARRY_REASONS = new Set(['định kỳ', 'gần mép vùng phủ']);

interface SampleRow {
  t: number;
  data: string;
}

export class BookCollector {
  private readonly book: LocalBook;
  private readonly market: BookMarket;
  private readonly sourceSymbol: string;
  /** Socket đang mở theo URL. */
  private sockets = new Map<string, WebSocket>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectDelays = new Map<string, number>();
  private buffer: DepthDiff[] = [];
  private syncing = false;
  private stopped = true;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastError: string | undefined;
  private lastResyncReason: string | null = null;
  private lastEdgeResyncAt = Number.NEGATIVE_INFINITY;
  /** Lệnh chủ động đang gộp theo giây: key `${giây}:${side}`. */
  private pendingTrades = new Map<string, { t: number; side: 'BUY' | 'SELL'; qty: number; notional: number }>();
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly now: () => number;

  constructor(private readonly opts: CollectorOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsFactory = opts.wsFactory ?? (url => new WebSocket(url));
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.market = opts.market ?? 'spot';
    this.sourceSymbol = opts.sourceSymbol ?? opts.symbol;
    this.book = new LocalBook(this.market);
  }

  get symbol(): string {
    return this.opts.symbol;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const ep of streamEndpoints(this.market, this.sourceSymbol)) this.connect(ep);
    this.timers.push(setInterval(() => this.takeSample(), this.opts.sampleSec * 1000));
    this.timers.push(setInterval(() => void this.resync('định kỳ'), this.opts.resyncMin * 60_000));
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
    this.book.reset();
  }

  status(): CollectorStatus {
    const range = this.opts.db
      .prepare('SELECT MIN(t) AS lo, MAX(t) AS hi FROM book_samples WHERE symbol = ?')
      .get(this.opts.symbol) as { lo: number | null; hi: number | null };
    return {
      symbol: this.opts.symbol,
      sourceSymbol: this.sourceSymbol,
      market: this.market,
      coverLow: this.book.isSynced ? this.book.coverLow : 0,
      coverHigh: this.book.isSynced ? this.book.coverHigh : 0,
      connected: this.sockets.size === streamEndpoints(this.market, this.sourceSymbol).length && [...this.sockets.values()].every(ws => ws.readyState === WebSocket.OPEN),
      synced: this.book.isSynced,
      since: range.lo,
      lastSampleAt: range.hi,
      historyMin: range.lo != null && range.hi != null ? Math.round((range.hi - range.lo) / 60) : 0,
      spotPrice: this.book.mid() ?? null,
      farLevels: this.book.isSynced ? this.book.farLevelCount() : 0,
      lastResyncReason: this.lastResyncReason,
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
  private connect(ep: StreamEndpoint): void {
    if (this.stopped) return;
    const ws = this.wsFactory(ep.url);
    this.sockets.set(ep.url, ws);
    if (ep.depth) {
      this.buffer = [];
      this.book.reset();
    }
    ws.addEventListener('open', () => {
      this.reconnectDelays.delete(ep.url);
      if (ep.depth) void this.resync('kết nối');
    });
    ws.addEventListener('message', ev => {
      if (this.sockets.get(ep.url) !== ws) return;
      try {
        this.onMessage(JSON.parse(String(ev.data)) as { data?: Record<string, unknown> });
      } catch {
        // Bỏ message hỏng.
      }
    });
    ws.addEventListener('close', () => {
      if (this.sockets.get(ep.url) !== ws) return;
      this.sockets.delete(ep.url);
      if (ep.depth) this.book.reset();
      this.scheduleReconnect(ep);
    });
    ws.addEventListener('error', () => {
      this.lastError = 'Lỗi WebSocket Binance';
    });
  }

  private scheduleReconnect(ep: StreamEndpoint): void {
    if (this.stopped || this.reconnectTimers.has(ep.url)) return;
    const delay = this.reconnectDelays.get(ep.url) ?? 1000;
    this.reconnectTimers.set(
      ep.url,
      setTimeout(() => {
        this.reconnectTimers.delete(ep.url);
        this.connect(ep);
      }, delay),
    );
    this.reconnectDelays.set(ep.url, Math.min(delay * 2, 60_000));
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
      if (d.pu !== undefined) diff.pu = Number(d.pu);
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
        .run(this.opts.symbol, g.t, roundPrice(g.notional / g.qty), Math.round(g.qty * 1000) / 1000, g.side);
    }
  }

  /** Snapshot REST rồi áp các diff đang buffer. */
  async resync(reason: string): Promise<void> {
    if (this.syncing || this.stopped) return;
    // Luồng diff liền mạch thì toàn bộ sổ hiện tại vẫn đúng → giữ phần nằm ngoài vùng phủ của snapshot mới.
    const carry: BookLevels | undefined = CARRY_REASONS.has(reason) && this.book.isSynced ? this.book.levels() : undefined;
    this.syncing = true;
    try {
      for (let attempt = 0; attempt < 3 && !this.stopped; attempt++) {
        const snap = await this.fetchSnapshot();
        const pending = this.buffer;
        this.buffer = [];
        // Áp mọi diff đã buffer (kể cả diff cũ hơn snapshot) lên phần giữ lại để không sót thay đổi trong lúc chụp.
        if (carry) applyDiffsToLevels(carry, pending);
        this.book.applySnapshot(snap, carry);
        let gap = false;
        for (const diff of pending) {
          if (this.book.applyDiff(diff) === 'gap') {
            gap = true;
            break;
          }
        }
        if (!gap) {
          this.lastError = undefined;
          this.lastResyncReason = reason;
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
    const res = await this.fetchImpl(depthSnapshotUrl(this.market, this.sourceSymbol), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    return (await res.json()) as DepthSnapshot;
  }

  // ---------- Mẫu & dọn dẹp ----------
  /** Gom sổ lệnh hiện tại và ghi DB (export cho test). */
  takeSample(): BookSample | null {
    this.flushTrades(this.now());
    if (!this.book.isSynced) return null;
    const s = sampleBook(this.book, this.opts.bucket, this.now(), this.opts.sampleRangePct ?? 0);
    if (!s) return null;
    this.opts.db
      .prepare('INSERT OR REPLACE INTO book_samples (symbol, t, data) VALUES (?, ?, ?)')
      .run(this.opts.symbol, s.t, JSON.stringify(s));
    this.maybeEdgeResync(s.mid);
    return s;
  }

  /** Giá tới gần mép vùng phủ → snapshot lại sớm (giới hạn tần suất). */
  private maybeEdgeResync(mid: number): void {
    const pct = this.opts.edgeResyncPct ?? 0;
    if (this.syncing || !this.book.isSynced) return;
    if (!nearCoverEdge(mid, this.book.coverLow, this.book.coverHigh, this.book.snapMid, pct)) return;
    const now = this.now();
    if (now - this.lastEdgeResyncAt < (this.opts.edgeResyncMinSec ?? 60)) return;
    this.lastEdgeResyncAt = now;
    void this.resync('gần mép vùng phủ');
  }

  private prune(): void {
    const cutoff = this.now() - this.opts.retainH * 3600;
    this.opts.db.prepare('DELETE FROM book_samples WHERE symbol = ? AND t < ?').run(this.opts.symbol, cutoff);
    this.opts.db.prepare('DELETE FROM big_trades WHERE symbol = ? AND t < ?').run(this.opts.symbol, cutoff);
  }
}
