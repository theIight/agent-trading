import { BOOK_HEATMAP_HOURS, type BookHeatmap } from '@wca/shared';

// Logic thuần cho heatmap sổ lệnh: ghép dữ liệu tăng dần, thang màu theo phân vị, bảng màu kiểu Bookmap.

/** Mở cột ĐÃ ĐÓNG cuối cùng (gửi làm `after` khi poll); chưa có → undefined. */
export function lastClosedCol(h: BookHeatmap | null): number | undefined {
  if (!h || !h.cols.length) return undefined;
  return h.partialLast ? h.cols.at(-2) : h.cols.at(-1);
}

/**
 * Ghép bản mới vào bản cũ: khác symbol / độ dài cột → thay hẳn; cùng → giữ cột cũ trước cột mới đầu tiên
 * (cột đang chạy cũ bị thay), cắt cột ngoài 24 giờ tính từ `next.asOf`.
 */
export function mergeHeatmap(prev: BookHeatmap | null, next: BookHeatmap): BookHeatmap {
  const from = next.asOf - BOOK_HEATMAP_HOURS * 3600;
  const same = prev && prev.symbol === next.symbol && prev.colSec === next.colSec && prev.bucket === next.bucket;
  const firstNew = next.cols[0] ?? Number.POSITIVE_INFINITY;
  const keep: number[] = [];
  if (same) {
    prev.cols.forEach((t, i) => {
      // Không có cột mới: bỏ cột đang chạy cũ chỉ khi nó đã được thay; giữ nguyên nếu server chưa gửi gì.
      if (t < firstNew && t >= from && !(i === prev.cols.length - 1 && prev.partialLast && next.cols.length)) keep.push(i);
    });
  }
  const nextKeep = next.cols.map((t, i) => i).filter(i => next.cols[i]! >= from);
  const p = same ? prev : null;
  return {
    ...next,
    cols: [...keep.map(i => p!.cols[i]!), ...nextKeep.map(i => next.cols[i]!)],
    shift: [...keep.map(i => p!.shift[i]!), ...nextKeep.map(i => next.shift[i]!)],
    data: [...keep.map(i => p!.data[i]!), ...nextKeep.map(i => next.data[i]!)],
    partialLast: next.cols.length ? next.partialLast : Boolean(p?.partialLast),
  };
}

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

/** Số mốc phân vị của thang (0–100 %). */
const SCALE_STEPS = 100;

export interface HeatScale {
  /** Mốc khối lượng tại phân vị 0, 1, …, 100 %. */
  steps: number[];
  /** Ô < mức này bị ẩn (phân vị `hidePct`). */
  min: number;
}

/** Vùng đang nhìn thấy: cột [c0, c1] (chỉ số) và giá chart [low, high]. */
export interface HeatView {
  c0: number;
  c1: number;
  low: number;
  high: number;
}

/** Khối lượng các ô (tăng dần); có `view` → chỉ ô trong vùng đang nhìn thấy. */
function cellQtys(h: BookHeatmap, view?: HeatView): number[] {
  const qs: number[] = [];
  const c0 = view ? Math.max(0, view.c0) : 0;
  const c1 = view ? Math.min(h.data.length - 1, view.c1) : h.data.length - 1;
  for (let ci = c0; ci <= c1; ci++) {
    const flat = h.data[ci] ?? [];
    const shift = h.shift[ci] ?? 0;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (view) {
        const low = flat[i]! * h.bucket - shift;
        if (low + h.bucket < view.low || low > view.high) continue;
      }
      qs.push(flat[i + 1]!);
    }
  }
  return qs.sort((a, b) => a - b);
}

/**
 * Thang màu theo phân vị khối lượng các ô (`hidePct` 0–100). Có `view` → chỉ xét ô trong vùng đang nhìn thấy
 * (tự chỉnh tương phản: zoom vào dải sổ lệnh dày vẫn phân biệt được mức dày/mỏng).
 * `minQty` > 0: bỏ ô < minQty TRƯỚC khi tính phân vị (thang màu chỉ trên ô còn hiển thị);
 * ngưỡng ẩn = max(minQty, phân vị `hidePct` của các ô còn lại).
 */
export function heatScale(h: BookHeatmap, hidePct: number, view?: HeatView, minQty = 0): HeatScale {
  let qs = cellQtys(h, view);
  const floor = Number.isFinite(minQty) && minQty > 0 ? minQty : 0;
  if (floor > 0) qs = qs.filter(q => q >= floor);
  const steps = qs.length ? Array.from({ length: SCALE_STEPS + 1 }, (_, i) => quantile(qs, i / SCALE_STEPS)) : [];
  const pct = hidePct > 0 ? quantile(qs, hidePct / 100) : 0;
  return { steps, min: Math.max(floor, pct) };
}

export interface HeatStats {
  p50: number;
  p90: number;
  p99: number;
  /** Số ô đã xét. */
  n: number;
}

/** Trung vị · p90 · p99 khối lượng ô (trong `view` nếu có) — gợi ý chọn ngưỡng; không có ô → null. */
export function heatStats(h: BookHeatmap, view?: HeatView): HeatStats | null {
  const qs = cellQtys(h, view);
  if (!qs.length) return null;
  return { p50: quantile(qs, 0.5), p90: quantile(qs, 0.9), p99: quantile(qs, 0.99), n: qs.length };
}

/**
 * Cường độ 1–255 theo THỨ HẠNG phân vị của `qty` (lũy thừa 3): ~10 % ô dày nhất sáng vàng–trắng, phần lớn là nền xanh mờ.
 * Dùng thứ hạng thay vì tỷ lệ với ô lớn nhất vì phân bố mỗi symbol rất khác (BTC đuôi dài, sổ lệnh vàng dày đều).
 */
export function intensityOf(qty: number, scale: HeatScale): number {
  const { steps } = scale;
  if (!steps.length || !(qty > 0)) return 1;
  let lo = 0;
  let hi = steps.length - 1;
  // Mốc lớn nhất ≤ qty.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (steps[mid]! <= qty) lo = mid;
    else hi = mid - 1;
  }
  const rank = steps[0]! > qty ? 0 : lo / SCALE_STEPS;
  return Math.max(1, Math.min(255, Math.round(255 * rank ** 3)));
}

/** Thang xanh đậm → xanh ngọc → vàng → trắng (kiểu Bookmap); `opacity` nhân độ đậm (kẹp ≤ 1). */
export function bookHeatColor(intensity: number, opacity = 1): string {
  const x = Math.max(0, Math.min(1, intensity / 255));
  const stops: [number, [number, number, number]][] = [
    [0, [20, 40, 120]],
    [0.4, [0, 150, 210]],
    [0.75, [255, 200, 0]],
    [1, [255, 250, 225]],
  ];
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1]![0]) i++;
  const [x0, c0] = stops[i]!;
  const [x1, c1] = stops[i + 1]!;
  const k = (x - x0) / (x1 - x0);
  const ch = (j: number) => Math.round(c0[j]! + (c1[j]! - c0[j]!) * k);
  const alpha = Math.min(1, (0.1 + 0.55 * x) * opacity);
  return `rgba(${ch(0)},${ch(1)},${ch(2)},${alpha.toFixed(3)})`;
}

/** Dải thanh khoản: cùng bucket nguồn `ix` có ô hiển thị qua các cột liên tiếp (cho phép hụt `maxGap` cột). */
export interface HeatBand {
  ix: number;
  /** Chỉ số cột đầu / cuối của dải. */
  start: number;
  end: number;
  /** Khối lượng ô lớn nhất trong dải và cột chứa nó. */
  peak: number;
  peakCol: number;
  /** Giá chart tâm bucket tại cột đặt nhãn (= max(start, view.c0)). */
  price: number;
}

/**
 * Dải thanh khoản có phần nằm trong vùng nhìn (`view`), ô ≥ `min`, dài ≥ `minCols` cột, sắp theo `peak` giảm dần.
 * Quét từ cột 0 để biết dải bắt đầu trước vùng nhìn (nhãn khi đó đặt ở cột `view.c0`).
 */
export function heatBands(h: BookHeatmap, view: HeatView, min: number, minCols = 1, maxGap = 1): HeatBand[] {
  const open = new Map<number, { start: number; last: number; peak: number; peakCol: number }>();
  const done: { ix: number; start: number; end: number; peak: number; peakCol: number }[] = [];
  const close = (ix: number) => {
    const r = open.get(ix)!;
    done.push({ ix, start: r.start, end: r.last, peak: r.peak, peakCol: r.peakCol });
    open.delete(ix);
  };
  const c1 = Math.min(h.data.length - 1, view.c1);
  for (let ci = 0; ci <= c1; ci++) {
    const flat = h.data[ci] ?? [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const q = flat[i + 1]!;
      if (!(q >= min) || !(q > 0)) continue;
      const ix = flat[i]!;
      const r = open.get(ix);
      if (r) {
        r.last = ci;
        if (q > r.peak) {
          r.peak = q;
          r.peakCol = ci;
        }
      } else open.set(ix, { start: ci, last: ci, peak: q, peakCol: ci });
    }
    for (const [ix, r] of open) if (ci - r.last > maxGap) close(ix);
  }
  for (const ix of [...open.keys()]) close(ix);
  const out: HeatBand[] = [];
  for (const b of done) {
    if (b.end < view.c0 || b.end - b.start + 1 < minCols) continue;
    const col = Math.max(b.start, view.c0);
    const price = b.ix * h.bucket - (h.shift[col] ?? 0) + h.bucket / 2;
    if (price < view.low || price > view.high) continue;
    out.push({ ...b, price });
  }
  return out.sort((a, b) => b.peak - a.peak);
}

export interface LabelBox {
  /** Mép trái, tâm dọc, rộng, cao (px). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Chọn tham lam theo thứ tự `items` (ưu tiên giảm dần), tối đa `n` nhãn không chồng khung; trả chỉ số đã chọn. */
export function pickHeatLabels(items: readonly LabelBox[], n: number): number[] {
  const picked: number[] = [];
  for (let i = 0; i < items.length && picked.length < n; i++) {
    const a = items[i]!;
    const hit = picked.some(j => {
      const b = items[j]!;
      return a.x < b.x + b.w && b.x < a.x + a.w && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
    });
    if (!hit) picked.push(i);
  }
  return picked;
}
