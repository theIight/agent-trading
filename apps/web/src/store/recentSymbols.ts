import { normalizeSymbol } from '@wca/shared';

// Symbol xem gần đây (mới nhất trước) + gợi ý cho ô nhập symbol trên toolbar.

export const MAX_RECENT = 8;

export interface Suggestion {
  symbol: string;
  /** true = lấy từ lịch sử xem gần đây (có thể xoá). */
  recent: boolean;
}

/** Đưa `symbol` lên đầu, bỏ trùng, cắt còn `max` phần tử. */
export function pushRecent(list: readonly string[], symbol: string, max = MAX_RECENT): string[] {
  const s = normalizeSymbol(symbol);
  if (!s) return list.slice(0, max);
  return [s, ...list.filter(x => x !== s)].slice(0, max);
}

/** Chuẩn hoá dữ liệu đọc từ localStorage: sai kiểu → rỗng, phần tử lạ bị bỏ. */
export function parseRecent(raw: unknown, max = MAX_RECENT): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const s = normalizeSymbol(item);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Gần đây trước, rồi watchlist; bỏ trùng; lọc theo chuỗi đang gõ (chứa). */
export function buildSuggestions(recent: readonly string[], watchlist: readonly string[], query: string): Suggestion[] {
  const q = normalizeSymbol(query);
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const add = (symbol: string, isRecent: boolean) => {
    if (seen.has(symbol) || (q && !symbol.includes(q))) return;
    seen.add(symbol);
    out.push({ symbol, recent: isRecent });
  };
  recent.forEach(s => add(s, true));
  watchlist.forEach(s => add(s, false));
  return out;
}
