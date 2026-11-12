import type { LiquidationEvent, LiquidationHeatmap } from '@wca/shared';

// Logic thuần cho lớp thanh lý: kích thước bong bóng, màu heatmap, giải mã ô.

export const BUBBLE_MIN_R = 3;
export const BUBBLE_MAX_R = 18;

/** Bán kính theo căn bậc hai khối lượng so với cụm lớn nhất (3–18 px). */
export function bubbleRadius(qty: number, maxQty: number): number {
  if (!(maxQty > 0) || !(qty > 0)) return BUBBLE_MIN_R;
  return BUBBLE_MIN_R + (BUBBLE_MAX_R - BUBBLE_MIN_R) * Math.sqrt(Math.min(1, qty / maxQty));
}

/** Long bị thanh lý = đỏ, short bị thanh lý = xanh. */
export function bubbleColor(side: LiquidationEvent['side'], alpha = 0.55): string {
  return side === 'LONG' ? `rgba(239,83,80,${alpha})` : `rgba(38,166,154,${alpha})`;
}

/** Thang tím → xanh ngọc → vàng (kiểu heatmap), độ đậm tăng theo cường độ 1–255; `opacity` nhân độ đậm (kẹp ≤ 1). */
export function heatColor(intensity: number, opacity = 1): string {
  const x = Math.max(0, Math.min(1, intensity / 255));
  const stops: [number, [number, number, number]][] = [
    [0, [68, 1, 84]],
    [0.5, [33, 145, 140]],
    [1, [253, 231, 37]],
  ];
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1]![0]) i++;
  const [x0, c0] = stops[i]!;
  const [x1, c1] = stops[i + 1]!;
  const k = (x - x0) / (x1 - x0);
  const ch = (j: number) => Math.round(c0[j]! + (c1[j]! - c0[j]!) * k);
  const alpha = Math.min(1, (0.08 + 0.37 * x) * opacity);
  return `rgba(${ch(0)},${ch(1)},${ch(2)},${alpha.toFixed(3)})`;
}

export interface HeatCell {
  t1: number;
  t2: number;
  low: number;
  high: number;
  intensity: number;
}

/** Giải mã lưới heatmap thành ô (thời gian, giá). */
export function decodeHeatmap(h: LiquidationHeatmap): HeatCell[] {
  const out: HeatCell[] = [];
  h.cols.forEach((t, ci) => {
    const flat = h.data[ci] ?? [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const low = h.priceMin + flat[i]! * h.bucket;
      out.push({ t1: t, t2: t + h.colSec, low, high: low + h.bucket, intensity: flat[i + 1]! });
    }
  });
  return out;
}
