import { describe, expect, it } from 'vitest';
import type { BookHeatmap } from '@wca/shared';
import { DEFAULT_DISPLAY, DISPLAY_RANGES, bookHeatMinQtyOf, sanitizeDisplay, withBookHeatMinQty } from '../apps/web/src/chart/displaySettings.ts';
import { bookHeatColor, heatScale, heatStats, intensityOf, lastClosedCol, mergeHeatmap } from '../apps/web/src/overlays/bookHeatmapModel.ts';

const H = (cols: number[], over: Partial<BookHeatmap> = {}): BookHeatmap => ({
  symbol: 'BTCUSDT',
  colSec: 60,
  bucket: 10,
  cols,
  shift: cols.map(() => 30),
  data: cols.map(t => [1, t]),
  unit: 'BTC',
  partialLast: true,
  asOf: (cols.at(-1) ?? 0) + 30,
  ...over,
});

describe('heatmap sổ lệnh (web)', () => {
  it('lastClosedCol bỏ cột đang chạy', () => {
    expect(lastClosedCol(null)).toBeUndefined();
    expect(lastClosedCol(H([60, 120, 180]))).toBe(120);
    expect(lastClosedCol(H([60, 120], { partialLast: false }))).toBe(120);
  });

  it('ghép: thay cột đang chạy cũ, không trùng cột', () => {
    const prev = H([60, 120, 180]);
    const next = H([180, 240], { data: [[1, 999], [1, 240]] });
    const m = mergeHeatmap(prev, next);
    expect(m.cols).toEqual([60, 120, 180, 240]);
    expect(m.data[2]).toEqual([1, 999]);
    expect(m.partialLast).toBe(true);
  });

  it('ghép: poll không có cột mới → giữ nguyên', () => {
    const prev = H([60, 120]);
    const m = mergeHeatmap(prev, H([], { asOf: 150 }));
    expect(m.cols).toEqual([60, 120]);
    expect(m.partialLast).toBe(true);
  });

  it('ghép: khác khung / symbol → thay hẳn; cắt ngoài 24 giờ', () => {
    expect(mergeHeatmap(H([60, 120]), H([900], { colSec: 900 })).cols).toEqual([900]);
    expect(mergeHeatmap(H([60, 120]), H([180], { symbol: 'XAUUSD' })).cols).toEqual([180]);
    const day = 86400;
    expect(mergeHeatmap(H([60, 120], { partialLast: false }), H([day + 120, day + 180], { asOf: day + 100 })).cols).toEqual([120, day + 120, day + 180]);
  });

  it('thang theo thứ hạng phân vị + ẩn ô nhỏ; cường độ kẹp 1–255', () => {
    const h = H([0], { data: [Array.from({ length: 101 }, (_, i) => [i, i + 1]).flat()] });
    const s = heatScale(h, 20);
    expect(s.steps).toHaveLength(101);
    expect(s.min).toBe(21);
    expect(heatScale(h, 0).min).toBe(0);
    expect(intensityOf(0, s)).toBe(1);
    expect(intensityOf(101, s)).toBe(255);
    expect(intensityOf(1e9, s)).toBe(255);
    expect(intensityOf(51, s)).toBe(32); // hạng 0.5 → 255 × 0.125
    expect(intensityOf(91, s)).toBe(186); // hạng 0.9 → 255 × 0.729
    expect(intensityOf(5, { steps: [], min: 0 })).toBe(1);
    expect(bookHeatColor(255, 2)).toMatch(/,1\.000\)$/);
  });

  it('thang theo vùng nhìn thấy: chỉ xét cột và dải giá trong view', () => {
    // 2 cột; cột 0: ô giá 0–10 (qty 1) và 100–110 (qty 1000); cột 1: ô 100–110 (qty 5). shift = 0.
    const h = H([0, 60], { shift: [0, 0], data: [[0, 1, 10, 1000], [10, 5]] });
    expect(heatScale(h, 0).steps.at(-1)).toBe(1000);
    expect(heatScale(h, 0, { c0: 0, c1: 0, low: 0, high: 50 }).steps).toEqual(Array(101).fill(1));
    expect(heatScale(h, 0, { c0: 1, c1: 1, low: 0, high: 200 }).steps.at(-1)).toBe(5);
    expect(heatScale(h, 0, { c0: 0, c1: 1, low: 300, high: 400 }).steps).toEqual([]);
  });

  it('ngưỡng tuyệt đối: ẩn ô < minQty, min = max(tuyệt đối, phân vị), thang chỉ trên ô còn lại', () => {
    // 100 ô qty 1..100.
    const h = H([0], { data: [Array.from({ length: 100 }, (_, i) => [i, i + 1]).flat()] });
    const s = heatScale(h, 0, undefined, 51);
    expect(s.min).toBe(51);
    expect(s.steps[0]).toBe(51); // thang bắt đầu từ ô nhỏ nhất còn hiển thị
    expect(s.steps.at(-1)).toBe(100);
    expect(intensityOf(51, s)).toBe(1);
    expect(intensityOf(100, s)).toBe(255);
    // Phân vị tính trên 50 ô còn lại (51..100): p50 ≈ 76 > 51 → dùng phân vị.
    expect(heatScale(h, 50, undefined, 51).min).toBe(76);
    // Không lọc phân vị → ngưỡng tuyệt đối; phân vị tính trên ô còn lại (95..100) nên luôn ≥ ngưỡng tuyệt đối.
    expect(heatScale(h, 0, undefined, 95).min).toBe(95);
    expect(heatScale(h, 20, undefined, 95).min).toBe(96);
    // Ngưỡng vượt mọi ô → thang rỗng, ẩn hết.
    const none = heatScale(h, 0, undefined, 1000);
    expect(none.steps).toEqual([]);
    expect(none.min).toBe(1000);
    // 0 / âm / NaN = tắt.
    expect(heatScale(h, 0, undefined, 0)).toEqual(heatScale(h, 0));
    expect(heatScale(h, 0, undefined, -5)).toEqual(heatScale(h, 0));
    expect(heatScale(h, 0, undefined, Number.NaN)).toEqual(heatScale(h, 0));
  });

  it('heatStats: p50/p90/p99 trong vùng nhìn thấy', () => {
    const h = H([0], { shift: [0], data: [Array.from({ length: 101 }, (_, i) => [i, i]).flat()] });
    expect(heatStats(h)).toEqual({ p50: 50, p90: 90, p99: 99, n: 101 });
    // Chỉ dải giá 0–100 (ô ix 0..10, low + 10 ≥ 0 và low ≤ 100).
    expect(heatStats(h, { c0: 0, c1: 0, low: 0, high: 100 })).toMatchObject({ p50: 5, n: 11 });
    expect(heatStats(h, { c0: 0, c1: 0, low: 5000, high: 6000 })).toBeNull();
    expect(heatStats(H([]))).toBeNull();
  });
});

describe('cài đặt heatmap sổ lệnh', () => {
  it('bookHeatMinQty: chỉ giữ symbol hợp lệ, giá trị hữu hạn > 0', () => {
    expect(DEFAULT_DISPLAY.bookHeatMinQty).toEqual({});
    expect(sanitizeDisplay({}).bookHeatMinQty).toEqual({});
    expect(sanitizeDisplay({ bookHeatMinQty: [5] }).bookHeatMinQty).toEqual({});
    expect(sanitizeDisplay({ bookHeatMinQty: 'x' }).bookHeatMinQty).toEqual({});
    expect(
      sanitizeDisplay({
        bookHeatMinQty: { BTCUSDT: 5, XAUUSD: 120.5, ETHUSDT: -1, SOLUSDT: 0, bad: 3, 'BTC/USDT': 2, DOGEUSDT: '7', BNBUSDT: Number.POSITIVE_INFINITY },
      }).bookHeatMinQty,
    ).toEqual({ BTCUSDT: 5, XAUUSD: 120.5 });
  });

  it('bookHeatMinQty theo từng symbol; đặt 0 / NaN = xoá', () => {
    const s = sanitizeDisplay({ bookHeatMinQty: { BTCUSDT: 5, XAUUSD: 100 } });
    expect(bookHeatMinQtyOf(s, 'BTCUSDT')).toBe(5);
    expect(bookHeatMinQtyOf(s, 'XAUUSD')).toBe(100);
    expect(bookHeatMinQtyOf(s, 'ETHUSDT')).toBe(0);
    expect(withBookHeatMinQty(s.bookHeatMinQty, 'ETHUSDT', 20)).toEqual({ BTCUSDT: 5, XAUUSD: 100, ETHUSDT: 20 });
    expect(withBookHeatMinQty(s.bookHeatMinQty, 'BTCUSDT', 0)).toEqual({ XAUUSD: 100 });
    expect(withBookHeatMinQty(s.bookHeatMinQty, 'BTCUSDT', Number.NaN)).toEqual({ XAUUSD: 100 });
    expect(s.bookHeatMinQty).toEqual({ BTCUSDT: 5, XAUUSD: 100 }); // không sửa map cũ
  });

  it('bookHeatHidePct kẹp 0–95, bước 5', () => {
    expect(DISPLAY_RANGES.bookHeatHidePct.max).toBe(95);
    expect(sanitizeDisplay({ bookHeatHidePct: 99 }).bookHeatHidePct).toBe(95);
    expect(sanitizeDisplay({ bookHeatHidePct: 80 }).bookHeatHidePct).toBe(80);
    expect(sanitizeDisplay({ bookHeatHidePct: -3 }).bookHeatHidePct).toBe(0);
    expect(sanitizeDisplay({ bookHeatHidePct: 62 }).bookHeatHidePct).toBe(60);
  });
});
