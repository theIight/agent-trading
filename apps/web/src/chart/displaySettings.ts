// Cài đặt hiển thị chart (nút ⚙): mặc định, khoảng hợp lệ, chuẩn hoá. Renderer đọc qua `display()`.

export interface DisplaySettings {
  /** Cỡ chữ nhãn đột biến volume (px). */
  spikeFontPx: number;
  /** Cỡ chữ nhãn order flow (số khối lượng tường, POC). */
  ofFontPx: number;
  /** Cỡ chữ nhãn phân tích (sự kiện, range, setup). */
  overlayFontPx: number;
  /** Cỡ chữ trục giá / thời gian. */
  axisFontPx: number;
  /** Ngưỡng đột biến volume trên chart (× trung vị 20 nến). */
  spikeX: number;
  /** Hệ số độ đậm heatmap thanh lý. */
  heatmapOpacity: number;
  /** Hệ số độ đậm heatmap sổ lệnh. */
  bookHeatOpacity: number;
  /** Heatmap sổ lệnh: ẩn ô dưới phân vị này (%). */
  bookHeatHidePct: number;
  /**
   * Heatmap sổ lệnh: chỉ hiện ô có khối lượng ≥ ngưỡng tuyệt đối này, theo từng symbol (đơn vị khối lượng
   * của sổ lệnh nguồn: BTC, oz…). Thiếu / 0 = tắt. Dùng chung với `bookHeatHidePct` (lấy ngưỡng lớn hơn).
   */
  bookHeatMinQty: Record<string, number>;
  /** Bong bóng thanh lý: chỉ hiện cụm ≥ hệ số này × ngưỡng server. */
  bubbleMinX: number;
  /** Hệ số độ dày vạch tường order flow. */
  ofWidthX: number;
  /** Hệ số độ đậm dải tường order flow. */
  ofOpacity: number;
  /** Màu tường order flow: heatmap kiểu Bookmap (theo độ lớn) hoặc theo phía (xanh/đỏ). */
  ofColorMode: OfColorMode;
  /** Thang màu Bookmap tự chọn (hex, mốc 40/60/80/100%); null = mặc định theo theme. */
  ofHeatStops: HeatStops | null;
  showCountdown: boolean;
}

export type HeatStops = [string, string, string, string];
export const HEAT_STOP_LABELS = ['40%', '60%', '80%', '100%'] as const;

export type OfColorMode = 'bookmap' | 'side';
export const OF_COLOR_MODES: { value: OfColorMode; label: string }[] = [
  { value: 'bookmap', label: 'Bookmap (theo độ lớn)' },
  { value: 'side', label: 'Theo phía (xanh/đỏ)' },
];

export const DEFAULT_DISPLAY: DisplaySettings = {
  spikeFontPx: 9,
  ofFontPx: 10,
  overlayFontPx: 11,
  axisFontPx: 12,
  spikeX: 3,
  heatmapOpacity: 1,
  bookHeatOpacity: 1,
  bookHeatHidePct: 20,
  bookHeatMinQty: {},
  bubbleMinX: 1,
  ofWidthX: 1.5,
  ofOpacity: 1,
  ofColorMode: 'bookmap',
  ofHeatStops: null,
  showCountdown: true,
};

type NumKey = Exclude<keyof DisplaySettings, 'showCountdown' | 'ofColorMode' | 'ofHeatStops' | 'bookHeatMinQty'>;

export const DISPLAY_RANGES: Record<NumKey, { min: number; max: number; step: number; label: string; unit: string }> = {
  spikeFontPx: { min: 7, max: 14, step: 1, label: 'Cỡ chữ nhãn đột biến volume', unit: 'px' },
  ofFontPx: { min: 8, max: 14, step: 1, label: 'Cỡ chữ nhãn order flow', unit: 'px' },
  ofWidthX: { min: 0.5, max: 3, step: 0.25, label: 'Độ dày tường order flow', unit: '×' },
  ofOpacity: { min: 0.3, max: 1.5, step: 0.1, label: 'Độ đậm tường order flow', unit: '×' },
  overlayFontPx: { min: 9, max: 15, step: 1, label: 'Cỡ chữ nhãn phân tích', unit: 'px' },
  axisFontPx: { min: 10, max: 16, step: 1, label: 'Cỡ chữ trục giá / thời gian', unit: 'px' },
  spikeX: { min: 2, max: 6, step: 0.5, label: 'Ngưỡng đột biến volume trên chart', unit: '×' },
  heatmapOpacity: { min: 0.2, max: 1.5, step: 0.1, label: 'Độ đậm heatmap thanh lý', unit: '×' },
  bookHeatOpacity: { min: 0.2, max: 1.5, step: 0.1, label: 'Độ đậm heatmap sổ lệnh', unit: '×' },
  bookHeatHidePct: { min: 0, max: 95, step: 5, label: 'Heatmap sổ lệnh: ẩn ô nhỏ dưới phân vị', unit: '%' },
  bubbleMinX: { min: 1, max: 5, step: 0.5, label: 'Bong bóng thanh lý: chỉ hiện cụm ≥', unit: '× ngưỡng' },
};

/** Chuẩn hoá dữ liệu đọc từ localStorage: thiếu / sai kiểu / ngoài khoảng → kẹp hoặc về mặc định. */
export function sanitizeDisplay(raw: unknown): DisplaySettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: DisplaySettings = { ...DEFAULT_DISPLAY };
  for (const key of Object.keys(DISPLAY_RANGES) as NumKey[]) {
    const v = Number(src[key]);
    if (src[key] === undefined || src[key] === null || !Number.isFinite(v)) continue;
    const { min, max, step } = DISPLAY_RANGES[key];
    out[key] = Math.min(max, Math.max(min, Math.round(v / step) * step));
    out[key] = Math.round(out[key] * 100) / 100;
  }
  if (typeof src.showCountdown === 'boolean') out.showCountdown = src.showCountdown;
  if (OF_COLOR_MODES.some(m => m.value === src.ofColorMode)) out.ofColorMode = src.ofColorMode as OfColorMode;
  const stops = src.ofHeatStops;
  if (Array.isArray(stops) && stops.length === 4 && stops.every(h => typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h))) {
    out.ofHeatStops = stops.map(h => (h as string).toLowerCase()) as HeatStops;
  }
  out.bookHeatMinQty = sanitizeMinQty(src.bookHeatMinQty);
  return out;
}

const SYMBOL_RE = /^[A-Z0-9]{2,30}$/;

/** Ngưỡng khối lượng heatmap theo symbol: chỉ giữ key symbol hợp lệ và giá trị hữu hạn > 0. */
function sanitizeMinQty(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [sym, v] of Object.entries(raw as Record<string, unknown>)) {
    if (SYMBOL_RE.test(sym) && typeof v === 'number' && Number.isFinite(v) && v > 0) out[sym] = v;
  }
  return out;
}

/** Ngưỡng khối lượng tuyệt đối heatmap sổ lệnh của `symbol` (0 = tắt). */
export function bookHeatMinQtyOf(s: DisplaySettings, symbol: string): number {
  return s.bookHeatMinQty[symbol] ?? 0;
}

/** Đặt / xoá (≤ 0, rỗng, sai) ngưỡng khối lượng heatmap của `symbol`; trả map mới. */
export function withBookHeatMinQty(map: Record<string, number>, symbol: string, qty: number): Record<string, number> {
  const next = { ...map };
  if (Number.isFinite(qty) && qty > 0) next[symbol] = qty;
  else delete next[symbol];
  return next;
}

const FAMILY = '-apple-system, BlinkMacSystemFont, Roboto, sans-serif';
export const font = (px: number) => `${px}px ${FAMILY}`;

let current: DisplaySettings = { ...DEFAULT_DISPLAY };

/** Cài đặt hiện tại (renderer đọc mỗi lần vẽ). */
export function display(): DisplaySettings {
  return current;
}

export function setDisplay(s: DisplaySettings): void {
  current = s;
}
