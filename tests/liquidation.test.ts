import { describe, expect, it } from 'vitest';
import { openDb } from '../apps/server/src/db/index.ts';
import {
  bubbleMinQty,
  bucketLiquidations,
  buildHeatmap,
  liqPrice,
  parseBinanceForceOrder,
  parseLeverage,
  parseOkxLiquidations,
  stepLevels,
  topZones,
  type LiqLevels,
  type ModelCandle,
} from '../apps/server/src/liquidation/model.ts';
import { LiquidationCollector } from '../apps/server/src/liquidation/collector.ts';
import { LiquidationService } from '../apps/server/src/liquidation/service.ts';

const opts = { bucket: 50, tiers: [{ lev: 10, weight: 1 }], mmr: 0 };
const candle = (time: number, high: number, low: number, close: number, takerBuy = 5, volume = 10): ModelCandle => ({ time, high, low, close, volume, takerBuy });

describe('mô hình mức thanh lý', () => {
  it('parseLeverage chuẩn hoá trọng số; sai cú pháp → mặc định', () => {
    expect(parseLeverage('10:1,20:3')).toEqual([
      { lev: 10, weight: 0.25 },
      { lev: 20, weight: 0.75 },
    ]);
    expect(parseLeverage('abc')).toHaveLength(4);
    expect(liqPrice(70000, 10, 0.004, 'LONG')).toBeCloseTo(63280);
    expect(liqPrice(70000, 10, 0.004, 'SHORT')).toBeCloseTo(76720);
  });

  it('ΔOI dương tạo mức long/short theo tỷ lệ mua chủ động; ΔOI âm giảm theo tỷ lệ; giá chạm thì xoá', () => {
    const lv: LiqLevels = { long: new Map(), short: new Map() };
    // giá điển hình 70000, mua chủ động 70% → long 70, short 30
    stepLevels(lv, candle(0, 70000, 70000, 70000, 7, 10), 1000, 1100, opts);
    expect([...lv.long.keys()]).toEqual([63000]);
    expect([...lv.short.keys()]).toEqual([77000]);
    expect(lv.long.get(63000)).toBeCloseTo(70);
    expect(lv.short.get(77000)).toBeCloseTo(30);
    stepLevels(lv, candle(300, 70100, 69900, 70000), 1100, 550, opts); // OI giảm một nửa
    expect(lv.long.get(63000)).toBeCloseTo(35);
    expect(lv.short.get(77000)).toBeCloseTo(15);
    stepLevels(lv, candle(600, 70000, 63020, 63500), 550, 550, opts); // low chạm bucket 63000–63050
    expect(lv.long.size).toBe(0);
    expect(lv.short.size).toBe(1);
  });

  it('heatmap: chụp trạng thái cuối mỗi cột, mức bị quét biến mất ở cột sau; bỏ ô nhỏ', () => {
    const oi = [0, 300, 600, 900, 1200].map((t, i) => ({ t, oi: [1000, 1100, 1100, 1100, 1101][i]! }));
    const candles = [candle(0, 70000, 70000, 70000), candle(300, 70000, 69000, 69500), candle(600, 69000, 62900, 63000), candle(900, 64000, 63000, 63500)];
    const { heatmap } = buildHeatmap(oi, candles, { ...opts, colSec: 600, maxCols: 10, minRatio: 0.05 });
    expect(heatmap!.cols).toEqual([0, 600]);
    expect(heatmap!.priceMin).toBe(63000);
    // cột 0: long 63000 (50) + short 77000 (50); cột 600: long đã bị quét, còn short; ô ΔOI=1 (< 5%) bị bỏ
    const decode = (flat: number[]) => {
      const out: [number, number][] = [];
      for (let i = 0; i < flat.length; i += 2) out.push([heatmap!.priceMin + flat[i]! * heatmap!.bucket, flat[i + 1]!]);
      return out;
    };
    expect(decode(heatmap!.data[0]!)).toEqual([
      [63000, 255],
      [77000, 255],
    ]);
    expect(decode(heatmap!.data[1]!)).toEqual([[77000, 255]]);
    expect(heatmap!.maxQty).toBe(50);
  });

  it('heatmap: thang theo phân vị (kẹp 255), bỏ ô dưới phân vị giữ', () => {
    // 10 bước, mỗi bước thêm long+short ở giá khác nhau → ô 10..100
    const oi = Array.from({ length: 11 }, (_, i) => ({ t: i * 300, oi: 1000 + (i * (i + 1)) / 2 * 20 }));
    const candles = oi.map((p, i) => candle(p.t, 70000 + i * 1000, 70000 + i * 1000, 70000 + i * 1000));
    const { heatmap } = buildHeatmap(oi, candles, { ...opts, colSec: 3000, maxCols: 1, minRatio: 0, keepQuantile: 0.5, scaleQuantile: 0.8 });
    const vals = heatmap!.data[0]!.filter((_, i) => i % 2 === 1);
    expect(vals.length).toBeLessThanOrEqual(11);
    expect(Math.max(...vals)).toBe(255);
    expect(vals.filter(v => v === 255).length).toBeGreaterThan(1); // các ô trên phân vị 80 bị kẹp
  });

  it('heatmap chỉ giữ maxCols cột cuối', () => {
    const oi = Array.from({ length: 20 }, (_, i) => ({ t: i * 300, oi: 1000 + i }));
    const candles = oi.map(p => candle(p.t, 70000, 70000, 70000));
    const { heatmap } = buildHeatmap(oi, candles, { ...opts, colSec: 300, maxCols: 5, minRatio: 0 });
    expect(heatmap!.cols).toEqual([14, 15, 16, 17, 18].map(i => i * 300));
  });

  it('topZones: vùng dày nhất mỗi phía, không chồng nhau', () => {
    const lv: LiqLevels = {
      long: new Map([
        [69000, 10],
        [69050, 10],
        [68000, 5],
        [60000, 1],
      ]),
      short: new Map([[71000, 7]]),
    };
    expect(topZones(lv, 70000, 50, 2, 2)).toEqual([
      { side: 'SHORT', low: 71000, high: 71100, qty: 7 },
      { side: 'LONG', low: 69000, high: 69100, qty: 20 },
      { side: 'LONG', low: 68000, high: 68100, qty: 5 },
    ]);
  });
});

describe('thanh lý thật', () => {
  it('parse Binance forceOrder (SELL = long bị thanh lý)', () => {
    const msg = { e: 'forceOrder', o: { s: 'BTCUSDT', S: 'SELL', q: '0.5', p: '70000', ap: '70010', z: '0.5', T: 1_000_500 } };
    expect(parseBinanceForceOrder(msg, 'BTCUSDT')).toEqual({ venue: 'binance', ts: 1_000_500, side: 'LONG', price: 70010, qty: 0.5 });
    expect(parseBinanceForceOrder({ o: { ...msg.o, s: 'ETHUSDT' } }, 'BTCUSDT')).toBeNull();
  });

  it('parse OKX liquidation-orders: hợp đồng × ctVal, posSide hoặc side (net)', () => {
    const msg = {
      arg: { channel: 'liquidation-orders' },
      data: [
        { instId: 'BTC-USDT-SWAP', details: [{ bkPx: '70000', posSide: 'short', side: 'buy', sz: '150', ts: '1000000' }, { bkPx: '69000', posSide: 'net', side: 'sell', sz: '20', ts: '1000001' }] },
        { instId: 'ETH-USDT-SWAP', details: [{ bkPx: '3000', posSide: 'long', side: 'sell', sz: '5', ts: '1000000' }] },
      ],
    };
    expect(parseOkxLiquidations(msg, 'BTC-USDT-SWAP', 0.01)).toEqual([
      { venue: 'okx', ts: 1_000_000, side: 'SHORT', price: 70000, qty: 1.5 },
      { venue: 'okx', ts: 1_000_001, side: 'LONG', price: 69000, qty: 0.2 },
    ]);
  });

  it('gộp theo nến + phía, VWAP, lọc ngưỡng; ngưỡng theo √phút', () => {
    const rows = [
      { t: 60, venue: 'binance' as const, side: 'LONG' as const, price: 100, qty: 1 },
      { t: 90, venue: 'okx' as const, side: 'LONG' as const, price: 110, qty: 1 },
      { t: 100, venue: 'okx' as const, side: 'SHORT' as const, price: 120, qty: 0.1 },
    ];
    expect(bucketLiquidations(rows, 60, 0.5)).toEqual([{ t: 60, side: 'LONG', price: 105, qty: 2, venues: ['binance', 'okx'] }]);
    expect(bubbleMinQty(0.5, 60)).toBe(0.5);
    expect(bubbleMinQty(0.5, 3600)).toBeCloseTo(0.5 * Math.sqrt(60));
  });

  it('collector gộp theo giây/sàn/phía và ghi DB', () => {
    const db = openDb(':memory:');
    const col = new LiquidationCollector({ symbol: 'BTCUSDT', okxInst: { instId: 'BTC-USDT-SWAP', ctVal: 0.01 }, retainH: 72, db });
    col.handleMessage('binance', { o: { s: 'BTCUSDT', S: 'SELL', ap: '70000', z: '1', T: 5_000_100 } });
    col.handleMessage('binance', { o: { s: 'BTCUSDT', S: 'SELL', ap: '70100', z: '1', T: 5_000_900 } });
    col.handleMessage('okx', { data: [{ instId: 'BTC-USDT-SWAP', details: [{ bkPx: '70200', posSide: 'long', side: 'sell', sz: '100', ts: '5000500' }] }] });
    col.flush(5000); // giây 5000 chưa chốt
    expect(col.rows(0, 9999)).toEqual([]);
    col.flush(5001);
    expect(col.rows(0, 9999)).toEqual([
      { t: 5000, venue: 'binance', side: 'LONG', price: 70050, qty: 2 },
      { t: 5000, venue: 'okx', side: 'LONG', price: 70200, qty: 1 },
    ]);
  });
});

describe('LiquidationService', () => {
  it('tải OI (phân trang có startTime+endTime), tính heatmap, tóm tắt cho agent', async () => {
    const db = openDb(':memory:');
    const now = 1_794_000_000;
    const T0 = now - 3 * 86400;
    const oiCalls: string[] = [];
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('openInterestHist')) {
        oiCalls.push(url);
        const s = Number(u.searchParams.get('startTime')) / 1000;
        const e = Number(u.searchParams.get('endTime')) / 1000;
        const rows = [];
        for (let t = Math.ceil(s / 300) * 300; t <= e && t < now; t += 300) {
          rows.push({ timestamp: t * 1000, sumOpenInterest: String(t < T0 + 3600 ? 1000 + (t - T0) / 30 : 1120) });
        }
        return new Response(JSON.stringify(rows));
      }
      const s = Number(u.searchParams.get('startTime')) / 1000;
      const rows = [];
      for (let t = s; t < now && rows.length < 1500; t += 300) rows.push([t * 1000, '70000', '70100', '69900', '70000', '10', 0, '0', 1, '5']);
      return new Response(JSON.stringify(rows));
    }) as typeof fetch;
    const col = new LiquidationCollector({ symbol: 'BTCUSDT', retainH: 72, db, now: () => now });
    col.handleMessage('binance', { o: { s: 'BTCUSDT', S: 'BUY', ap: '70500', z: '5', T: (now - 600) * 1000 } });
    col.flush();
    const svc = new LiquidationService({
      db,
      collectors: { BTCUSDT: col },
      buckets: { BTCUSDT: 50 },
      minQty: { BTCUSDT: 0.5 },
      tiers: [{ lev: 25, weight: 1 }],
      mmr: 0,
      retainH: 72,
      fetchImpl,
      now: () => now,
    });
    expect(await svc.syncOi('BTCUSDT')).toBeGreaterThan(8000);
    expect(oiCalls.every(u => u.includes('startTime') && u.includes('endTime'))).toBe(true);
    oiCalls.length = 0;
    await svc.syncOi('BTCUSDT'); // lần sau chỉ phần mới
    expect(oiCalls.length).toBeLessThanOrEqual(1);
    const live = await svc.live('BTCUSDT', 3600);
    expect(live.events).toEqual([{ t: Math.floor((now - 600) / 3600) * 3600, side: 'SHORT', price: 70500, qty: 5, venues: ['binance'] }]);
    expect(live.heatmap!.colSec).toBe(3600);
    const again = await svc.live('BTCUSDT', 3600, live.heatmap!.asOf);
    expect(again).toMatchObject({ heatmap: null, heatmapUnchanged: true });
    // long 25x ≈ 70000 × 0.96 = 67200, short ≈ 72800
    const prices = live.heatmap!.data.at(-1)!.filter((_, i) => i % 2 === 0).map(ix => live.heatmap!.priceMin + ix * 50);
    expect(prices).toEqual([67200, 72800]);
    const text = await svc.summaryText('BTCUSDT', 70000);
    expect(text).toContain('short bị thanh lý 5');
    expect(text).toMatch(/Trên giá — short bị thanh lý 72800–72950: ~\d+ BTC/);
    expect(text).toMatch(/Dưới giá — long bị thanh lý 67200–67350/);
  });
});

describe('lớp thanh lý trên chart (web)', () => {
  it('bán kính bong bóng, màu heatmap, giải mã ô', async () => {
    const { bubbleRadius, heatColor, decodeHeatmap, BUBBLE_MIN_R, BUBBLE_MAX_R } = await import('../apps/web/src/overlays/liquidationModel.ts');
    expect(bubbleRadius(10, 10)).toBe(BUBBLE_MAX_R);
    expect(bubbleRadius(0, 10)).toBe(BUBBLE_MIN_R);
    expect(bubbleRadius(2.5, 10)).toBeCloseTo(BUBBLE_MIN_R + (BUBBLE_MAX_R - BUBBLE_MIN_R) * 0.5);
    expect(heatColor(0)).toBe('rgba(68,1,84,0.080)');
    expect(heatColor(255)).toBe('rgba(253,231,37,0.450)');
    expect(decodeHeatmap({ colSec: 300, bucket: 50, priceMin: 70000, cols: [0, 300], data: [[0, 10, 2, 255], []], maxQty: 5, asOf: 600 })).toEqual([
      { t1: 0, t2: 300, low: 70000, high: 70050, intensity: 10 },
      { t1: 0, t2: 300, low: 70100, high: 70150, intensity: 255 },
    ]);
  });
});

describe('validator gắn tóm tắt thanh lý', () => {
  it('orderflow.liquidation lấy từ snapshot server', async () => {
    const { validateBinanceOrderflow } = await import('../apps/server/src/validate/orderflow.ts');
    const snapshot = { levels: [], offset: 33, asOf: 1, historyMin: 60, liquidation: 'Thanh lý thật 24h …' } as never;
    const { orderflow } = validateBinanceOrderflow({ summary: 'ok', cvd: '', levels: [], lastPrices: [] }, { snapshot, cvdText: '' });
    expect(orderflow.liquidation).toBe('Thanh lý thật 24h …');
  });
});
