// Màu / độ dày vạch order flow lúc vẽ, theo cài đặt hiển thị (đổi cài đặt → vẽ lại ngay, không dựng lại model).
import type { DisplaySettings, HeatStops } from '../chart/displaySettings.ts';
import type { OrderflowLineItem } from './model.ts';

type Rgb = [number, number, number];

/** Thang heatmap kiểu Bookmap theo tỉ lệ so với tường lớn nhất đang vẽ (chart chỉ vẽ tường ≥ 40%). */
const HEAT_DARK: [number, Rgb][] = [
  [0.4, [255, 213, 79]], // vàng
  [0.6, [255, 152, 0]], // cam
  [0.8, [255, 87, 34]], // đỏ cam
  [1, [255, 243, 224]], // trắng nóng
];
/** Nền sáng: trắng nóng không thấy được → kết thúc ở đỏ đậm. */
const HEAT_LIGHT: [number, Rgb][] = [
  [0.4, [255, 179, 0]],
  [0.6, [251, 140, 0]],
  [0.8, [229, 57, 53]],
  [1, [142, 0, 0]],
];

const SIDE_RGB: Record<'BID' | 'ASK', Rgb> = { BID: [38, 166, 154], ASK: [239, 83, 80] };
const PULLED_RGB: Rgb = [180, 180, 180];

/** Alpha gốc của dải tường (nhân với `ofOpacity`); chế độ bookmap còn nhân thêm (0.5 + ratio) để tường lớn sáng hơn. */
export const OF_FILL_ALPHA = { bookmap: 0.45, side: 0.3 } as const;

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${Math.round(Math.min(1, Math.max(0, a)) * 1000) / 1000})`;

const STOP_AT = [0.4, 0.6, 0.8, 1];

const hexRgb = (hex: string): Rgb => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};

const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;

/** Thang mặc định theo theme dạng hex (4 mốc 40/60/80/100%) — dùng cho ô chọn màu khi chưa tự chọn. */
export function defaultHeatStops(light = false): HeatStops {
  return (light ? HEAT_LIGHT : HEAT_DARK).map(([, c]) => toHex(c)) as HeatStops;
}

/**
 * Màu heatmap tại `ratio` (kẹp [0, 1]; dưới mốc đầu = màu đầu).
 * `custom` = 4 mã hex người dùng chọn (mốc 40/60/80/100%), thay cho thang mặc định của theme.
 */
export function heatColor(ratio: number, alpha: number, light = false, custom?: HeatStops | null): string {
  const stops: [number, Rgb][] = custom ? custom.map((h, i) => [STOP_AT[i]!, hexRgb(h)]) : light ? HEAT_LIGHT : HEAT_DARK;
  const r = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  if (r <= stops[0]![0]) return rgba(stops[0]![1], alpha);
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]!;
    if (r > p1) continue;
    const [p0, c0] = stops[i - 1]!;
    const k = (r - p0) / (p1 - p0);
    return rgba(c0.map((v, j) => Math.round(v + (c1[j]! - v) * k)) as Rgb, alpha);
  }
  return rgba(stops.at(-1)![1], alpha);
}

export interface WallStyle {
  fill: string;
  text: string;
  width: number;
  label: string;
}

type OfSettings = Pick<DisplaySettings, 'ofColorMode' | 'ofWidthX' | 'ofOpacity'> & Partial<Pick<DisplaySettings, 'ofHeatStops'>>;

/** Kiểu vẽ cuối của một vạch order flow. POC / vạch không có `kind` giữ nguyên model. */
export function wallStyle(item: OrderflowLineItem, s: OfSettings, light = false): WallStyle {
  const keep: WallStyle = { fill: item.color, text: item.textColor, width: item.width, label: item.label };
  if (item.kind === 'pulled') {
    if (s.ofColorMode !== 'bookmap') return keep;
    return { ...keep, fill: rgba(PULLED_RGB, 0.4 * s.ofOpacity) };
  }
  if (item.kind !== 'wall' || !item.side) return keep;
  const width = Math.max(1, Math.round(item.width * s.ofWidthX * 10) / 10);
  if (s.ofColorMode === 'bookmap') {
    const ratio = item.ratio ?? 1;
    return {
      fill: heatColor(ratio, OF_FILL_ALPHA.bookmap * (0.5 + Math.min(1, Math.max(0, ratio))) * s.ofOpacity, light, s.ofHeatStops),
      text: heatColor(ratio, 0.95, light, s.ofHeatStops),
      width,
      label: item.label ? `${item.side === 'BID' ? 'B' : 'A'} ${item.label}` : '',
    };
  }
  return { ...keep, fill: rgba(SIDE_RGB[item.side], OF_FILL_ALPHA.side * s.ofOpacity), width };
}
