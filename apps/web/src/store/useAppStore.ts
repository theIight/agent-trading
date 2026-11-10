import { create } from 'zustand';
import type { Timeframe } from '@wca/shared';
import type { ThemeName } from '../chart/theme.ts';

const STORAGE_KEY = 'wca:prefs';

interface Prefs {
  symbol: string;
  tf: Timeframe;
  theme: ThemeName;
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
  setSymbol: (symbol: string) => void;
  setTf: (tf: Timeframe) => void;
  toggleTheme: () => void;
}

const initial = loadPrefs();

export const useAppStore = create<AppState>((set, get) => ({
  symbol: initial.symbol ?? 'BTCUSDT',
  tf: initial.tf ?? '4h',
  theme: initial.theme ?? 'dark',
  setSymbol: symbol => {
    set({ symbol });
    savePrefs(get());
  },
  setTf: tf => {
    set({ tf });
    savePrefs(get());
  },
  toggleTheme: () => {
    set({ theme: get().theme === 'dark' ? 'light' : 'dark' });
    savePrefs(get());
  },
}));
