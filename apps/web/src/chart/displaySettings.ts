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
  /** Bong bóng thanh lý: chỉ hiện cụm ≥ hệ số này × ngưỡng server. */
  bubbleMinX: number;
  showCountdown: boolean;
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  spikeFontPx: 9,
  ofFontPx: 10,
  overlayFontPx: 11,
  axisFontPx: 12,
  spikeX: 3,
  heatmapOpacity: 1,
  bubbleMinX: 1,
  showCountdown: true,
};

type NumKey = Exclude<keyof DisplaySettings, 'showCountdown'>;

export const DISPLAY_RANGES: Record<NumKey, { min: number; max: number; step: number; label: string; unit: string }> = {
  spikeFontPx: { min: 7, max: 14, step: 1, label: 'Cỡ chữ nhãn đột biến volume', unit: 'px' },
  ofFontPx: { min: 8, max: 14, step: 1, label: 'Cỡ chữ nhãn order flow', unit: 'px' },
  overlayFontPx: { min: 9, max: 15, step: 1, label: 'Cỡ chữ nhãn phân tích', unit: 'px' },
  axisFontPx: { min: 10, max: 16, step: 1, label: 'Cỡ chữ trục giá / thời gian', unit: 'px' },
  spikeX: { min: 2, max: 6, step: 0.5, label: 'Ngưỡng đột biến volume trên chart', unit: '×' },
  heatmapOpacity: { min: 0.2, max: 1.5, step: 0.1, label: 'Độ đậm heatmap thanh lý', unit: '×' },
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
  return out;
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
