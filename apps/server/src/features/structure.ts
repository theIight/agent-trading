import type { Candle } from '@wca/shared';

// Market structure theo Dow Theory — port từ pumping-token-detect/src/indicators/marketStructure.js.
// Pure function trên nến đã đóng. Phá vỡ cấu trúc chỉ xác nhận bằng GIÁ ĐÓNG CỬA.

export type SwingType = 'HIGH' | 'LOW';
export type SwingLabel = 'HH' | 'LH' | 'EH' | 'HL' | 'LL' | 'EL' | null;
export type Trend = 'UP' | 'DOWN' | 'RANGE';

export interface Swing {
  index: number;
  type: SwingType;
  price: number;
  time: number;
  /** Nến mà tại đó swing được xác nhận (đủ `right` nến bên phải). */
  confirmedIndex: number;
  label: SwingLabel;
}

export interface StructureBreak {
  type: 'BOS' | 'CHOCH';
  direction: 'UP' | 'DOWN';
  index: number;
  time: number;
  level: number;
  brokenSwingIndex: number;
}

/**
 * Swing fractal: cao (thấp) hơn hẳn `left` nến bên trái và không thấp (cao) hơn `right` nến bên phải.
 * Chỉ tồn tại khi đủ `right` nến bên phải nên không repaint.
 */
export function findSwings(candles: readonly Candle[], left = 2, right = 2): Swing[] {
  const swings: Swing[] = [];
  for (let i = left; i <= candles.length - 1 - right; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= left; k++) {
      const p = candles[i - k]!;
      if (!(c.high > p.high)) isHigh = false;
      if (!(c.low < p.low)) isLow = false;
    }
    for (let k = 1; k <= right; k++) {
      const n = candles[i + k]!;
      if (!(c.high >= n.high)) isHigh = false;
      if (!(c.low <= n.low)) isLow = false;
    }
    if (isHigh) swings.push({ index: i, type: 'HIGH', price: c.high, time: c.time, confirmedIndex: i + right, label: null });
    if (isLow) swings.push({ index: i, type: 'LOW', price: c.low, time: c.time, confirmedIndex: i + right, label: null });
  }
  return labelStructure(swings);
}

/** Gán nhãn HH/LH/EH cho swing high và HL/LL/EL cho swing low so với swing cùng loại trước đó. */
export function labelStructure(swings: readonly Swing[]): Swing[] {
  let prevHigh: Swing | null = null;
  let prevLow: Swing | null = null;
  return swings.map(s => {
    let label: SwingLabel = null;
    if (s.type === 'HIGH') {
      if (prevHigh) label = s.price > prevHigh.price ? 'HH' : s.price < prevHigh.price ? 'LH' : 'EH';
      prevHigh = s;
    } else {
      if (prevLow) label = s.price > prevLow.price ? 'HL' : s.price < prevLow.price ? 'LL' : 'EL';
      prevLow = s;
    }
    return { ...s, label };
  });
}

/** HH + HL = UP, LH + LL = DOWN, còn lại RANGE (theo swing high/low có nhãn gần nhất). */
export function detectTrend(swings: readonly Swing[]): Trend {
  const highs = swings.filter(s => s.type === 'HIGH' && s.label);
  const lows = swings.filter(s => s.type === 'LOW' && s.label);
  const lastHigh = highs.at(-1)?.label;
  const lastLow = lows.at(-1)?.label;
  if (lastHigh === 'HH' && lastLow === 'HL') return 'UP';
  if (lastHigh === 'LH' && lastLow === 'LL') return 'DOWN';
  return 'RANGE';
}

/**
 * Quét từng nến, ghi nhận phá vỡ bằng giá đóng cửa so với swing đã xác nhận gần nhất chưa bị phá:
 * BOS khi cùng chiều xu hướng hiện tại (hoặc chưa rõ), CHoCH khi ngược chiều. Mỗi swing chỉ bị phá một lần.
 */
export function detectStructureBreaks(
  candles: readonly Candle[],
  swings: readonly Swing[],
): { breaks: StructureBreak[]; state: 'UP' | 'DOWN' | null } {
  const breaks: StructureBreak[] = [];
  let state: 'UP' | 'DOWN' | null = null;
  const broken = new Set<Swing>();
  for (let i = 1; i < candles.length; i++) {
    let refHigh: Swing | null = null;
    let refLow: Swing | null = null;
    for (const s of swings) {
      if (s.confirmedIndex > i - 1 || broken.has(s)) continue;
      if (s.type === 'HIGH') refHigh = s;
      else refLow = s;
    }
    const c = candles[i]!;
    if (refHigh && c.close > refHigh.price) {
      breaks.push({ type: state === 'DOWN' ? 'CHOCH' : 'BOS', direction: 'UP', index: i, time: c.time, level: refHigh.price, brokenSwingIndex: refHigh.index });
      broken.add(refHigh);
      state = 'UP';
    } else if (refLow && c.close < refLow.price) {
      breaks.push({ type: state === 'UP' ? 'CHOCH' : 'BOS', direction: 'DOWN', index: i, time: c.time, level: refLow.price, brokenSwingIndex: refLow.index });
      broken.add(refLow);
      state = 'DOWN';
    }
  }
  return { breaks, state };
}

function trueRange(candles: readonly Candle[], i: number): number {
  const c = candles[i]!;
  const prevClose = candles[i - 1]!.close;
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

/** ATR (trung bình đơn giản của True Range) tính tới nến cuối. */
export function atr(candles: readonly Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - period);
  let sum = 0;
  for (let i = start; i < candles.length; i++) sum += trueRange(candles, i);
  return sum / (candles.length - start);
}

/** ATR tại từng nến (SMA của TR `period` nến kết thúc tại nến đó); 0 khi chưa đủ dữ liệu. */
export function atrSeries(candles: readonly Candle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(0);
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    sum += trueRange(candles, i);
    if (i > period) sum -= trueRange(candles, i - period);
    if (i >= period) out[i] = sum / period;
  }
  return out;
}

/**
 * SMA volume của `period` nến TRƯỚC nến i (không gồm nến i); 0 khi chưa đủ dữ liệu.
 * Nến `volume <= 0` = không có dữ liệu volume (vd XAUUSD trước khi có volume OKX) → bỏ qua;
 * cần ít nhất nửa cửa sổ có volume.
 */
export function priorVolumeSma(candles: readonly Candle[], period = 20): number[] {
  const out = new Array<number>(candles.length).fill(0);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i >= period && count >= Math.ceil(period / 2)) out[i] = sum / count;
    const v = candles[i]!.volume;
    if (v > 0) {
      sum += v;
      count++;
    }
    if (i >= period) {
      const old = candles[i - period]!.volume;
      if (old > 0) {
        sum -= old;
        count--;
      }
    }
  }
  return out;
}
