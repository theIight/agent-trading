import { describe, expect, it } from 'vitest';
import { describeInstrument, normalizeSymbol, oandaInstrument, type Candle } from '@wca/shared';
import { LivePoller, type LiveEvent } from '../apps/server/src/market/livePoller.ts';
import { buildOandaCandleQuery, OandaProvider, parseOandaCandles } from '../apps/server/src/market/oanda.ts';
import type { FetchKlinesParams, MarketDataProvider } from '../apps/server/src/market/provider.ts';
import { RoutingProvider } from '../apps/server/src/market/router.ts';

const sample = {
  instrument: 'XAU_USD',
  granularity: 'H1',
  candles: [
    { complete: true, volume: 5123, time: '1794153600.000000000', mid: { o: '4065.820', h: '4071.610', l: '4061.110', c: '4070.630' }, bid: { o: '4065.6', h: '4071.4', l: '4060.9', c: '4070.4' } },
    { complete: false, volume: 812, time: '1794157200.000000000', mid: { o: '4070.630', h: '4072.000', l: '4069.000', c: '4071.500' } },
  ],
};

describe('OANDA provider', () => {
  it('parse nến: thời gian UNIX, giá theo loại (mid/bid), volume = tick volume', () => {
    expect(parseOandaCandles(sample, 'M')).toEqual([
      { time: 1794153600, open: 4065.82, high: 4071.61, low: 4061.11, close: 4070.63, volume: 5123 },
      { time: 1794157200, open: 4070.63, high: 4072, low: 4069, close: 4071.5, volume: 812 },
    ]);
    // Nến không có thành phần giá được yêu cầu thì bỏ.
    expect(parseOandaCandles(sample, 'B')).toHaveLength(1);
  });

  it('query: granularity, căn nến New York 17:00, to = endTime + 1', () => {
    const q = buildOandaCandleQuery('4h', 500, 'M', 1794153600);
    expect(Object.fromEntries(q)).toEqual({
      granularity: 'H4', price: 'M', count: '500', dailyAlignment: '17', alignmentTimezone: 'America/New_York', weeklyAlignment: 'Sunday', to: '1794153601',
    });
    expect(buildOandaCandleQuery('1w', 10, 'B').get('granularity')).toBe('W');
    expect(buildOandaCandleQuery('1m', 10, 'B').has('to')).toBe(false);
  });

  it('gọi API với token + Accept-Datetime-Format: UNIX; thiếu token → lỗi rõ ràng; HTTP lỗi → ném lỗi', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(sample), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OandaProvider({ token: 'tkn', env: 'practice', price: 'M', fetchImpl: fakeFetch });
    const candles = await p.fetchKlines({ symbol: 'XAUUSD', tf: '1h', limit: 2 });
    expect(candles).toHaveLength(2);
    expect(calls[0]!.url).toMatch(/^https:\/\/api-fxpractice\.oanda\.com\/v3\/instruments\/XAU_USD\/candles\?granularity=H1/);
    expect(calls[0]!.headers).toEqual({ Authorization: 'Bearer tkn', 'Accept-Datetime-Format': 'UNIX' });

    await expect(new OandaProvider({ env: 'practice', price: 'M' }).fetchKlines({ symbol: 'XAUUSD', tf: '1h', limit: 2 })).rejects.toThrow(/OANDA_API_TOKEN/);
    const bad = new OandaProvider({ token: 't', env: 'live', price: 'M', fetchImpl: (async () => new Response('{"errorMessage":"Insufficient authorization"}', { status: 401 })) as unknown as typeof fetch });
    await expect(bad.fetchKlines({ symbol: 'XAUUSD', tf: '1h', limit: 2 })).rejects.toThrow(/OANDA 401/);
  });
});

describe('định tuyến symbol & instrument', () => {
  const tag = (name: string): MarketDataProvider => ({ name, maxLimit: 1500, fetchKlines: async () => [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }].map(c => ({ ...c, volume: name === 'oanda' ? 2 : 1 })) });

  it('XAUUSD → OANDA, còn lại → Binance; không có OANDA thì mọi symbol → Binance; Tiingo+OKX ưu tiên', async () => {
    const r = new RoutingProvider({ binance: tag('binance'), oanda: tag('oanda'), oandaSymbols: ['XAUUSD'] });
    expect(r.sourceOf('XAUUSD')).toBe('oanda');
    expect(r.sourceOf('BTCUSDT')).toBe('binance-futures');
    expect((await r.fetchKlines({ symbol: 'XAUUSD', tf: '1h', limit: 1 }))[0]!.volume).toBe(2);
    expect((await r.fetchKlines({ symbol: 'XAUUSDT', tf: '1h', limit: 1 }))[0]!.volume).toBe(1);
    expect(new RoutingProvider({ binance: tag('binance'), oanda: null, oandaSymbols: ['XAUUSD'] }).sourceOf('XAUUSD')).toBe('binance-futures');
    const both = new RoutingProvider({ binance: tag('binance'), oanda: tag('oanda'), tiingoOkx: tag('t'), oandaSymbols: ['XAUUSD'], tiingoOkxSymbols: ['XAUUSD'] });
    expect(both.sourceOf('XAUUSD')).toBe('tiingo-okx');
    expect(both.instrument('XAUUSD')).toMatchObject({ volumeType: 'proxy', sourceLabel: 'giá Tiingo · volume OKX perp', live: 'server-sse' });
  });

  it('instrument: tên hiển thị, nguồn, tick volume, realtime qua SSE', () => {
    expect(describeInstrument('XAUUSD', 'oanda', 'M')).toMatchObject({ displayName: 'XAUUSD · Vàng', sourceLabel: 'OANDA (giá mid)', assetClass: 'commodity', volumeType: 'tick', live: 'server-sse' });
    expect(describeInstrument('BTCUSDT', 'binance-futures')).toMatchObject({ volumeType: 'contract', live: 'binance-ws' });
    expect(oandaInstrument('XAUUSD')).toBe('XAU_USD');
  });

  it('normalizeSymbol: XAU_USD → XAUUSD, GOLD → XAUUSD', () => {
    expect(normalizeSymbol('xau_usd')).toBe('XAUUSD');
    expect(normalizeSymbol('gold')).toBe('XAUUSD');
    expect(normalizeSymbol('btcusdt')).toBe('BTCUSDT');
  });
});

describe('LivePoller', () => {
  const c = (time: number, close: number): Candle => ({ time, open: 1, high: 2, low: 0.5, close, volume: 1 });

  it('phát nến đang chạy khi đổi, nến trước là closed khi sang nến mới, dừng khi hết người xem', async () => {
    const seq: Candle[][] = [[c(0, 1), c(60, 1)], [c(0, 1), c(60, 1)], [c(0, 1), c(60, 1.5)], [c(60, 1.6), c(120, 1.7)]];
    let i = 0;
    const provider: MarketDataProvider = { name: 'fake', maxLimit: 10, fetchKlines: async (_p: FetchKlinesParams) => seq[Math.min(i++, seq.length - 1)]! };
    const poller = new LivePoller(provider, 1_000_000);
    const events: LiveEvent[] = [];
    const unsub = poller.subscribe('XAUUSD', '1m', e => events.push(e));
    await new Promise(r => setTimeout(r, 0)); // poll đầu tiên khi subscribe
    const feed = (poller as unknown as { feeds: Map<string, Parameters<LivePoller['poll']>[2]> }).feeds.get('XAUUSD:1m')!;
    for (let k = 0; k < 3; k++) await poller.poll('XAUUSD', '1m', feed);
    expect(events).toEqual([
      { candle: c(60, 1), closed: false },
      { candle: c(60, 1.5), closed: false },
      { candle: c(60, 1.6), closed: true },
      { candle: c(120, 1.7), closed: false },
    ]);
    expect(poller.activeFeeds).toBe(1);
    unsub();
    expect(poller.activeFeeds).toBe(0);
  });

  it('lỗi provider → phát sự kiện error', async () => {
    const poller = new LivePoller({ name: 'x', maxLimit: 1, fetchKlines: async () => { throw new Error('OANDA 401'); } }, 1_000_000);
    const events: LiveEvent[] = [];
    const unsub = poller.subscribe('XAUUSD', '1h', e => events.push(e));
    await new Promise(r => setTimeout(r, 0));
    expect(events).toEqual([{ error: 'OANDA 401' }]);
    unsub();
  });
});
