import { cleanPrice } from '@wca/shared';
import type { BookSample } from './localBook.ts';

// Heatmap sổ lệnh: gom mẫu sổ lệnh (đã gom bucket) thành cột thời gian, mỗi ô = khối lượng lệnh chờ trung bình.

export interface HeatColumn {
  /** Unix giây mở cột. */
  t: number;
  /** Basis nguồn − chart của cột. */
  shift: number;
  /** Phẳng [ix, qty, ...], ix tăng dần. */
  data: number[];
}

export interface BuildHeatmapOptions {
  colSec: number;
  bucket: number;
  /** Basis tại thời điểm `t` (giây). */
  basisAt: (t: number) => number;
  /** Bỏ ô < tỷ lệ này × ô lớn nhất của cột (mặc định 0.1 %). */
  minFrac?: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Mở cột chứa `t`. */
export const colStart = (t: number, colSec: number) => Math.floor(t / colSec) * colSec;

/**
 * Gom `samples` (tăng dần theo t) thành cột: trung bình qty (bid + ask cộng chung) theo số mẫu trong cột;
 * bucket vắng trong một mẫu tính là 0. Cột không có mẫu thì không xuất hiện.
 * `shift` = basis tại cuối cột (cột đang chạy: tại thời điểm mẫu cuối).
 */
export function buildHeatColumns(samples: readonly BookSample[], o: BuildHeatmapOptions): HeatColumn[] {
  const { colSec, bucket, basisAt, minFrac = 0.001 } = o;
  if (!(colSec > 0) || !(bucket > 0)) return [];
  const out: HeatColumn[] = [];
  let cur: { t: number; n: number; lastT: number; sum: Map<number, number> } | null = null;
  const flush = () => {
    if (!cur || !cur.n) return;
    let max = 0;
    for (const q of cur.sum.values()) max = Math.max(max, q);
    const min = max * minFrac;
    const cells = [...cur.sum.entries()].filter(([, q]) => q > 0 && q >= min).sort((a, b) => a[0] - b[0]);
    const data: number[] = [];
    for (const [ix, q] of cells) {
      const avg = r3(q / cur.n);
      if (avg > 0) data.push(ix, avg);
    }
    out.push({ t: cur.t, shift: cleanPrice(basisAt(Math.min(cur.t + colSec, cur.lastT))), data });
  };
  for (const s of samples) {
    const t = colStart(s.t, colSec);
    if (!cur || cur.t !== t) {
      flush();
      cur = { t, n: 0, lastT: s.t, sum: new Map() };
    }
    cur.n++;
    cur.lastT = s.t;
    for (const side of [s.bids, s.asks]) {
      for (const [p, q] of side) {
        const ix = Math.round(p / bucket);
        cur.sum.set(ix, (cur.sum.get(ix) ?? 0) + q);
      }
    }
  }
  flush();
  return out;
}
