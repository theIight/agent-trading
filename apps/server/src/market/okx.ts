import type { Candle, Timeframe } from '@wca/shared';

// OKX public REST: `GET /api/v5/market/history-candles?instId&bar&after&limit` (100 nến/lần, mới → cũ).
// Hàng: [ts(ms), o, h, l, c, vol(hợp đồng), volCcy(coin, vd XAU), volCcyQuote, confirm].
// Nến ≥ 6H mặc định theo UTC+8 → dùng biến thể `utc`.

export const OKX_BASE = 'https://www.okx.com';

export const OKX_BAR: Record<Timeframe, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1Dutc', '1w': '1Wutc',
};

export interface OkxVolumeBar {
  /** open time (giây) */
  time: number;
  /** volume tính theo đồng cơ sở (XAU). */
  volume: number;
}

export function parseOkxRows(rows: string[][]): OkxVolumeBar[] {
  return rows
    .map(r => ({ time: Math.floor(Number(r[0]) / 1000), volume: Number(r[6] ?? r[5]) }))
    .filter(b => Number.isFinite(b.time) && Number.isFinite(b.volume))
    .sort((a, b) => a.time - b.time);
}

export interface OkxOptions {
  instId: string;
  fetchImpl?: typeof fetch;
  /** Số trang tối đa mỗi lần lấy (100 nến/trang). */
  maxPages?: number;
}

export class OkxVolumeClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: OkxOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get instId(): string {
    return this.opts.instId;
  }

  private async page(bar: string, after?: number, endpoint = 'history-candles', limit = 100): Promise<OkxVolumeBar[]> {
    const q = new URLSearchParams({ instId: this.opts.instId, bar, limit: String(limit) });
    if (after) q.set('after', String(after * 1000));
    const res = await this.fetchImpl(`${OKX_BASE}/api/v5/market/${endpoint}?${q}`, {
      headers: { 'User-Agent': 'wyckoff-chart-agent/0.1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`OKX ${res.status}`);
    const body = (await res.json()) as { code: string; msg: string; data: string[][] };
    if (body.code !== '0') throw new Error(`OKX ${body.code}: ${body.msg}`);
    return parseOkxRows(body.data);
  }

  /** Volume các nến OKX có open time trong [from, to), tăng dần. */
  async volumes(tfBar: string, from: number, to: number): Promise<OkxVolumeBar[]> {
    const out: OkxVolumeBar[] = [];
    let after: number | undefined = to;
    for (let i = 0; i < (this.opts.maxPages ?? 40); i++) {
      const rows = await this.page(tfBar, after);
      if (!rows.length) break;
      out.push(...rows.filter(r => r.time >= from && r.time < to));
      const oldest = rows[0]!.time;
      if (oldest <= from) break;
      after = oldest;
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /** 2 nến mới nhất (realtime: volume nến đang chạy). */
  async latest(tfBar: string): Promise<OkxVolumeBar[]> {
    return this.page(tfBar, undefined, 'candles', 2);
  }
}

/**
 * Gán volume cho nến giá: volume nến [t, t+step) = tổng volume các nến OKX có open time trong khoảng đó.
 * Không có nến OKX nào → 0 (= không có dữ liệu volume).
 */
export function mergeVolumes(price: readonly Candle[], vols: readonly OkxVolumeBar[], stepOf: (c: Candle, next?: Candle) => number): Candle[] {
  let j = 0;
  return price.map((c, i) => {
    const end = c.time + stepOf(c, price[i + 1]);
    while (j < vols.length && vols[j]!.time < c.time) j++;
    let sum = 0;
    let k = j;
    while (k < vols.length && vols[k]!.time < end) sum += vols[k++]!.volume;
    return { ...c, volume: Math.round(sum * 1000) / 1000 };
  });
}
