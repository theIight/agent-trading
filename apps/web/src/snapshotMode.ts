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
