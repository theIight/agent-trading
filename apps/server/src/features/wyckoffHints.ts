import type { Candle } from '@wca/shared';
import { atrSeries, priorVolumeSma, type Swing } from './structure.ts';

// Gợi ý Wyckoff mang tính cơ học (KHÔNG phải kết luận): nến climax và ứng viên Trading Range.
// Agent dùng để định hướng, rồi tự đánh giá trên dữ liệu nến.

export interface ClimaxBar {
  index: number;
  time: number;
  direction: 'UP' | 'DOWN';
  /** volume / SMA20 volume của 20 nến trước. */
  volRatio: number;
  /** (high - low) / ATR14. */
  spreadAtr: number;
  /** Vị trí giá đóng trong thân nến: 0 = đóng ở đáy, 1 = đóng ở đỉnh. */
  closePosition: number;
  high: number;
  low: number;
  close: number;
  /** Là cực trị (đáy thấp nhất / đỉnh cao nhất) trong cửa sổ xung quanh. */
  isExtreme: boolean;
}

export interface RangeCandidate {
  kind: 'AFTER_SC' | 'AFTER_BC';
  climaxIndex: number;
  climaxTime: number;
  arIndex: number;
  arTime: number;
  top: number;
  bottom: number;
  startTime: number;
  endIndex: number;
  endTime: number;
  bars: number;
  status: 'ACTIVE' | 'BROKEN_UP' | 'BROKEN_DOWN';
  /** Số nến có râu/đóng vượt biên dưới (ứng viên Spring) / biên trên (ứng viên UT/UTAD) nhưng đóng lại trong range. */
  probesBelow: number[];
  probesAbove: number[];
  /** TB volume trong range / TB volume 20 nến trước climax. < 1 là volume cạn dần. */
  volumeDryUpRatio: number | null;
}

export interface HintOptions {
  climaxVolRatio?: number;
  climaxAltVolRatio?: number;
  climaxAltSpreadAtr?: number;
  extremeLookback?: number;
  arMaxBars?: number;
  minRangeBars?: number;
  breakToleranceRatio?: number;
}

const DEFAULTS: Required<HintOptions> = {
  climaxVolRatio: 2.0,
  climaxAltVolRatio: 1.5,
  climaxAltSpreadAtr: 1.5,
  extremeLookback: 20,
  arMaxBars: 30,
  minRangeBars: 8,
  breakToleranceRatio: 0.15,
};

export function findClimaxBars(candles: readonly Candle[], opts: HintOptions = {}): ClimaxBar[] {
  const o = { ...DEFAULTS, ...opts };
  const volSma = priorVolumeSma(candles, 20);
  const atrs = atrSeries(candles, 14);
  const out: ClimaxBar[] = [];
  for (let i = 20; i < candles.length; i++) {
    const c = candles[i]!;
    const avg = volSma[i]!;
    const a = atrs[i]!;
    if (!(avg > 0) || !(a > 0) || !(c.volume > 0)) continue;
    const volRatio = c.volume / avg;
    const spread = c.high - c.low;
    const spreadAtr = spread / a;
    const qualifies = volRatio >= o.climaxVolRatio || (volRatio >= o.climaxAltVolRatio && spreadAtr >= o.climaxAltSpreadAtr);
    if (!qualifies) continue;
    const direction = c.close >= c.open ? 'UP' : 'DOWN';
    const from = Math.max(0, i - o.extremeLookback);
    const to = Math.min(candles.length - 1, i + 5);
    let isExtreme = true;
    for (let k = from; k <= to; k++) {
      if (k === i) continue;
      const other = candles[k]!;
      if (direction === 'DOWN' ? other.low < c.low : other.high > c.high) {
        isExtreme = false;
        break;
      }
    }
    out.push({
      index: i,
      time: c.time,
      direction,
      volRatio: round(volRatio, 2),
      spreadAtr: round(spreadAtr, 2),
      closePosition: spread > 0 ? round((c.close - c.low) / spread, 2) : 0.5,
      high: c.high,
      low: c.low,
      close: c.close,
      isExtreme,
    });
  }
  return out;
}

export function findRangeCandidates(
  candles: readonly Candle[],
  swings: readonly Swing[],
  climaxes: readonly ClimaxBar[],
  opts: HintOptions = {},
): RangeCandidate[] {
  const o = { ...DEFAULTS, ...opts };
  const out: RangeCandidate[] = [];
  const last = candles.length - 1;

  for (const cx of climaxes) {
    if (!cx.isExtreme) continue;
    const isSc = cx.direction === 'DOWN';
    const ar = swings.find(s => s.type === (isSc ? 'HIGH' : 'LOW') && s.index > cx.index && s.index <= cx.index + o.arMaxBars);
    if (!ar) continue;
    const top = isSc ? ar.price : cx.high;
    const bottom = isSc ? cx.low : ar.price;
    const height = top - bottom;
    if (!(height > 0)) continue;
    const tol = height * o.breakToleranceRatio;

    let status: RangeCandidate['status'] = 'ACTIVE';
    let endIndex = last;
    const probesBelow: number[] = [];
    const probesAbove: number[] = [];
    for (let i = ar.index + 1; i <= last; i++) {
      const c = candles[i]!;
      if (c.close > top + tol) {
        status = 'BROKEN_UP';
        endIndex = i;
        break;
      }
      if (c.close < bottom - tol) {
        status = 'BROKEN_DOWN';
        endIndex = i;
        break;
      }
      if (c.low < bottom) probesBelow.push(i);
      if (c.high > top) probesAbove.push(i);
    }
    const bars = endIndex - cx.index;
    if (bars < o.minRangeBars) continue;

    const before = candles.slice(Math.max(0, cx.index - 20), cx.index);
    const inside = candles.slice(ar.index + 1, endIndex + 1);
    // Bỏ nến không có dữ liệu volume.
    const volsBefore = before.map(c => c.volume).filter(v => v > 0);
    const volsInside = inside.map(c => c.volume).filter(v => v > 0);
    const avgBefore = mean(volsBefore);
    const avgInside = mean(volsInside);

    out.push({
      kind: isSc ? 'AFTER_SC' : 'AFTER_BC',
      climaxIndex: cx.index,
      climaxTime: cx.time,
      arIndex: ar.index,
      arTime: ar.time,
      top,
      bottom,
      startTime: cx.time,
      endIndex,
      endTime: candles[endIndex]!.time,
      bars,
      status,
      probesBelow: probesBelow.slice(-10),
      probesAbove: probesAbove.slice(-10),
      volumeDryUpRatio: avgBefore > 0 && volsInside.length ? round(avgInside / avgBefore, 2) : null,
    });
  }

  // Loại các ứng viên chồng lấn: giữ ứng viên có climax volume lớn hơn.
  const byRatio = new Map(climaxes.map(c => [c.index, c.volRatio]));
  const kept: RangeCandidate[] = [];
  for (const cand of [...out].sort((a, b) => (byRatio.get(b.climaxIndex) ?? 0) - (byRatio.get(a.climaxIndex) ?? 0))) {
    const overlaps = kept.some(k => cand.climaxIndex <= k.endIndex && k.climaxIndex <= cand.endIndex);
    if (!overlaps) kept.push(cand);
  }
  return kept.sort((a, b) => a.climaxIndex - b.climaxIndex);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
