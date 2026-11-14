import { describe, expect, it } from 'vitest';
import type { BookHeatmap } from '@wca/shared';
import { bookHeatColor, heatScale, intensityOf, lastClosedCol, mergeHeatmap } from '../apps/web/src/overlays/bookHeatmapModel.ts';

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
});
