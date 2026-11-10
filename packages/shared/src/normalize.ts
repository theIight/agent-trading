import { SUPPORTED_TFS } from './timeframes.ts';

const TF_KEYS = new Set(['tf', 'primaryTf']);

/** `1D` → `1d`, `4H` → `4h`… `1M` giữ nguyên (mơ hồ tháng/phút) để validator báo lỗi. */
export function normalizeTfValue(v: unknown): unknown {
  if (typeof v !== 'string' || v === '1M') return v;
  const lower = v.trim().toLowerCase();
  return (SUPPORTED_TFS as readonly string[]).includes(lower) ? lower : v;
}

/** Chuẩn hoá mọi trường `tf` / `primaryTf` trong bản nộp của agent (đệ quy, không sửa object gốc). */
export function normalizeTfInput<T>(raw: T): T {
  if (Array.isArray(raw)) return raw.map(x => normalizeTfInput(x)) as T;
  if (raw && typeof raw === 'object') {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, TF_KEYS.has(k) ? normalizeTfValue(v) : normalizeTfInput(v)]),
    ) as T;
  }
  return raw;
}
