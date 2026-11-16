import { isTimeframe, normalizeSymbol, type Timeframe } from '@wca/shared';

// Symbol + khung trên URL (`?symbol=INJUSDT&tf=1m`): mỗi tab giữ symbol riêng khi reload
// (localStorage dùng chung mọi tab).

export interface UrlPrefs {
  symbol?: string;
  tf?: Timeframe;
}

/** Đọc symbol/khung từ query; giá trị sai bị bỏ (lấy nguồn kế tiếp). */
export function readUrlPrefs(search: string): UrlPrefs {
  const q = new URLSearchParams(search);
  const out: UrlPrefs = {};
  const sym = normalizeSymbol(q.get('symbol') ?? '');
  if (sym.length >= 2 && sym.length <= 30) out.symbol = sym;
  const tf = q.get('tf');
  if (tf && isTimeframe(tf)) out.tf = tf;
  return out;
}

/** Query mới mang symbol/khung (đứng đầu), giữ nguyên tham số khác. Trả về dạng `?…`. */
export function writeUrlPrefs(search: string, symbol: string, tf: Timeframe): string {
  const q = new URLSearchParams(search);
  q.delete('symbol');
  q.delete('tf');
  const next = new URLSearchParams({ symbol, tf });
  for (const [k, v] of q) next.append(k, v);
  return `?${next.toString()}`;
}
