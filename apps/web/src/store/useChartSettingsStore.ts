import { create } from 'zustand';
import { DEFAULT_DISPLAY, sanitizeDisplay, setDisplay, type DisplaySettings } from '../chart/displaySettings.ts';

// Cài đặt hiển thị chart (nút ⚙), lưu localStorage theo trình duyệt.

const KEY = 'wca:chartSettings';

function load(): DisplaySettings {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizeDisplay(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...DEFAULT_DISPLAY };
  }
}

function save(s: DisplaySettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Không lưu được: chỉ mất trạng thái nhớ.
  }
}

interface ChartSettingsState {
  settings: DisplaySettings;
  update: (patch: Partial<DisplaySettings>) => void;
  reset: () => void;
}

const initial = load();
setDisplay(initial);

export const useChartSettingsStore = create<ChartSettingsState>((set, get) => ({
  settings: initial,
  update: patch => {
    const settings = sanitizeDisplay({ ...get().settings, ...patch });
    setDisplay(settings);
    save(settings);
    set({ settings });
  },
  reset: () => {
    const settings = { ...DEFAULT_DISPLAY };
    setDisplay(settings);
    save(settings);
    set({ settings });
  },
}));
