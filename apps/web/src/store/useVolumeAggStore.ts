import { create } from 'zustand';
import { isVolumeSource, type Timeframe, type VolumeAggResponse, type VolumeSource } from '@wca/shared';
import { fetchVolumeAgg } from '../api/client.ts';

// Nguồn volume trên chart + dữ liệu volume nhiều sàn (nến đã đóng). Chỉ tải khi nguồn ≠ Binance Futures; tải lại khi có nến mới.

const SOURCE_KEY = 'wca:volumeSource';
/** Khoá cũ của toggle "Volume gộp" (1 = bật) → nguồn `stacked`. */
const LEGACY_KEY = 'wca:layerVolAgg';

function loadSource(): VolumeSource {
  try {
    const v = localStorage.getItem(SOURCE_KEY);
    if (isVolumeSource(v)) return v;
    return localStorage.getItem(LEGACY_KEY) === '1' ? 'stacked' : 'futures';
  } catch {
    return 'futures';
  }
}

interface VolumeAggState {
  source: VolumeSource;
  /** `${symbol}:${tf}:${limit}:${mốc nến cuối}` của lần tải gần nhất. */
  key: string | null;
  data: VolumeAggResponse | null;
  error: string | null;
  setSource: (source: VolumeSource) => void;
  /** symbol null = không hỗ trợ. `lastTime` đổi (nến mới) → tải lại. */
  sync: (symbol: string | null, tf: Timeframe, limit: number, lastTime: number | null) => void;
}

export const useVolumeAggStore = create<VolumeAggState>((set, get) => ({
  source: loadSource(),
  key: null,
  data: null,
  error: null,
  setSource: source => {
    set({ source, ...(source === 'futures' ? { data: null, key: null, error: null } : {}) });
    try {
      localStorage.setItem(SOURCE_KEY, source);
    } catch {
      // Không lưu được: chỉ mất trạng thái nhớ.
    }
  },
  sync: (symbol, tf, limit, lastTime) => {
    if (!symbol || get().source === 'futures' || !limit || lastTime === null) {
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
