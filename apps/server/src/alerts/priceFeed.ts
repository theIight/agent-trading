// Đường nhanh cho alert chạm entry: giá khớp realtime (đã quy về giá chart). Nến 1m đóng vẫn là lưới an toàn.

export type PriceListener = (price: number, timeMs: number) => void;

export interface PriceFeed {
  /** Symbol chart có giá realtime không. */
  has(symbol: string): boolean;
  /** Đăng ký nhận giá; trả hàm huỷ. */
  subscribe(symbol: string, listener: PriceListener): () => void;
}

/** Nguồn giá khớp thô (collector order flow Binance: aggTrade theo giá nguồn). */
export interface TradeSource {
  onTrade(listener: PriceListener): () => void;
}

export interface CollectorPriceFeedOptions {
  /** symbol chart → nguồn giá khớp. */
  sources: Record<string, TradeSource>;
  /** Basis giá nguồn − giá chart hiện tại (spot/futures khác chart). */
  basisOf: (symbol: string, nowSec: number) => Promise<number>;
  /** Làm mới basis mỗi bấy nhiêu ms (mặc định 60s). */
  basisTtlMs?: number;
  log?: (msg: string) => void;
}

/**
 * Feed từ collector order flow: giá chart = giá khớp − basis (basis cache theo phút, làm mới bất đồng bộ).
 * Chưa có basis → bỏ qua tick (không báo theo giá chưa quy đổi).
 */
export class CollectorPriceFeed implements PriceFeed {
  private readonly basis = new Map<string, { value: number; at: number }>();
  private readonly loading = new Set<string>();

  constructor(private readonly opts: CollectorPriceFeedOptions) {}

  has(symbol: string): boolean {
    return Boolean(this.opts.sources[symbol]);
  }

  subscribe(symbol: string, listener: PriceListener): () => void {
    const src = this.opts.sources[symbol];
    if (!src) return () => {};
    return src.onTrade((price, timeMs) => {
      const b = this.basisNow(symbol, timeMs);
      if (b !== undefined) listener(price - b, timeMs);
    });
  }

  private basisNow(symbol: string, timeMs: number): number | undefined {
    const hit = this.basis.get(symbol);
    if ((!hit || timeMs - hit.at >= (this.opts.basisTtlMs ?? 60_000)) && !this.loading.has(symbol)) {
      this.loading.add(symbol);
      this.opts
        .basisOf(symbol, Math.floor(timeMs / 1000))
        .then(value => {
          if (Number.isFinite(value)) this.basis.set(symbol, { value, at: timeMs });
        })
        .catch(err => this.opts.log?.(`[alert] ${symbol}: không tính được basis: ${(err as Error).message}`))
        .finally(() => this.loading.delete(symbol));
    }
    return hit?.value;
  }
}
