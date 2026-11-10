import { describe, expect, it } from 'vitest';
import type { Candle } from '@wca/shared';
import { mergeVolumes, OkxVolumeClient, parseOkxRows } from '../apps/server/src/market/okx.ts';
import { aggregateWeekly, parseTiingoBars, QuotaExceededError, RequestQuota, TiingoFxClient, tiingoDateRange, weekStartUtc } from '../apps/server/src/market/tiingo.ts';
import { applyQuote, bucketStart, parseTiingoFxMessage, TiingoOkxLive, TiingoOkxProvider } from '../apps/server/src/market/tiingoOkx.ts';
import type { LiveEvent } from '../apps/server/src/market/livePoller.ts';

const H = 3600;
const D = 86400;
// 2026-11-02 là thứ 2.
const MON = Date.UTC(2026, 10, 2) / 1000;
const c = (time: number, close = 100, volume = 0): Candle => ({ time, open: 100, high: close + 1, low: close - 1, close, volume });

describe('Tiingo', () => {
  it('parse nến: ISO → unix giây, volume 0, sắp tăng dần', () => {
    const bars = parseTiingoBars([
      { date: '2026-11-02T01:00:00.000Z', open: 4000, high: 4010, low: 3990, close: 4005 },
      { date: '2026-11-02T00:00:00.000Z', open: 3995, high: 4002, low: 3990, close: 4000 },
    ]);
    expect(bars.map(b => b.time)).toEqual([MON, MON + H]);
    expect(bars[0]).toMatchObject({ open: 3995, close: 4000, volume: 0 });
  });

  it('tuần vàng: nến Chủ nhật thuộc tuần sau; gộp OHLC + cộng volume', () => {
    expect(weekStartUtc(MON)).toBe(MON);
    expect(weekStartUtc(MON - D)).toBe(MON); // Chủ nhật 01/11 → tuần 02/11
    expect(weekStartUtc(MON + 4 * D)).toBe(MON); // thứ 6
    expect(weekStartUtc(MON + 6 * D)).toBe(MON + 7 * D); // Chủ nhật 08/11 → tuần sau
    const w = aggregateWeekly([c(MON - D, 101, 1), c(MON, 103, 2), c(MON + 4 * D, 99, 3), c(MON + 6 * D, 98, 4)]);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ time: MON, open: 100, high: 104, low: 98, close: 99, volume: 6 });
    expect(w[1]).toMatchObject({ time: MON + 7 * D, volume: 4 });
  });

  it('khoảng ngày đủ rộng cho limit nến (tính cả cuối tuần)', () => {
    const r = tiingoDateRange('1h', 300, MON + 5 * D);
    const days = (Date.parse(r.endDate) - Date.parse(r.startDate)) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(300 / 24 * 1.4);
  });

  it('quota: chặn khi chạm giới hạn giờ, mở lại sau 1 giờ', () => {
    let now = 0;
    const q = new RequestQuota(2, 100, () => now);
    q.take();
    q.take();
    expect(() => q.take()).toThrow(QuotaExceededError);
    now += 3_600_001;
    expect(() => q.take()).not.toThrow();
    expect(q.usage()).toEqual({ lastHour: 1, lastDay: 3 });
  });

  it('client: thiếu token → lỗi rõ ràng; gọi đúng URL + header Token; lọc ≤ endTime + limit', async () => {
    await expect(new TiingoFxClient({ quota: new RequestQuota(5, 5) }).fetchBars('xauusd', '1h', 2)).rejects.toThrow(/TIINGO_API_TOKEN/);
    let url = '';
    let auth = '';
    const fetchImpl = (async (u: string, init: RequestInit) => {
      url = u;
      auth = (init.headers as Record<string, string>).Authorization!;
      return new Response(JSON.stringify([0, 1, 2, 3].map(i => ({ date: new Date((MON + i * H) * 1000).toISOString(), open: 1, high: 2, low: 0.5, close: 1.5 }))));
    }) as unknown as typeof fetch;
    const client = new TiingoFxClient({ token: 'tk', quota: new RequestQuota(5, 5), fetchImpl });
    const bars = await client.fetchBars('xauusd', '1h', 2, MON + 2 * H);
    expect(url).toMatch(/\/tiingo\/fx\/xauusd\/prices\?startDate=\d{4}-\d\d-\d\d&endDate=\d{4}-\d\d-\d\d&resampleFreq=1hour$/);
    expect(auth).toBe('Token tk');
    expect(bars.map(b => b.time)).toEqual([MON + H, MON + 2 * H]);
    await expect(client.fetchBars('xauusd', '1w', 2)).rejects.toThrow(/aggregateWeekly/);
  });
});

describe('OKX volume', () => {
  it('parse hàng OKX: volCcy (XAU), sắp tăng dần', () => {
    expect(parseOkxRows([[`${(MON + H) * 1000}`, '1', '1', '1', '1', '5000', '5.0', '20000', '1'], [`${MON * 1000}`, '1', '1', '1', '1', '3000', '3.0', '12000', '1']])).toEqual([
      { time: MON, volume: 3 },
      { time: MON + H, volume: 5 },
    ]);
  });

  it('ghép volume theo khoảng thời gian: cộng mọi nến OKX trong [t, t+step), thiếu → 0', () => {
    const price = [c(MON), c(MON + 4 * H), c(MON + 8 * H)];
    const vols = [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ time: MON + i * H, volume: 1 }));
    expect(mergeVolumes(price, vols, () => 4 * H).map(x => x.volume)).toEqual([4, 4, 0]);
  });

  it('client phân trang ngược bằng `after`, dừng khi qua mốc from', async () => {
    const urls: string[] = [];
    const pages = [
      [3, 2].map(i => [`${(MON + i * H) * 1000}`, '1', '1', '1', '1', '1', String(i), '1', '1']),
      [1, 0].map(i => [`${(MON + i * H) * 1000}`, '1', '1', '1', '1', '1', String(i), '1', '1']),
    ];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ code: '0', msg: '', data: pages[urls.length - 1] ?? [] }));
    }) as unknown as typeof fetch;
    const okx = new OkxVolumeClient({ instId: 'XAU-USDT-SWAP', fetchImpl });
    const v = await okx.volumes('1H', MON + H, MON + 4 * H);
    expect(v.map(x => x.time)).toEqual([MON + H, MON + 2 * H, MON + 3 * H]);
    expect(urls[1]).toContain(`after=${(MON + 2 * H) * 1000}`);
  });
});

describe('Tiingo + OKX provider', () => {
  const tiingoBars = (n: number, step: number, start = MON) => Array.from({ length: n }, (_, i) => c(start + i * step, 100 + i));
  const fakeTiingo = (bars: Candle[]) => ({ fetchBars: async () => bars, token: 't', quota: new RequestQuota(9, 9) }) as unknown as TiingoFxClient;
  const fakeOkx = (vols: { time: number; volume: number }[], calls: string[] = []) =>
    ({ volumes: async (bar: string) => { calls.push(bar); return vols; }, latest: async () => vols, instId: 'X' }) as unknown as OkxVolumeClient;

  it('nến giá Tiingo + volume OKX cùng khung; OKX lỗi → vẫn trả giá (volume 0)', async () => {
    const p = new TiingoOkxProvider({ tiingo: fakeTiingo(tiingoBars(3, H)), okx: fakeOkx([{ time: MON, volume: 7 }, { time: MON + H, volume: 9 }]) });
    expect((await p.fetchKlines({ symbol: 'XAUUSD', tf: '1h', limit: 3 })).map(x => x.volume)).toEqual([7, 9, 0]);
    const broken = new TiingoOkxProvider({
      tiingo: fakeTiingo(tiingoBars(2, H)),
      okx: { volumes: async () => { throw new Error('OKX 500'); } } as unknown as OkxVolumeClient,
    });
    expect((await broken.fetchKlines({ symbol: 'XAUUSD', tf: '1h', limit: 2 })).map(x => x.volume)).toEqual([0, 0]);
  });

  it('nến ngày: căn 00:00 UTC → OKX 1Dutc; lệch giờ → cộng từ OKX 1H', async () => {
    const calls: string[] = [];
    await new TiingoOkxProvider({ tiingo: fakeTiingo(tiingoBars(2, D)), okx: fakeOkx([], calls) }).fetchKlines({ symbol: 'XAUUSD', tf: '1d', limit: 2 });
    await new TiingoOkxProvider({ tiingo: fakeTiingo(tiingoBars(2, D, MON + 22 * H)), okx: fakeOkx([], calls) }).fetchKlines({ symbol: 'XAUUSD', tf: '1d', limit: 2 });
    expect(calls).toEqual(['1Dutc', '1H']);
  });

  it('1W = gộp nến ngày (đã có volume)', async () => {
    const days = [0, 1, 2, 3, 4, 7].map(i => c(MON + i * D, 100 + i));
    const vols = days.map(d => ({ time: d.time, volume: 2 }));
    const w = await new TiingoOkxProvider({ tiingo: fakeTiingo(days), okx: fakeOkx(vols) }).fetchKlines({ symbol: 'XAUUSD', tf: '1w', limit: 5 });
    expect(w.map(x => [x.time, x.volume])).toEqual([[MON, 10], [MON + 7 * D, 2]]);
  });
});

describe('realtime Tiingo', () => {
  it('parse message WebSocket FX (quote "Q")', () => {
    expect(parseTiingoFxMessage(JSON.stringify({ service: 'fx', messageType: 'A', data: ['Q', 'xauusd', '2026-11-02T00:30:00.000000+00:00', 1e6, 4000.1, 4000.2, 1e6, 4000.3] }))).toEqual({
      ticker: 'xauusd', time: MON + 1800, mid: 4000.2,
    });
    expect(parseTiingoFxMessage(JSON.stringify({ messageType: 'H' }))).toBeNull();
    expect(parseTiingoFxMessage('not json')).toBeNull();
  });

  it('applyQuote: cập nhật H/L/C trong nến; sang nến mới → trả nến cũ là closed; quote cũ bỏ qua', () => {
    let r = applyQuote(null, MON + 60, 100, '1h');
    expect(r.current).toMatchObject({ time: MON, open: 100, close: 100 });
    r = applyQuote(r.current, MON + 120, 105, '1h');
    r = applyQuote(r.current, MON + 180, 98, '1h');
    expect(r.current).toMatchObject({ high: 105, low: 98, close: 98 });
    const next = applyQuote(r.current, MON + H + 5, 99, '1h');
    expect(next.closed).toMatchObject({ time: MON, close: 98 });
    expect(next.current).toMatchObject({ time: MON + H, open: 99 });
    expect(applyQuote(next.current, MON + 10, 1, '1h').current).toBe(next.current);
    expect(bucketStart(MON + 5 * H, '4h')).toBe(MON + 4 * H);
  });

  it('feed: seed từ REST, quote cập nhật, subscribe WebSocket đúng ticker, dừng khi hết người xem', async () => {
    const sent: string[] = [];
    const fakeWs = { readyState: 0, send: (m: string) => sent.push(m), close: () => {}, onopen: null as null | (() => void), onmessage: null, onclose: null, onerror: null };
    const provider = new TiingoOkxProvider({
      tiingo: ({ fetchBars: async () => [c(MON, 100)], token: 'tk', quota: new RequestQuota(9, 9) }) as unknown as TiingoFxClient,
      okx: ({ volumes: async () => [], latest: async () => [] }) as unknown as OkxVolumeClient,
    });
    const live = new TiingoOkxLive(provider, 1_000_000, () => fakeWs as unknown as WebSocket);
    const events: LiveEvent[] = [];
    const unsub = live.subscribe('XAUUSD', '1h', e => events.push(e));
    await new Promise(r => setTimeout(r, 0));
    fakeWs.onopen?.();
    expect(JSON.parse(sent[0]!)).toEqual({ eventName: 'subscribe', authorization: 'tk', eventData: { thresholdLevel: 5, tickers: ['xauusd'] } });
    live.onQuote('xauusd', MON + 600, 103);
    live.onQuote('eurusd', MON + 600, 1.1);
    expect(events.map(e => ('candle' in e ? [e.candle.close, e.closed] : e))).toEqual([[100, false], [103, false]]);
    unsub();
    expect(live.activeFeeds).toBe(0);
  });
});
