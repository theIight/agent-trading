import { tfSeconds, type Candle, type Timeframe } from '@wca/shared';

// Tiingo FX REST: `GET /tiingo/fx/<ticker>/prices?startDate&endDate&resampleFreq` → [{date, ticker, open, high, low, close}].
// Không có volume. Gói miễn phí 50 request/giờ, 1.000/ngày → đếm quota và để KlineService trả cache khi hết.

export const TIINGO_BASE = 'https://api.tiingo.com';

/** 1w không có sẵn → gộp từ 1d. */
const RESAMPLE: Partial<Record<Timeframe, string>> = {
  '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1hour', '4h': '4hour', '1d': '1day',
};

export interface TiingoBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export class QuotaExceededError extends Error {}

/** Đếm request theo giờ / ngày (cửa sổ trượt) để không vượt quota gói miễn phí. */
export class RequestQuota {
  private stamps: number[] = [];
  constructor(
    readonly perHour: number,
    readonly perDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(): void {
    const dayAgo = this.now() - 86_400_000;
    this.stamps = this.stamps.filter(t => t > dayAgo);
  }

  usage(): { lastHour: number; lastDay: number } {
    this.prune();
    const hourAgo = this.now() - 3_600_000;
    return { lastHour: this.stamps.filter(t => t > hourAgo).length, lastDay: this.stamps.length };
  }

  /** Ghi nhận 1 request; ném lỗi nếu đã chạm giới hạn. */
  take(): void {
    const u = this.usage();
    if (u.lastHour >= this.perHour || u.lastDay >= this.perDay) {
      throw new QuotaExceededError(`Hết quota Tiingo (${u.lastHour}/${this.perHour} trong 1 giờ, ${u.lastDay}/${this.perDay} trong ngày) — dùng dữ liệu cache`);
    }
    this.stamps.push(this.now());
  }
}

export function parseTiingoBars(rows: TiingoBar[]): Candle[] {
  return rows
    .map(r => ({ time: Math.floor(Date.parse(r.date) / 1000), open: r.open, high: r.high, low: r.low, close: r.close, volume: 0 }))
    .filter(c => Number.isFinite(c.time))
    .sort((a, b) => a.time - b.time);
}

/** Tuần vàng mở tối Chủ nhật → nến Chủ nhật thuộc tuần sau. Nhãn tuần = thứ 2 00:00 UTC. */
export function weekStartUtc(time: number): number {
  const d = new Date(time * 1000);
  const dow = d.getUTCDay(); // 0 = CN
  const dayStart = Math.floor(time / 86400) * 86400;
  const shift = dow === 0 ? 1 : 1 - dow; // CN → +1 ngày; T2 → 0; T3 → -1…
  return dayStart + shift * 86400;
}

export function aggregateWeekly(daily: readonly Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of daily) {
    const w = weekStartUtc(c.time);
    const last = out.at(-1);
    if (last && last.time === w) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else out.push({ ...c, time: w });
  }
  return out;
}

/** Khoảng ngày cần lấy cho `limit` nến (thị trường nghỉ cuối tuần → nhân hệ số + đệm). */
export function tiingoDateRange(tf: Timeframe, limit: number, endTime: number): { startDate: string; endDate: string } {
  const sec = (tf === '1w' ? 7 * 86400 : tfSeconds(tf)) * limit * 1.45 + 4 * 86400;
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  return { startDate: day(endTime - sec), endDate: day(endTime + 86400) };
}

export interface TiingoOptions {
  token?: string;
  quota: RequestQuota;
  fetchImpl?: typeof fetch;
}

export class TiingoFxClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: TiingoOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get token(): string | undefined {
    return this.opts.token;
  }

  get quota(): RequestQuota {
    return this.opts.quota;
  }

  /** Nến giá (volume = 0), tăng dần theo thời gian, open time ≤ endTime, tối đa `limit` nến. */
  async fetchBars(ticker: string, tf: Timeframe, limit: number, endTime?: number): Promise<Candle[]> {
    if (!this.opts.token) throw new Error('Chưa cấu hình TIINGO_API_TOKEN trong .env (cần cho giá XAUUSD từ Tiingo)');
    const end = endTime ?? Math.floor(Date.now() / 1000);
    if (tf === '1w') throw new Error('Tiingo không có nến tuần: lấy 1d rồi aggregateWeekly');
    const { startDate, endDate } = tiingoDateRange(tf, limit, end);
    const q = new URLSearchParams({ startDate, endDate, resampleFreq: RESAMPLE[tf]! });
    this.opts.quota.take();
    const res = await this.fetchImpl(`${TIINGO_BASE}/tiingo/fx/${encodeURIComponent(ticker)}/prices?${q}`, {
      headers: { Authorization: `Token ${this.opts.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Tiingo ${res.status}: ${body.slice(0, 200)}`);
    }
    const bars = parseTiingoBars((await res.json()) as TiingoBar[]);
    return bars.filter(b => b.time <= end).slice(-limit);
  }
}
