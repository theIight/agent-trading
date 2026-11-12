import type { BookmapImageRole, OrderflowLevelKind } from './analysis.ts';

// Ảnh Bookmap (order flow): quy đổi giá Bookmap → giá chart của app và kiểm tra ảnh cũ.
// Vàng: Bookmap chạy GC futures (COMEX), cao hơn XAUUSD spot một khoản basis (offset).

/** Thông tin ảnh Bookmap của một lượt phân tích (server lưu cạnh ảnh). */
export interface BookmapMeta {
  images: BookmapImageRole[];
  /** Unix giây lúc chụp (UI lấy từ File.lastModified). */
  capturedAt: number;
  /** Unix giây lúc gửi phân tích. */
  submittedAt: number;
  /** Giá Bookmap − giá app. */
  offset: number;
  /** Ngưỡng lệch offset (đơn vị giá) để cảnh báo ảnh cũ. */
  tolerance: number;
  /** Mô tả công cụ trên Bookmap, vd "GC futures COMEX". */
  instrument: string;
  /** Giá app (close nến 1m chứa capturedAt); null = chưa lấy / không lấy được. */
  refPrice?: number | null;
}

/** Cấu hình Bookmap gửi cho UI (`GET /api/config`). */
export interface BookmapUiConfig {
  symbols: string[];
  offsets: Record<string, number>;
}

export function bookmapInstrumentLabel(symbol: string): string {
  if (symbol === 'XAUUSD') return 'GC futures COMEX (cao hơn XAUUSD spot một khoản offset)';
  if (symbol === 'BTCUSDT') return 'BTCUSDT Binance spot';
  return symbol;
}

/** Đơn vị khối lượng hiển thị theo symbol. */
export function bookmapSizeUnit(symbol: string): string {
  if (symbol === 'XAUUSD') return 'lot';
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  return '';
}

const round = (x: number, digits = 6) => Math.round(x * 10 ** digits) / 10 ** digits;

/** Giá Bookmap → giá chart của app. */
export function toAppPrice(bookmapPrice: number, offset: number): number {
  return round(bookmapPrice - offset);
}

export const ORDERFLOW_KIND_LABELS: Record<OrderflowLevelKind, string> = {
  ASK_WALL: 'Tường bán',
  BID_WALL: 'Tường mua',
  POC: 'POC',
  HVN: 'Vùng volume cao (HVN)',
  LVN: 'Vùng volume thấp (LVN)',
  ABSORPTION: 'Hấp thụ',
  AGGRESSION: 'Lệnh lớn',
};

export interface StalenessInput {
  lastPrices: { image: BookmapImageRole; bookmapPrice: number }[];
  refPrice: number | null | undefined;
  offset: number;
  tolerance: number;
  capturedAt: number;
  submittedAt: number;
  /** Tuổi ảnh tối đa (giây) trước khi cảnh báo. */
  maxAgeSec: number;
}

/**
 * Kiểm tra ảnh cũ: so giá cuối đọc trên ảnh (đã trừ offset) với giá app lúc chụp.
 * Lệch quá ngưỡng thường do ảnh chụp đã lâu (giá đã chạy) — vẫn quy đổi bằng offset cấu hình.
 */
export function checkStaleness(inp: StalenessInput): { measuredOffset?: number; warnings: string[] } {
  const warnings: string[] = [];
  const age = inp.submittedAt - inp.capturedAt;
  if (age > inp.maxAgeSec) warnings.push(`Ảnh Bookmap chụp cách lúc gửi ${Math.round(age / 60)} phút — có thể đã cũ`);
  if (!inp.lastPrices.length) {
    warnings.push('Agent không đọc được giá cuối trên ảnh Bookmap — không kiểm tra được ảnh cũ');
    return { warnings };
  }
  if (inp.refPrice == null) {
    warnings.push('Không có giá app lúc chụp ảnh Bookmap — không kiểm tra được ảnh cũ');
    return { warnings };
  }
  const ref = inp.refPrice;
  // Ảnh khung bé zoom hẹp hơn → đọc giá chính xác hơn.
  const sorted = [...inp.lastPrices].sort((a, b) => (a.image === 'ltf' ? -1 : 0) - (b.image === 'ltf' ? -1 : 0));
  for (const lp of sorted) {
    const measured = lp.bookmapPrice - ref;
    if (Math.abs(measured - inp.offset) > inp.tolerance) {
      warnings.push(
        `Ảnh Bookmap ${lp.image === 'htf' ? 'khung lớn' : 'khung bé'} có thể đã cũ: giá cuối ${lp.bookmapPrice}, quy đổi ${toAppPrice(lp.bookmapPrice, inp.offset)}, ` +
          `giá app lúc chụp ${ref} (lệch offset ${round(measured - inp.offset, 2)}, ngưỡng ±${inp.tolerance})`,
      );
    }
  }
  return { measuredOffset: round(sorted[0]!.bookmapPrice - ref, 2), warnings };
}

/** Trạng thái một tường trong lịch sử sổ lệnh (order flow Binance). */
export type WallSegmentStatus = 'active' | 'consumed' | 'pulled';

/**
 * Một tường thanh khoản theo thời gian: `active` = còn trong sổ lệnh, `consumed` = giá quét qua / hấp thụ,
 * `pulled` = rút khi giá chưa chạm (thường là lệnh ảo).
 */
export interface WallSegment {
  side: 'BID' | 'ASK';
  /** Cận dưới bucket trên sổ lệnh spot. */
  sourcePrice: number;
  /** Giá chart (sourcePrice − basis). Server điền khi trả API. */
  price?: number;
  /** Unix giây. */
  start: number;
  /** Unix giây lúc bị quét / rút; null = còn tồn tại. */
  end: number | null;
  /** Khối lượng lớn nhất tường đạt được. */
  peakSize: number;
  status: WallSegmentStatus;
}
