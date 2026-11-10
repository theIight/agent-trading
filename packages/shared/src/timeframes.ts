// Khung thời gian hỗ trợ. Chuỗi trùng với interval của Binance Futures.
export const SUPPORTED_TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;
export type Timeframe = (typeof SUPPORTED_TFS)[number];

export type TfRole = 'HTF' | 'PRIMARY' | 'LTF';

const TF_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
  '1w': 604800,
};

const TF_LABELS: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
  '1w': '1W',
};

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && (SUPPORTED_TFS as readonly string[]).includes(value);
}

export function tfSeconds(tf: Timeframe): number {
  return TF_SECONDS[tf];
}

export function tfLabel(tf: Timeframe): string {
  return TF_LABELS[tf];
}

/** Sắp xếp khung từ lớn → nhỏ (thứ tự phân tích top-down). */
export function sortTopDown(tfs: readonly Timeframe[]): Timeframe[] {
  return [...tfs].sort((a, b) => TF_SECONDS[b] - TF_SECONDS[a]);
}

export function roleOf(tf: Timeframe, primary: Timeframe): TfRole {
  if (tf === primary) return 'PRIMARY';
  return TF_SECONDS[tf] > TF_SECONDS[primary] ? 'HTF' : 'LTF';
}

export interface TfPlanEntry {
  tf: Timeframe;
  role: TfRole;
}

export type TfSelectionResult =
  | { ok: true; plan: TfPlanEntry[] }
  | { ok: false; error: string };

/**
 * Validate lựa chọn khung (1 khung chính + 0..maxTotal-1 khung phụ) và trả về
 * kế hoạch phân tích đã sắp top-down (khung lớn → khung nhỏ) kèm vai trò.
 */
export function buildTfPlan(primary: unknown, context: unknown[], maxTotal = 4): TfSelectionResult {
  if (!isTimeframe(primary)) return { ok: false, error: `Khung chính không hỗ trợ: ${String(primary)}` };
  const invalid = context.filter(tf => !isTimeframe(tf));
  if (invalid.length) return { ok: false, error: `Khung phụ không hỗ trợ: ${invalid.map(String).join(', ')}` };
  const ctx = context as Timeframe[];
  const all = [primary, ...ctx];
  if (new Set(all).size !== all.length) return { ok: false, error: 'Khung bị trùng lặp' };
  if (all.length > maxTotal) return { ok: false, error: `Tối đa ${maxTotal} khung mỗi lần phân tích` };
  return { ok: true, plan: sortTopDown(all).map(tf => ({ tf, role: roleOf(tf, primary) })) };
}
