import { create } from 'zustand';
import type { BookHeatmap, Timeframe } from '@wca/shared';
import { fetchBookHeatmap } from '../api/client.ts';
import { lastClosedCol, mergeHeatmap } from '../overlays/bookHeatmapModel.ts';
import { useLiquidationStore } from './useLiquidationStore.ts';

// Heatmap sổ lệnh của symbol/khung đang xem. Chỉ poll khi lớp đang bật; mỗi lần chỉ tải cột mới (`after`).

export const BOOK_HEATMAP_POLL_MS = 15_000;
const SHOW_KEY = 'wca:layerBookHeatmap';

function loadShow(): boolean {
  try {
    return localStorage.getItem(SHOW_KEY) === '1';
  } catch {
    return false;
  }
}

function saveShow(v: boolean): void {
  try {
    localStorage.setItem(SHOW_KEY, v ? '1' : '0');
  } catch {
    // Không lưu được: chỉ mất trạng thái nhớ.
  }
}

interface BookHeatmapState {
  /** `symbol:tf` đang theo dõi; null = symbol không có order flow. */
  key: string | null;
  symbol: string | null;
  tf: Timeframe | null;
  data: BookHeatmap | null;
  error: string | null;
  show: boolean;
  watch: (symbol: string | null, tf: Timeframe) => void;
  setShow: (show: boolean) => void;
  toggle: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;

function restart(get: () => BookHeatmapState, set: (p: Partial<BookHeatmapState>) => void): void {
  if (timer) clearInterval(timer);
  timer = null;
  const { key, symbol, tf, show } = get();
  if (!key || !symbol || !tf || !show) return;
  const load = () =>
    fetchBookHeatmap(symbol, tf, lastClosedCol(get().data)).then(
      next => {
        if (get().key !== key) return;
        set({ data: mergeHeatmap(get().data, next), error: null });
      },
      // Lỗi tạm thời: giữ dữ liệu cũ, chỉ báo lỗi.
      (e: Error) => get().key === key && set({ error: e.message }),
    );
  void load();
  timer = setInterval(load, BOOK_HEATMAP_POLL_MS);
}

export const useBookHeatmapStore = create<BookHeatmapState>((set, get) => ({
  key: null,
  symbol: null,
  tf: null,
  data: null,
  error: null,
  show: loadShow(),
  watch: (symbol, tf) => {
    const key = symbol ? `${symbol}:${tf}` : null;
    if (key === get().key) return;
    set({ key, symbol, tf, data: null, error: null });
    restart(get, set);
  },
  setShow: show => {
    if (show === get().show) return;
    set({ show, ...(show ? {} : { error: null }) });
    saveShow(show);
    // Hai heatmap không chồng lên nhau.
    if (show) useLiquidationStore.getState().setHeatmap(false);
    restart(get, set);
  },
  toggle: () => get().setShow(!get().show),
}));
