import { isTimeframe, type Timeframe } from '@wca/shared';
import { LAYER_KEYS, type LayerKey } from './overlays/model.ts';

// Chế độ snapshot (`/?snapshot=<analysisId>&tf=<tf>`): server mở bằng Chrome headless để chụp chart kết quả gửi Telegram.

export interface SnapshotParams {
  id: string;
  tf: Timeframe;
  /** Lớp kết quả cần ẩn (`hide=action,levels`) — server ẩn Setup + Mức giá ở ảnh khung lớn. */
  hide: LayerKey[];
}

/** Đọc tham số snapshot; id sai định dạng hoặc tf không hợp lệ → null. */
export function parseSnapshotParams(search: string): SnapshotParams | null {
  const q = new URLSearchParams(search);
  const id = q.get('snapshot');
  const tf = q.get('tf');
  if (!id || !/^[\w-]{1,64}$/.test(id) || !tf || !isTimeframe(tf)) return null;
  const hide = (q.get('hide') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter((k): k is LayerKey => (LAYER_KEYS as string[]).includes(k));
  return { id, tf, hide: [...new Set(hide)] };
}

/** Trạng thái đọc bởi Playwright: `body[data-snapshot=ready|error]`. */
export function markSnapshot(state: 'ready' | 'error', error?: string): void {
  document.body.dataset.snapshot = state;
  if (error) document.body.dataset.snapshotError = error.slice(0, 300);
}

/** Số nến hiển thị trong ảnh chụp (chiếm phần bên trái). */
export const SNAPSHOT_BARS = 120;
/** Tỉ lệ độ rộng vùng vẽ dành cho nến (phần còn lại bên phải là tương lai). */
export const SNAPSHOT_CANDLE_FRAC = 0.6;
/** Mốc (tỉ lệ độ rộng) bắt đầu position tool trong ảnh chụp. */
export const SNAPSHOT_TOOL_FRAC = 0.5;

export interface LogicalSpan {
  from: number;
  to: number;
}

/**
 * Khoảng logic cố định cho ảnh chụp: `bars` nến cuối chiếm `candleFrac` bên trái, nến cuối nằm ở mốc đó,
 * phần còn lại bên phải là vùng tương lai. Nến i chiếm [i − 0.5, i + 0.5] theo chỉ số logic.
 */
export function snapshotRange(lastIndex: number, bars = SNAPSHOT_BARS, candleFrac = SNAPSHOT_CANDLE_FRAC): LogicalSpan {
  const from = lastIndex + 0.5 - bars;
  return { from, to: from + bars / candleFrac };
}

/** Chỉ số nến (≥ 0) có mép trái tại / ngay sau mốc `frac` của khoảng nhìn — nơi position tool bắt đầu. */
export function toolStartIndex(range: LogicalSpan, frac = SNAPSHOT_TOOL_FRAC): number {
  return Math.max(0, Math.ceil(range.from + 0.5 + frac * (range.to - range.from)));
}
