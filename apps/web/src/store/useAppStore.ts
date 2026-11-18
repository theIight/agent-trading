import { create } from 'zustand';
import type { Timeframe } from '@wca/shared';
import type { ThemeName } from '../chart/theme.ts';
import { parseSnapshotParams } from '../snapshotMode.ts';
import { readUrlPrefs, writeUrlPrefs } from './urlPrefs.ts';

const STORAGE_KEY = 'wca:prefs';

interface Prefs {
  symbol: string;
  tf: Timeframe;
  theme: ThemeName;
  panelOpen?: boolean;
}

function loadPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Prefs>;
  } catch {
    return {};
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* bỏ qua: private mode */
  }
}

interface AppState extends Prefs {
  panelOpen: boolean;
  setSymbol: (symbol: string) => void;
  setTf: (tf: Timeframe) => void;
  toggleTheme: () => void;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
}

/** Chế độ snapshot không đọc/ghi symbol, tf trên URL. */
const URL_SYNC = typeof window !== 'undefined' && parseSnapshotParams(window.location.search) === null;

/** Ghi symbol/khung lên URL của tab (không reload, không thêm lịch sử Back). */
function syncUrl(p: Prefs): void {
  if (!URL_SYNC) return;
  const { pathname, search, hash } = window.location;
  const next = writeUrlPrefs(search, p.symbol, p.tf);
  if (next !== search) window.history.replaceState(window.history.state, '', pathname + next + hash);
}

// Ưu tiên: tham số URL (riêng từng tab) → localStorage (dùng chung, symbol gần nhất) → mặc định.
const initial: Partial<Prefs> = { ...loadPrefs(), ...(URL_SYNC ? readUrlPrefs(window.location.search) : {}) };

export const useAppStore = create<AppState>((set, get) => ({
  symbol: initial.symbol ?? 'BTCUSDT',
  tf: initial.tf ?? '4h',
  theme: initial.theme ?? 'dark',
  panelOpen: initial.panelOpen ?? true,
  setSymbol: symbol => {
    set({ symbol });
    savePrefs(get());
    syncUrl(get());
  },
  setTf: tf => {
    set({ tf });
    savePrefs(get());
    syncUrl(get());
  },
  toggleTheme: () => {
    set({ theme: get().theme === 'dark' ? 'light' : 'dark' });
    savePrefs(get());
  },
  togglePanel: () => {
    const next = !get().panelOpen;
    set({ panelOpen: next });
    savePrefs(get());
  },
  setPanelOpen: open => {
    set({ panelOpen: open });
    savePrefs(get());
  },
}));

syncUrl(useAppStore.getState());
