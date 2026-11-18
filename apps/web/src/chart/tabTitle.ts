// Tiêu đề tab trình duyệt kiểu TradingView: `BTCUSDT 64,083.1 ▲ +0.15%`.
// % so với giá đóng nến 1D đã đóng gần nhất (không đổi theo khung đang xem).

export const DEFAULT_TITLE = 'Wyckoff Chart Agent';
const DAY = 86_400;

export interface TabTitleInput {
  symbol: string;
  price?: number | null;
  precision?: number;
  /** Giá đóng nến 1D đã đóng gần nhất. */
  refClose?: number | null;
  error?: boolean;
}

export function formatTabTitle({ symbol, price, precision = 2, refClose, error }: TabTitleInput): string {
  if (!symbol) return DEFAULT_TITLE;
  if (error) return `${symbol} · Lỗi`;
  if (price == null || !Number.isFinite(price)) return symbol;
  const p = Math.max(0, Math.min(10, Math.round(precision)));
  const text = `${symbol} ${price.toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p })}`;
  if (!refClose || !Number.isFinite(refClose)) return text;
  const pct = ((price - refClose) / refClose) * 100;
  const pctText = Math.abs(pct).toFixed(2);
  if (pctText === '0.00') return `${text} 0.00%`;
  return pct > 0 ? `${text} ▲ +${pctText}%` : `${text} ▼ −${pctText}%`;
}

export interface DailyRef {
  close: number;
  /** Mốc mở của nến 1D đó (giây). */
  time: number;
}

export interface TickerUpdate {
  symbol: string;
  status: 'loading' | 'live' | 'error';
  close?: number;
  precision?: number;
}

export interface TabTitleDeps {
  fetchDailyRef: (symbol: string) => Promise<DailyRef | null>;
  setTitle: (title: string) => void;
  now?: () => number;
}

/** Thử lại tham chiếu ngày tối đa mỗi 10 phút (cuối tuần forex nến 1D không đổi). */
const REF_RETRY_SEC = 600;

/** Giữ trạng thái symbol/giá/tham chiếu ngày và gán tiêu đề; không phụ thuộc DOM/React (test được). */
export class TabTitleController {
  private symbol = '';
  private status: TickerUpdate['status'] = 'loading';
  private price: number | null = null;
  private precision = 2;
  private ref: DailyRef | null = null;
  private refSymbol = '';
  private refTriedAt = 0;
  private refToken = 0;
  private lastTitle = '';

  constructor(private readonly deps: TabTitleDeps) {}

  private nowSec(): number {
    return Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
  }

  update(u: TickerUpdate): void {
    if (u.symbol !== this.symbol) {
      this.symbol = u.symbol;
      this.price = null;
      this.ref = null;
      this.refSymbol = '';
      this.refTriedAt = 0;
    }
    this.status = u.status;
    if (u.close !== undefined) this.price = u.close;
    if (u.precision !== undefined) this.precision = u.precision;
    this.maybeFetchRef();
    this.render();
  }

  private maybeFetchRef(): void {
    if (!this.symbol || this.status === 'error') return;
    const now = this.nowSec();
    // Nến 1D tham chiếu mở lúc T → nến kế tiếp đóng lúc T + 2 ngày → cần tham chiếu mới.
    const stale = !this.ref || this.refSymbol !== this.symbol || now >= this.ref.time + 2 * DAY;
    if (!stale || now - this.refTriedAt < REF_RETRY_SEC) return;
    this.refTriedAt = now;
    const symbol = this.symbol;
    const token = ++this.refToken;
    this.deps
      .fetchDailyRef(symbol)
      .catch(() => null)
      .then(ref => {
        if (token !== this.refToken || symbol !== this.symbol) return;
        if (ref) {
          this.ref = ref;
          this.refSymbol = symbol;
        }
        this.render();
      });
  }

  private render(): void {
    const title = formatTabTitle({
      symbol: this.symbol,
      price: this.price,
      precision: this.precision,
      refClose: this.refSymbol === this.symbol ? this.ref?.close : null,
      error: this.status === 'error',
    });
    if (title === this.lastTitle) return;
    this.lastTitle = title;
    this.deps.setTitle(title);
  }
}
