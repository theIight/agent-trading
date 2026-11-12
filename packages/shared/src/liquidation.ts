// Thanh lý: bong bóng thanh lý thật (Binance + OKX) và heatmap mức thanh lý ước tính (mô hình từ OI).

export const LIQ_VENUES = ['binance', 'okx'] as const;
export type LiqVenue = (typeof LIQ_VENUES)[number];

/** Phía vị thế BỊ thanh lý: LONG = long bị thanh lý (lệnh bán cưỡng bức). */
export type LiqSide = 'LONG' | 'SHORT';

/** Một cụm thanh lý (đã gộp theo giây, hoặc theo nến khi trả cho chart). */
export interface LiquidationEvent {
  /** Unix giây (cụm theo nến: thời gian mở nến). */
  t: number;
  side: LiqSide;
  /** Giá VWAP. */
  price: number;
  /** Khối lượng theo đồng gốc (BTC). */
  qty: number;
  /** Sàn có trong cụm. */
  venues: LiqVenue[];
}

/**
 * Heatmap mức thanh lý ước tính: lưới thời gian × giá.
 * `data[i]` = các ô của cột `cols[i]` dạng phẳng `[chỉ số giá, cường độ 1–255, ...]`; giá ô = `priceMin + chỉ số × bucket`.
 */
export interface LiquidationHeatmap {
  /** Độ dài mỗi cột (giây). */
  colSec: number;
  bucket: number;
  priceMin: number;
  /** Unix giây mở cột. */
  cols: number[];
  data: number[][];
  /** Khối lượng (BTC) ứng với cường độ 255. */
  maxQty: number;
  /** Thời điểm OI cuối cùng dùng để tính. */
  asOf: number;
}

export interface LiveLiquidations {
  symbol: string;
  /** Cụm thanh lý theo nến khung đang xem (đã lọc ngưỡng). */
  events: LiquidationEvent[];
  heatmap: LiquidationHeatmap | null;
  /** true = heatmap không đổi so với `heatmapAsOf` client gửi lên (không gửi lại, giữ bản cũ). */
  heatmapUnchanged?: boolean;
  /** Trạng thái kết nối từng sàn. */
  venues: { venue: LiqVenue; connected: boolean }[];
  notes: string[];
}
