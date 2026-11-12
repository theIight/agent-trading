import { create } from 'zustand';
import type { LiveLiquidations, Timeframe } from '@wca/shared';
import { fetchLiquidations } from '../api/client.ts';

// Thanh lý của symbol/khung đang xem: bong bóng thanh lý thật + heatmap ước tính. Toggle nhớ trong localStorage.

export const LIQ_POLL_MS = 15_000;
const BUBBLES_KEY = 'wca:layerLiqBubbles';
const HEATMAP_KEY = 'wca:layerLiqHeatmap';

function load(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function save(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    // Không lưu được: chỉ mất trạng thái nhớ.
  }
}

interface LiquidationState {
  key: string | null;
  data: LiveLiquidations | null;
  error: string | null;
  showBubbles: boolean;
  showHeatmap: boolean;
  /** Bắt đầu poll cho symbol/khung (dừng poll cũ); null = dừng. */
  watch: (symbol: string | null, tf: Timeframe) => void;
  toggleBubbles: () => void;
  toggleHeatmap: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;

export const useLiquidationStore = create<LiquidationState>((set, get) => ({
  key: null,
  data: null,
  error: null,
  showBubbles: load(BUBBLES_KEY, true),
  showHeatmap: load(HEATMAP_KEY, false),
  watch: (symbol, tf) => {
    if (timer) clearInterval(timer);
    timer = null;
    const key = symbol ? `${symbol}:${tf}` : null;
    set({ key, data: null, error: null });
    if (!symbol) return;
    const loadData = () =>
      // Heatmap chỉ đổi khi có OI mới (5 phút): gửi asOf đang có, server không gửi lại nếu trùng.
      fetchLiquidations(symbol, tf, get().data?.heatmap?.asOf).then(
        data => {
          if (get().key !== key) return;
          const heatmap = data.heatmapUnchanged ? (get().data?.heatmap ?? null) : data.heatmap;
          set({ data: { ...data, heatmap }, error: null });
        },
        // Lỗi tạm thời: giữ dữ liệu cũ, chỉ báo lỗi.
        (e: Error) => get().key === key && set({ error: e.message }),
      );
    void loadData();
    timer = setInterval(loadData, LIQ_POLL_MS);
  },
  toggleBubbles: () => {
    const showBubbles = !get().showBubbles;
    set({ showBubbles });
    save(BUBBLES_KEY, showBubbles);
  },
  toggleHeatmap: () => {
    const showHeatmap = !get().showHeatmap;
    set({ showHeatmap });
    save(HEATMAP_KEY, showHeatmap);
  },
}));
