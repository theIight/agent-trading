// Sổ lệnh cục bộ đồng bộ theo quy trình của Binance:
// - spot: buffer diff → snapshot REST → bỏ diff có u ≤ lastUpdateId → diff đầu phải có U ≤ lastUpdateId+1 ≤ u
//   → các diff sau phải liền mạch (U = u trước + 1);
// - futures (USDⓈ-M): bỏ diff có u < lastUpdateId → diff đầu phải có U ≤ lastUpdateId ≤ u
//   → các diff sau phải có pu = u của diff trước.
// Đứt chuỗi thì snapshot lại.

export type BookMarket = 'spot' | 'futures';

export type RawLevel = [string, string];

export interface DepthSnapshot {
  lastUpdateId: number;
  bids: RawLevel[];
  asks: RawLevel[];
}

export interface DepthDiff {
  /** Update ID đầu / cuối của event. */
  U: number;
  u: number;
  /** Futures: u của event trước. */
  pu?: number;
  b: RawLevel[];
  a: RawLevel[];
}

export type DiffResult = 'applied' | 'stale' | 'gap';

export class LocalBook {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  private lastId = -1;
  private synced = false;
  /** Vùng giá snapshot phủ được; ngoài vùng này sổ lệnh không đầy đủ. */
  coverLow = 0;
  coverHigh = 0;

  constructor(readonly market: BookMarket = 'spot') {}

  get isSynced(): boolean {
    return this.synced;
  }

  get lastUpdateId(): number {
    return this.lastId;
  }

  applySnapshot(s: DepthSnapshot): void {
    this.bids.clear();
    this.asks.clear();
    for (const [p, q] of s.bids) setLevel(this.bids, p, q);
    for (const [p, q] of s.asks) setLevel(this.asks, p, q);
    this.lastId = s.lastUpdateId;
    this.synced = false;
    const bidPrices = s.bids.map(l => Number(l[0]));
    const askPrices = s.asks.map(l => Number(l[0]));
    this.coverLow = bidPrices.length ? Math.min(...bidPrices) : 0;
    this.coverHigh = askPrices.length ? Math.max(...askPrices) : 0;
  }

  /** Áp một diff. `gap` = mất chuỗi, cần snapshot lại. */
  applyDiff(d: DepthDiff): DiffResult {
    if (this.lastId < 0) return 'gap';
    if (this.market === 'futures') {
      if (d.u < this.lastId) return 'stale';
      if (!this.synced) {
        if (d.U > this.lastId) return 'gap';
      } else if (d.pu !== this.lastId) {
        return 'gap';
      }
    } else {
      if (d.u <= this.lastId) return 'stale';
      if (!this.synced) {
        if (d.U > this.lastId + 1) return 'gap';
      } else if (d.U !== this.lastId + 1) {
        return 'gap';
      }
    }
    for (const [p, q] of d.b) setLevel(this.bids, p, q);
    for (const [p, q] of d.a) setLevel(this.asks, p, q);
    this.lastId = d.u;
    this.synced = true;
    return 'applied';
  }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.lastId = -1;
    this.synced = false;
  }

  bestBid(): number | undefined {
    let best: number | undefined;
    for (const p of this.bids.keys()) if (best === undefined || p > best) best = p;
    return best;
  }

  bestAsk(): number | undefined {
    let best: number | undefined;
    for (const p of this.asks.keys()) if (best === undefined || p < best) best = p;
    return best;
  }

  mid(): number | undefined {
    const b = this.bestBid();
    const a = this.bestAsk();
    return b !== undefined && a !== undefined ? (a + b) / 2 : undefined;
  }
}

function setLevel(side: Map<number, number>, p: string, q: string): void {
  const price = Number(p);
  const qty = Number(q);
  if (!Number.isFinite(price) || !Number.isFinite(qty)) return;
  if (qty === 0) side.delete(price);
  else side.set(price, qty);
}

/** Một mẫu sổ lệnh đã gom theo bucket giá: `[giá bucket, khối lượng]`, giá bucket = cận dưới (bid) / cận dưới (ask). */
export interface BookSample {
  /** Unix giây. */
  t: number;
  mid: number;
  bids: [number, number][];
  asks: [number, number][];
}

const roundQty = (x: number) => Math.round(x * 1000) / 1000;

/** Gom sổ lệnh theo bucket, chỉ trong vùng snapshot phủ được. */
export function sampleBook(book: LocalBook, bucket: number, t: number): BookSample | null {
  const mid = book.mid();
  if (mid === undefined || !(bucket > 0)) return null;
  const agg = (side: Map<number, number>, within: (p: number) => boolean) => {
    const m = new Map<number, number>();
    for (const [p, q] of side) {
      if (!within(p)) continue;
      const key = Math.floor(p / bucket) * bucket;
      m.set(key, (m.get(key) ?? 0) + q);
    }
    return [...m.entries()].map(([p, q]): [number, number] => [roundQty(p), roundQty(q)]).sort((x, y) => x[0] - y[0]);
  };
  return {
    t,
    mid: Math.round(mid * 100) / 100,
    bids: agg(book.bids, p => p >= book.coverLow && p <= mid),
    asks: agg(book.asks, p => p <= book.coverHigh && p >= mid),
  };
}
