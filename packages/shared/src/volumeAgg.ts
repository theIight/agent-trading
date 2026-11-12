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
