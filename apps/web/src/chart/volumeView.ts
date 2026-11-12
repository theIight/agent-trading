import {
  spikeRatios,
  VOLUME_SOURCE_SPIKE_TEXT,
  volumeSourceValue,
  type Candle,
  type VolumeAggBar,
  type VolumeSource,
  type VolumeSpikeKind,
} from '@wca/shared';
import type { SpikeLabel } from './SpikeLabelPrimitive.ts';

// Cột volume theo nguồn đã chọn (pure, test trong tests/volumeView.test.ts).

export interface VolumeColors {
  up: string;
  down: string;
  upSolid: string;
  downSolid: string;
}

/** Cột histogram; thiếu `value` = khoảng trống (whitespace). */
export interface VolumeColumn {
  time: number;
  value?: number;
  color?: string;
}

export interface VolumeView {
  main: VolumeColumn[];
  /** Cột perp + spot vẽ sau cột chính (chỉ chế độ gộp). */
  spot: VolumeColumn[];
  labels: SpikeLabel[];
  /** Nến cuối (đang chạy) không có volume của nguồn đã chọn. */
  runningMissing: boolean;
}

export const SPIKE_COLORS: Record<VolumeSpikeKind, string> = { BOTH: '#ff6d00', SPOT: '#ff9800', PERP: '#9598a1' };
export const SPIKE_TEXT: Record<VolumeSpikeKind, string> = { BOTH: 'S+P', SPOT: 'S', PERP: 'P' };
export const SOURCE_SPIKE_COLOR = '#ff9800';

export function buildVolumeView(
  candles: readonly Candle[],
  agg: ReadonlyMap<number, VolumeAggBar> | null,
  source: VolumeSource,
  spikeX: number,
  colors: VolumeColors,
): VolumeView {
  const upOf = (c: Candle) => c.close >= c.open;
  if (!agg || source === 'futures') {
    return { main: candles.map(c => ({ time: c.time, value: c.volume, color: upOf(c) ? colors.up : colors.down })), spot: [], labels: [], runningMissing: false };
  }
  if (source === 'stacked') {
    const main = candles.map((c, i): VolumeColumn => {
      const a = agg.get(c.time);
      // Màu đặc khi có cột spot phía sau (màu trong suốt sẽ lộ màu cam).
      if (a) return { time: c.time, value: a.perp, color: upOf(c) ? colors.upSolid : colors.downSolid };
      // Nến đang chạy giữ volume Binance Futures; nến đã đóng ngoài vùng có dữ liệu để trống (không trộn thang).
      return i === candles.length - 1 ? { time: c.time, value: c.volume, color: upOf(c) ? colors.up : colors.down } : { time: c.time };
    });
    const spot: VolumeColumn[] = [];
    for (const c of candles) {
      const a = agg.get(c.time);
      if (a && a.spot !== null) spot.push({ time: c.time, value: a.perp + a.spot });
    }
    const perpX = spikeRatios(candles.map(c => (agg.get(c.time)?.perpComplete ? agg.get(c.time)!.perp : null)));
    const spotX = spikeRatios(candles.map(c => agg.get(c.time)?.spot ?? null));
    const labels: SpikeLabel[] = [];
    candles.forEach((c, i) => {
      const p = (perpX[i] ?? 0) > spikeX;
      const s = (spotX[i] ?? 0) > spikeX;
      const a = agg.get(c.time);
      if (!a || a.spot === null || (!p && !s)) return;
      const kind: VolumeSpikeKind = p && s ? 'BOTH' : s ? 'SPOT' : 'PERP';
      labels.push({ time: c.time, value: a.perp + a.spot, text: SPIKE_TEXT[kind], color: SPIKE_COLORS[kind] });
    });
    return { main, spot, labels, runningMissing: false };
  }
  const values = candles.map(c => {
    const a = agg.get(c.time);
    return a ? volumeSourceValue(a, source) : null;
  });
  const main = candles.map((c, i) => (values[i] === null ? { time: c.time } : { time: c.time, value: values[i]!, color: upOf(c) ? colors.up : colors.down }));
  const ratios = spikeRatios(values);
  const labels: SpikeLabel[] = [];
  candles.forEach((c, i) => {
    if (values[i] !== null && (ratios[i] ?? 0) > spikeX) labels.push({ time: c.time, value: values[i]!, text: VOLUME_SOURCE_SPIKE_TEXT[source], color: SOURCE_SPIKE_COLOR });
  });
  return { main, spot: [], labels, runningMissing: candles.length > 0 && values.at(-1) === null };
}

/**
 * Mốc bắt đầu có volume nhiều sàn khi chart có nhiều nến đã đóng hơn phần đã tải (null = phủ đủ).
 * `chartBars` gồm cả nến đang chạy.
 */
export function aggCoverageFrom(chartBars: number, aggBars: readonly VolumeAggBar[]): number | null {
  if (!aggBars.length || chartBars - 1 <= aggBars.length) return null;
  return aggBars[0]!.time;
}
