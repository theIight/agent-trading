import { tfSeconds, type Timeframe, type VolumeVenue } from '@wca/shared';

// Volume nến (đồng gốc) từng sàn qua REST công khai. Chỉ trả nến ĐÃ ĐÓNG (`time + tf ≤ now`).

export interface VenueSymbols {
  binanceFut: string;
  binanceSpot: string;
  okx: string;
  bybit: string;
}

export type VolumeFetcher = (venue: VolumeVenue, sym: VenueSymbols, tf: Timeframe, from: number, to: number) => Promise<Map<number, number>>;

const BINANCE_TF: Record<Timeframe, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' };
/** OKX: khung ngày/tuần mặc định theo giờ HK → dùng bản UTC. */
const OKX_TF: Record<Timeframe, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1Dutc', '1w': '1Wutc' };
const BYBIT_TF: Record<Timeframe, string> = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' };

const step = (tf: Timeframe) => tfSeconds(tf);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** GET JSON; 429 (giới hạn tần suất) → chờ rồi thử lại tối đa 3 lần. */
async function getJson(fetchImpl: typeof fetch, url: string, retryMs = 1000): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 429 && attempt < 3) {
      await sleep(retryMs * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

/** OKX history-candles giới hạn ~10 request/giây → nghỉ giữa các trang. */
export const OKX_PAGE_DELAY_MS = 150;

/** Binance spot/futures: tăng dần theo startTime/endTime. Volume = cột 5 (đồng gốc). */
async function binance(fetchImpl: typeof fetch, base: string, symbol: string, tf: Timeframe, from: number, to: number, now: number) {
  const out = new Map<number, number>();
  let start = from;
  while (start <= to) {
    const p = new URLSearchParams({ symbol, interval: BINANCE_TF[tf], startTime: String(start * 1000), endTime: String((to + step(tf) - 1) * 1000), limit: '1000' });
    const rows = (await getJson(fetchImpl, `${base}?${p}`)) as [number, string, string, string, string, string][];
    if (!Array.isArray(rows) || !rows.length) break;
    for (const k of rows) {
      const t = Math.floor(k[0] / 1000);
      if (t + step(tf) <= now && t >= from && t <= to) out.set(t, Number(k[5]));
    }
    start = Math.floor(rows.at(-1)![0] / 1000) + step(tf);
    if (rows.length < 1000) break;
  }
  return out;
}

/** OKX history-candles: lùi dần bằng `after` (ts cũ hơn), 100 nến/lần. Volume = volCcy (cột 6, đồng gốc). */
async function okx(fetchImpl: typeof fetch, instId: string, tf: Timeframe, from: number, to: number, now: number, pageDelayMs: number) {
  const out = new Map<number, number>();
  let after = (to + step(tf)) * 1000;
  for (let guard = 0; guard < 50; guard++) {
    if (guard) await sleep(pageDelayMs);
    const p = new URLSearchParams({ instId, bar: OKX_TF[tf], after: String(after), limit: '100' });
    const body = (await getJson(fetchImpl, `https://www.okx.com/api/v5/market/history-candles?${p}`)) as { code?: string; data?: string[][]; msg?: string };
    if (body.code !== '0') throw new Error(`OKX ${body.code}: ${body.msg ?? ''}`);
    const rows = body.data ?? [];
    if (!rows.length) break;
    for (const k of rows) {
      const t = Math.floor(Number(k[0]) / 1000);
      if (t + step(tf) <= now && t >= from && t <= to) out.set(t, Number(k[6]));
    }
    const oldest = Number(rows.at(-1)![0]);
    if (oldest / 1000 <= from || rows.length < 100) break;
    after = oldest;
  }
  return out;
}

/** Bybit linear: giảm dần, start/end, 1000 nến/lần. Volume = cột 5 (đồng gốc). */
async function bybit(fetchImpl: typeof fetch, symbol: string, tf: Timeframe, from: number, to: number, now: number) {
  const out = new Map<number, number>();
  let end = (to + step(tf) - 1) * 1000;
  for (let guard = 0; guard < 20; guard++) {
    const p = new URLSearchParams({ category: 'linear', symbol, interval: BYBIT_TF[tf], start: String(from * 1000), end: String(end), limit: '1000' });
    const body = (await getJson(fetchImpl, `https://api.bybit.com/v5/market/kline?${p}`)) as { retCode?: number; retMsg?: string; result?: { list?: string[][] } };
    if (body.retCode !== 0) throw new Error(`Bybit ${body.retCode}: ${body.retMsg ?? ''}`);
    const rows = body.result?.list ?? [];
    if (!rows.length) break;
    for (const k of rows) {
      const t = Math.floor(Number(k[0]) / 1000);
      if (t + step(tf) <= now && t >= from && t <= to) out.set(t, Number(k[5]));
    }
    const oldest = Number(rows.at(-1)![0]);
    if (oldest / 1000 <= from || rows.length < 1000) break;
    end = oldest - 1;
  }
  return out;
}

export function makeVolumeFetcher(
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => Math.floor(Date.now() / 1000),
  okxPageDelayMs = OKX_PAGE_DELAY_MS,
): VolumeFetcher {
  return (venue, sym, tf, from, to) => {
    const n = now();
    switch (venue) {
      case 'binanceFut':
        return binance(fetchImpl, 'https://fapi.binance.com/fapi/v1/klines', sym.binanceFut, tf, from, to, n);
      case 'binanceSpot':
        return binance(fetchImpl, 'https://api.binance.com/api/v3/klines', sym.binanceSpot, tf, from, to, n);
      case 'okx':
        return okx(fetchImpl, sym.okx, tf, from, to, n, okxPageDelayMs);
      case 'bybit':
        return bybit(fetchImpl, sym.bybit, tf, from, to, n);
    }
  };
}
