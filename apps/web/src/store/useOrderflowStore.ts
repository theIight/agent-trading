import { create } from 'zustand';
import { fetchLiveOrderflow, type LiveOrderflow } from '../api/client.ts';

// Order flow hiện tại (Binance) của symbol đang xem: vẽ sẵn trên chart, không cần chạy phân tích.

export const LIVE_ORDERFLOW_POLL_MS = 15_000;

interface OrderflowState {
  symbol: string | null;
  data: LiveOrderflow | null;
  error: string | null;
  /** Bắt đầu poll cho symbol (dừng poll cũ); symbol không có nguồn → null. */
  watch: (symbol: string | null) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;

export const useOrderflowStore = create<OrderflowState>((set, get) => ({
  symbol: null,
  data: null,
  error: null,
  watch: symbol => {
    if (timer) clearInterval(timer);
    timer = null;
    set({ symbol, data: null, error: null });
    if (!symbol) return;
    const load = () =>
      fetchLiveOrderflow(symbol).then(
        data => get().symbol === symbol && set({ data, error: null }),
        // Lỗi tạm thời: giữ vạch cũ, chỉ báo lỗi.
        (e: Error) => get().symbol === symbol && set({ error: e.message }),
      );
    void load();
    timer = setInterval(load, LIVE_ORDERFLOW_POLL_MS);
  },
}));
