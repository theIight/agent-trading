import type { Candle, Timeframe } from '@wca/shared';
import { atr, detectStructureBreaks, detectTrend, findSwings, priorVolumeSma, type Trend } from './structure.ts';
import { findClimaxBars, findRangeCandidates, round, type ClimaxBar, type RangeCandidate } from './wyckoffHints.ts';

export * from './structure.ts';
export * from './wyckoffHints.ts';

export interface FeatureSet {
  tf: Timeframe;
  bars: number;
  from: number;
  to: number;
  lastClose: number;
  atr14: number;
  volumeSma20: number;
  trend: Trend;
  structureState: 'UP' | 'DOWN' | null;
  extremes: { high: number; highIndex: number; low: number; lowIndex: number };
  swings: { i: number; time: number; type: 'HIGH' | 'LOW'; price: number; label: string | null }[];
  breaks: { i: number; time: number; type: 'BOS' | 'CHOCH'; direction: 'UP' | 'DOWN'; level: number }[];
  climaxBars: ClimaxBar[];
  rangeCandidates: RangeCandidate[];
}

export interface FeatureOptions {
  maxSwings?: number;
  maxBreaks?: number;
  maxClimax?: number;
}

/**
 * Tính đặc trưng cho agent. Mọi chỉ số `i`/`index` khớp với cột `i` của CSV `get_klines`
 * khi dùng cùng mảng nến (cùng symbol/tf/limit).
 */
export function computeFeatures(candles: readonly Candle[], tf: Timeframe, opts: FeatureOptions = {}): FeatureSet {
  if (!candles.length) throw new Error('Không có dữ liệu nến');
  const swings = findSwings(candles, 2, 2);
  const { breaks, state } = detectStructureBreaks(candles, swings);
  const climaxBars = findClimaxBars(candles);
  const rangeCandidates = findRangeCandidates(candles, swings, climaxBars);
  const volSma = priorVolumeSma(candles, 20);

  let highIndex = 0;
  let lowIndex = 0;
  candles.forEach((c, i) => {
    if (c.high > candles[highIndex]!.high) highIndex = i;
    if (c.low < candles[lowIndex]!.low) lowIndex = i;
  });
  const last = candles[candles.length - 1]!;
  const priceDigits = last.close >= 1000 ? 1 : last.close >= 1 ? 4 : 8;

  return {
    tf,
    bars: candles.length,
    from: candles[0]!.time,
    to: last.time,
    lastClose: last.close,
    atr14: round(atr(candles, 14), priceDigits),
    volumeSma20: round(volSma[volSma.length - 1] ?? 0, 3),
    trend: detectTrend(swings),
    structureState: state,
    extremes: { high: candles[highIndex]!.high, highIndex, low: candles[lowIndex]!.low, lowIndex },
    swings: swings.slice(-(opts.maxSwings ?? 40)).map(s => ({ i: s.index, time: s.time, type: s.type, price: s.price, label: s.label })),
    breaks: breaks.slice(-(opts.maxBreaks ?? 15)).map(b => ({ i: b.index, time: b.time, type: b.type, direction: b.direction, level: b.level })),
    climaxBars: climaxBars.slice(-(opts.maxClimax ?? 20)),
    rangeCandidates,
  };
}
