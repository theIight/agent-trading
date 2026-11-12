import { create } from 'zustand';
import type { Timeframe, VolumeAggResponse } from '@wca/shared';
import { fetchVolumeAgg } from '../api/client.ts';

// Volume gộp nhiều sàn (nến đã đóng) cho symbol/khung đang xem. Chỉ tải khi bật toggle; tải lại khi có nến mới đóng.

const ENABLED_KEY = 'wca:layerVolAgg';

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

interface VolumeAggState {
  enabled: boolean;
  /** `${symbol}:${tf}:${limit}:${mốc nến cuối}` của lần tải gần nhất. */
  key: string | null;
  data: VolumeAggResponse | null;
  error: string | null;
  toggle: () => void;
  /** symbol null = không hỗ trợ / tắt. `lastTime` đổi (nến mới) → tải lại. */
  sync: (symbol: string | null, tf: Timeframe, limit: number, lastTime: number | null) => void;
}

export const useVolumeAggStore = create<VolumeAggState>((set, get) => ({
  enabled: loadEnabled(),
  key: null,
  data: null,
  error: null,
  toggle: () => {
    const enabled = !get().enabled;
    set({ enabled, ...(enabled ? {} : { data: null, key: null, error: null }) });
    try {
      localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
    } catch {
      // Không lưu được: chỉ mất trạng thái nhớ.
    }
  },
  sync: (symbol, tf, limit, lastTime) => {
    if (!symbol || !get().enabled || !limit || lastTime === null) {
      if (get().key !== null) set({ key: null, data: null, error: null });
      return;
    }
    const key = `${symbol}:${tf}:${limit}:${lastTime}`;
    if (key === get().key) return;
    const sameView = get().data?.symbol === symbol && get().data?.tf === tf;
    set({ key, error: null, ...(sameView ? {} : { data: null }) });
    fetchVolumeAgg(symbol, tf, limit).then(
      data => get().key === key && set({ data }),
      (e: Error) => get().key === key && set({ error: e.message }),
    );
  },
}));
