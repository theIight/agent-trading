import { create } from 'zustand';
import { parseRecent, pushRecent } from './recentSymbols.ts';

// Symbol xem gần đây (chỉ ghi khi tải nến thành công), lưu localStorage theo trình duyệt.

const KEY = 'wca:recent-symbols';

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    return parseRecent(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

function save(list: readonly string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Không lưu được: chỉ mất lịch sử.
  }
}

interface RecentSymbolsState {
  recent: string[];
  add: (symbol: string) => void;
  remove: (symbol: string) => void;
}

export const useRecentSymbolsStore = create<RecentSymbolsState>((set, get) => ({
  recent: load(),
  add: symbol => {
    const recent = pushRecent(get().recent, symbol);
    if (recent.length === get().recent.length && recent.every((s, i) => s === get().recent[i])) return;
    save(recent);
    set({ recent });
  },
  remove: symbol => {
    const recent = get().recent.filter(s => s !== symbol);
    save(recent);
    set({ recent });
  },
}));
