// Heatmap sổ lệnh (liquidity heatmap): khối lượng lệnh chờ trung bình theo bucket giá × cột thời gian.

/** Độ dài lịch sử tối đa của heatmap sổ lệnh (giờ) = thời gian collector giữ mẫu. */
export const BOOK_HEATMAP_HOURS = 24;
/** Số cột tối đa một heatmap. */
export const BOOK_HEATMAP_MAX_COLS = 720;

export interface BookHeatmap {
  symbol: string;
  /** Độ dài mỗi cột (giây) = độ dài nến khung đang xem (≥ 60). */
  colSec: number;
  /** Bucket giá nguồn (BTC 10, vàng 1). */
  bucket: number;
  /** Unix giây mở cột, tăng dần. */
  cols: number[];
  /** Basis (nguồn − chart) của từng cột: giá chart của ô = ix × bucket − shift[i]. */
  shift: number[];
  /** data[i] = phẳng [ix, qty, ix, qty, ...]; giá nguồn ô = ix × bucket; qty theo đơn vị nguồn. */
  data: number[][];
  /** Đơn vị khối lượng (BTC, oz). */
  unit: string;
  /** Cột cuối là cột đang chạy (chưa đóng). */
  partialLast: boolean;
  asOf: number;
}
