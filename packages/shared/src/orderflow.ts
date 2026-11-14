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

/**
 * Số chữ số thập phân đủ cho giá cỡ `ref` (~6 chữ số có nghĩa, tối thiểu 2, tối đa 10):
 * BTC/ETH/BNB/vàng 2, SOL 3, LINK 4, NEAR 5, SUI/XRP 6. Thay cho làm tròn cố định 2 chữ số kiểu BTC.
 */
export function priceDecimals(ref: number): number {
  const a = Math.abs(ref);
  if (!Number.isFinite(a) || a === 0) return 2;
  return Math.min(10, Math.max(2, 5 - Math.floor(Math.log10(a))));
}

/** Làm tròn giá theo độ lớn của `ref` (mặc định chính nó); hiệu giá (basis, chênh lệch) truyền `ref` = giá tham chiếu. */
export function roundPrice(x: number, ref = x): number {
  const k = 10 ** priceDecimals(ref);
  return Math.round(x * k) / k;
}

/** Cận dưới bucket giá, không lệch do sai số dấu phẩy động (0.7702 / 0.0002 → 3851, không phải 3850.9999…). */
export function bucketFloor(price: number, bucket: number): number {
  return Number((Math.floor(price / bucket + 1e-9) * bucket).toPrecision(12));
}

/** Bỏ nhiễu dấu phẩy động của phép cộng/nhân giá (0.7702 + 0.0002 → 0.7704). */
export function cleanPrice(x: number): number {
  return Number(x.toPrecision(12));
}
