import { describe, expect, it } from 'vitest';
import { bucketFloor, cleanPrice, priceDecimals, roundPrice } from '@wca/shared';
import { LocalBook, sampleBook, type BookSample } from '../apps/server/src/orderflow/localBook.ts';
import { buildSnapshot, findAbsorption, medianBasis, profileBucket, type SpotCandle } from '../apps/server/src/orderflow/calc.ts';
import { formatOrderflowForAgent } from '../apps/server/src/orderflow/format.ts';
import { fmtSize } from '../apps/web/src/overlays/model.ts';

// Giá nhỏ (SUI ~0,77, XRP ~0,98, GRAM ~1,09, NEAR ~3,3): không được làm tròn 2 chữ số kiểu BTC.

describe('helper làm tròn giá theo độ lớn', () => {
  it('số chữ số thập phân theo cỡ giá', () => {
    expect(priceDecimals(67_000)).toBe(2);
    expect(priceDecimals(4_000)).toBe(2);
    expect(priceDecimals(75)).toBe(4);
    expect(priceDecimals(3.3)).toBe(5);
    expect(priceDecimals(0.77)).toBe(6);
    expect(priceDecimals(0)).toBe(2);
  });

  it('roundPrice giữ đủ chữ số cho giá < 1, BTC vẫn 2 chữ số', () => {
    expect(roundPrice(0.7712345678)).toBe(0.771235);
    expect(roundPrice(73_008.456)).toBe(73_008.46);
    // Hiệu giá: làm tròn theo giá tham chiếu, không theo chính hiệu (gần 0).
    expect(roundPrice(0.77123 - 0.77031, 0.77)).toBe(0.00092);
    expect(roundPrice(33.4567, 73_000)).toBe(33.46);
  });

  it('bucketFloor không lệch do sai số dấu phẩy động', () => {
    expect(bucketFloor(0.7702, 0.0002)).toBe(0.7702);
    expect(bucketFloor(0.77039, 0.0002)).toBe(0.7702);
    expect(bucketFloor(1.0905, 0.001)).toBe(1.09);
    expect(bucketFloor(73_005, 10)).toBe(73_000);
    expect(cleanPrice(0.7702 + 0.0002)).toBe(0.7704);
    expect(profileBucket(0.05, 0.0002)).toBe(0.0008);
  });
});

describe('order flow server với giá < 1', () => {
  it('sampleBook giữ bucket 0,0002 (không gộp về 0,77)', () => {
    const b = new LocalBook();
    b.applySnapshot({
      lastUpdateId: 1,
      bids: [['0.7701', '1000'], ['0.7700', '2000'], ['0.7698', '5000']],
      asks: [['0.7703', '1500'], ['0.7705', '4000']],
    });
    const s = sampleBook(b, 0.0002, 1000)!;
    expect(s.mid).toBe(0.7702);
    expect(s.bids).toEqual([[0.7698, 5000], [0.77, 3000]]);
    expect(s.asks).toEqual([[0.7702, 1500], [0.7704, 4000]]);
  });

  it('sampleBook với rangePct chỉ lấy mức trong ±N% quanh mid', () => {
    const b = new LocalBook();
    b.applySnapshot({
      lastUpdateId: 1,
      bids: [['0.7700', '1000'], ['0.7500', '9000'], ['0.6000', '50000']],
      asks: [['0.7704', '1500'], ['0.7900', '8000'], ['0.9000', '70000']],
    });
    const s = sampleBook(b, 0.0002, 1000, 3)!;
    expect(s.bids).toEqual([[0.75, 9000], [0.77, 1000]]);
    expect(s.asks).toEqual([[0.7704, 1500], [0.79, 8000]]);
    expect(sampleBook(b, 0.0002, 1000)!.bids).toHaveLength(3);
  });

  it('hấp thụ gom theo bucket nhỏ', () => {
    const trades = [
      { t: 1000, price: 0.77031, qty: 150_000, side: 'SELL' as const },
      { t: 1010, price: 0.77039, qty: 150_000, side: 'SELL' as const },
    ];
    const cs: SpotCandle[] = Array.from({ length: 20 }, (_, i) => ({
      time: 960 + i * 60, open: 0.7701, high: 0.7712, low: 0.7701, close: 0.7712, volume: 1, takerBuy: 0.5,
    }));
    expect(findAbsorption(trades, cs, { bucket: 0.0002, now: 960 + 20 * 60, minQty: 240_000 })).toEqual([
      { price: 0.7702, aggressor: 'SELL', qty: 300_000, trades: 2, lastAt: 1010 },
    ]);
  });

  it('basis giá nhỏ: làm tròn theo giá tham chiếu', () => {
    const m = new Map<number, number>();
    for (let i = 0; i < 20; i++) m.set(i * 60, 0.00031);
    expect(medianBasis(m, 19 * 60)).toBe(0); // mặc định cỡ BTC
    expect(medianBasis(m, 19 * 60, 60, 0.77)).toBe(0.00031);
  });

  it('snapshot + tóm tắt get_orderflow hiện đủ chữ số thập phân', () => {
    const n = 361;
    const samples: BookSample[] = Array.from({ length: n }, (_, i) => ({
      t: 1_000_000 + i * 10,
      mid: 0.7702,
      bids: [[0.769, 1000], [0.7692, 1000], [0.7694, 1000], [0.7696, 1000], [0.7684, 250_000]],
      asks: [[0.771, 1000], [0.7712, 1000], [0.7714, 1000], [0.7716, 1000], [0.7726, 300_000]],
    }));
    const candles: SpotCandle[] = Array.from({ length: 300 }, (_, i) => ({
      time: 1_000_000 - 18_000 + i * 60, open: 0.7695, high: 0.7712, low: 0.7695, close: 0.7712, volume: 50_000, takerBuy: 25_000,
    }));
    const snap = buildSnapshot({
      symbol: 'SUIUSDT', venue: 'Binance Futures SUIUSDT perp', unit: 'SUI', now: samples.at(-1)!.t, bucket: 0.0002, samples, candles,
      trades: [{ t: samples.at(-1)!.t - 60, price: 0.77013, qty: 60_000, side: 'BUY' }], appPrice: 0.77019, absorptionMinQty: 240_000, offset: 0.0001,
    });
    const bid = snap.levels.find(l => l.kind === 'BID_WALL')!;
    const ask = snap.levels.find(l => l.kind === 'ASK_WALL')!;
    expect(bid).toMatchObject({ sourcePrice: 0.7684, price: 0.7683, size: 250_000 });
    expect(ask).toMatchObject({ sourcePrice: 0.7726, price: 0.7725, size: 300_000 });
    expect(bid.note).toContain('giá nguồn 0.7684–0.7686');
    const poc = snap.levels.find(l => l.kind === 'POC')!;
    expect(String(poc.price)).toMatch(/^0\.77?\d{2,}/);
    expect(poc.price).toBeGreaterThanOrEqual(0.7694);
    expect(poc.price).toBeLessThan(0.7713);
    const text = formatOrderflowForAgent(snap);
    expect(text).toContain('Tường mua 0.7683');
    expect(text).toContain('chênh lệch thực tế 0.00001');
    expect(text).toContain('@ 0.77003');
    expect(text).not.toMatch(/@ 0\.77\b(?!\d)/);
  });
});

describe('nhãn khối lượng tường trên chart', () => {
  it('rút gọn K/M cho altcoin, BTC giữ nguyên', () => {
    expect(fmtSize(12.345)).toBe('12.35');
    expect(fmtSize(9_999)).toBe('9999');
    expect(fmtSize(250_000)).toBe('250K');
    expect(fmtSize(1_234_567)).toBe('1.23M');
  });
});
