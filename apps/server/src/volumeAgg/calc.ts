import { PERP_VENUES, VOLUME_VENUES, type Timeframe, type VolumeAggBar, type VolumeSpike, type VolumeVenue } from '@wca/shared';
import { tfSeconds } from '@wca/shared';

// Logic thuần cho volume gộp: mốc nến, gộp theo sàn, tìm đột biến (test trong tests/volumeAgg.test.ts).

const WEEK = 7 * 86400;
/** Nến tuần của các sàn mở thứ Hai 00:00 UTC; epoch (1970-01-01) là thứ Năm → lệch 4 ngày. */
const WEEK_OFFSET = 4 * 86400;

/** Thời gian mở nến chứa `t` (unix giây). */
export function barOpen(t: number, tf: Timeframe): number {
  if (tf === '1w') return Math.floor((t - WEEK_OFFSET) / WEEK) * WEEK + WEEK_OFFSET;
  const s = tfSeconds(tf);
  return Math.floor(t / s) * s;
}

/** `limit` mốc nến ĐÃ ĐÓNG gần nhất tới `now` (tăng dần). */
export function closedBarTimes(now: number, tf: Timeframe, limit: number): number[] {
  const step = tf === '1w' ? WEEK : tfSeconds(tf);
  const lastClosed = barOpen(now, tf) - step;
  const out: number[] = [];
  for (let i = limit - 1; i >= 0; i--) out.push(lastClosed - i * step);
  return out;
}

const r = (x: number) => Math.round(x * 1000) / 1000;

/** Gộp volume từng sàn (Map thời gian → volume) theo các mốc `times`. */
export function mergeBars(times: readonly number[], byVenue: Partial<Record<VolumeVenue, ReadonlyMap<number, number>>>): VolumeAggBar[] {
  return times.map(time => {
    const venues = Object.fromEntries(VOLUME_VENUES.map(v => [v, byVenue[v]?.get(time) ?? null])) as Record<VolumeVenue, number | null>;
    const perpVals = PERP_VENUES.map(v => venues[v]);
    return {
      time,
      perp: r(perpVals.reduce<number>((s, x) => s + (x ?? 0), 0)),
      spot: venues.binanceSpot === null ? null : r(venues.binanceSpot),
      venues,
      perpComplete: perpVals.every(x => x !== null),
    };
  });
}

export interface SpikeOptions {
  /** Ngưỡng × trung vị. */
  x: number;
  window?: number;
  /** Số nến hợp lệ tối thiểu trong cửa sổ. */
  minBars?: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Đột biến theo nhóm: volume > x × trung vị `window` nến trước (chỉ nến hợp lệ của nhóm: perp đủ 3 sàn, spot có dữ liệu).
 * Nến thiếu dữ liệu của nhóm → nhóm đó không tính (không báo sai).
 */
export function findSpikes(bars: readonly VolumeAggBar[], o: SpikeOptions): VolumeSpike[] {
  const window = o.window ?? 20;
  const minBars = o.minBars ?? 15;
  const ratio = (i: number, val: (b: VolumeAggBar) => number | null): number | null => {
    const v = val(bars[i]!);
    if (v === null) return null;
    const prev: number[] = [];
    for (let k = i - 1; k >= 0 && k >= i - window; k--) {
      const p = val(bars[k]!);
      if (p !== null && p > 0) prev.push(p);
    }
    if (prev.length < minBars) return null;
    const m = median(prev);
    return m > 0 ? Math.round((v / m) * 10) / 10 : null;
  };
  const out: VolumeSpike[] = [];
  for (let i = 0; i < bars.length; i++) {
    const perpX = ratio(i, b => (b.perpComplete ? b.perp : null));
    const spotX = ratio(i, b => b.spot);
    const p = perpX !== null && perpX > o.x;
    const s = spotX !== null && spotX > o.x;
    if (!p && !s) continue;
    out.push({ time: bars[i]!.time, kind: p && s ? 'BOTH' : s ? 'SPOT' : 'PERP', perpX, spotX });
  }
  return out;
}
