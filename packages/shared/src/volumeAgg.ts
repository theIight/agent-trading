// Volume gộp nhiều sàn (chỉ nến đã đóng): perp = Binance Futures + OKX + Bybit, spot = Binance spot (hiện riêng).

export const VOLUME_VENUES = ['binanceFut', 'okx', 'bybit', 'binanceSpot'] as const;
export type VolumeVenue = (typeof VOLUME_VENUES)[number];
export const PERP_VENUES: readonly VolumeVenue[] = ['binanceFut', 'okx', 'bybit'];

export const VOLUME_VENUE_LABELS: Record<VolumeVenue, string> = {
  binanceFut: 'Binance Futures',
  okx: 'OKX perp',
  bybit: 'Bybit perp',
  binanceSpot: 'Binance spot',
};

export interface VolumeAggBar {
  /** Unix giây mở nến. */
  time: number;
  /** Tổng perp (đồng gốc) của các sàn perp có dữ liệu. */
  perp: number;
  /** Binance spot; null = thiếu. */
  spot: number | null;
  /** Volume từng sàn; null = thiếu nến đó. */
  venues: Record<VolumeVenue, number | null>;
  /** Đủ cả 3 sàn perp. */
  perpComplete: boolean;
}

export type VolumeSpikeKind = 'BOTH' | 'SPOT' | 'PERP';

export interface VolumeSpike {
  time: number;
  kind: VolumeSpikeKind;
  /** Bội số so với trung vị 20 nến trước (null = nhóm đó không tính được). */
  perpX: number | null;
  spotX: number | null;
}

export interface VolumeAggResponse {
  symbol: string;
  tf: string;
  bars: VolumeAggBar[];
  spikes: VolumeSpike[];
  /** Ngưỡng đột biến (× trung vị). */
  spikeX: number;
  notes: string[];
}

// ---------- Nguồn volume hiển thị trên chart ----------

/** `futures` = volume nến chart (Binance Futures, như mặc định); `stacked` = perp 3 sàn + spot chồng; còn lại = một nguồn / tổng. */
export const VOLUME_SOURCES = ['futures', 'stacked', 'binanceSpot', 'okx', 'bybit', 'total'] as const;
export type VolumeSource = (typeof VOLUME_SOURCES)[number];

export const VOLUME_SOURCE_LABELS: Record<VolumeSource, string> = {
  futures: 'Binance Futures',
  stacked: 'Gộp perp + spot',
  binanceSpot: 'Binance spot',
  okx: 'OKX perp',
  bybit: 'Bybit perp',
  total: 'Tổng 4 sàn',
};

/** Nhãn ngắn của dấu đột biến theo nguồn đơn lẻ / tổng. */
export const VOLUME_SOURCE_SPIKE_TEXT: Record<Exclude<VolumeSource, 'futures' | 'stacked'>, string> = {
  binanceSpot: 'SP',
  okx: 'OKX',
  bybit: 'BB',
  total: 'Σ',
};

export function isVolumeSource(v: unknown): v is VolumeSource {
  return typeof v === 'string' && (VOLUME_SOURCES as readonly string[]).includes(v);
}

/** Volume của nến theo nguồn đơn lẻ / tổng; null = thiếu dữ liệu (tổng cần đủ 4 sàn). */
export function volumeSourceValue(bar: VolumeAggBar, source: Exclude<VolumeSource, 'futures' | 'stacked'>): number | null {
  if (source === 'total') {
    const vals = VOLUME_VENUES.map(v => bar.venues[v]);
    return vals.every(x => x !== null) ? vals.reduce<number>((s, x) => s + x!, 0) : null;
  }
  return bar.venues[source];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Bội số volume / trung vị `window` giá trị hợp lệ (> 0) ngay trước, làm tròn 0,1; null khi thiếu dữ liệu
 * hoặc chưa đủ `minBars` giá trị trước. Lõi chung cho đột biến volume (server + chart).
 */
export function spikeRatios(values: readonly (number | null)[], window = 20, minBars = 15): (number | null)[] {
  return values.map((v, i) => {
    if (v === null) return null;
    const prev: number[] = [];
    for (let k = i - 1; k >= 0 && k >= i - window; k--) {
      const p = values[k];
      if (p !== null && p !== undefined && p > 0) prev.push(p);
    }
    if (prev.length < minBars) return null;
    const m = median(prev);
    return m > 0 ? Math.round((v / m) * 10) / 10 : null;
  });
}
