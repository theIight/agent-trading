import { MIN_KLINE_BARS, normalizeTfValue, RUN_CONTEXT_ENV, SUPPORTED_TFS, type KlinesResponse, type Timeframe, type VolumeAggResponse } from '@wca/shared';

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');

function num(x: number): string {
  // Giữ đủ độ chính xác giá, tránh số mũ khoa học.
  return Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(10)));
}

/** CSV gọn cho agent: một header mô tả + bảng nến. */
export function formatKlinesCsv(res: KlinesResponse): string {
  const { candles } = res;
  if (!candles.length) return `# ${res.symbol} ${res.tf}: không có dữ liệu`;
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const lines = [
    `# ${res.symbol} ${res.tf} · ${candles.length} nến đã đóng · ${iso(first.time)}Z → ${iso(last.time)}Z (UTC)${res.source === 'cache' ? ' · nguồn cache' : ''}`,
    'i,time_utc,unix,open,high,low,close,volume',
  ];
  candles.forEach((c, i) => {
    lines.push(`${i},${iso(c.time)},${c.time},${num(c.open)},${num(c.high)},${num(c.low)},${num(c.close)},${Number(c.volume.toFixed(3))}`);
  });
  return lines.join('\n');
}

/** Wyckoff cần đủ bối cảnh: limit nhỏ hơn thì tự nâng lên (không báo lỗi). */
export const MIN_BARS = MIN_KLINE_BARS;

export type RunContextKey = keyof typeof RUN_CONTEXT_ENV;

/**
 * Giá trị tham số: agent truyền thì dùng; bỏ sót thì lấy từ ngữ cảnh lượt chạy (env do runner đặt).
 * Phiên tương tác (không có env) mà thiếu → lỗi tiếng Việt rõ ràng.
 */
export function resolveParam(value: string | undefined, key: RunContextKey, env: Record<string, string | undefined> = process.env): string {
  const v = value?.trim();
  if (v) return v;
  const fromEnv = env[RUN_CONTEXT_ENV[key]]?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(`Thiếu tham số \`${key}\`${key === 'analysisId' ? ' (lấy từ tin nhắn yêu cầu phân tích)' : ' (vd BTCUSDT)'}`);
}

/** Chuẩn hoá tham số get_klines / get_features: tf chữ hoa → thường, limit < MIN_BARS → nâng lên. */
export function resolveKlineArgs(tfRaw: string, limit: number | undefined, defaultBars: number): { tf: Timeframe; limit: number; note: string } {
  const tf = normalizeTfValue(tfRaw);
  if (typeof tf !== 'string' || !(SUPPORTED_TFS as readonly string[]).includes(tf)) {
    throw new Error(`tf không hợp lệ: "${tfRaw}". Dùng một trong: ${SUPPORTED_TFS.join(', ')}`);
  }
  const want = limit ?? defaultBars;
  const eff = Math.max(MIN_BARS, want);
  return { tf: tf as Timeframe, limit: eff, note: eff !== want ? `(đã nâng limit từ ${want} lên ${eff})\n` : '' };
}

export interface VolumeAggSummary {
  note: string;
  /** Ngưỡng đột biến (× trung vị 20 nến trước, tính riêng perp / spot). */
  spikeX: number;
  /** 20 nến gần nhất: `i` khớp cột i của get_klines; spotShareX = (spot/perp) / trung vị (spot/perp) cả tập. */
  recent: { i: number; time: number; perp: number; spot: number | null; spotShareX: number | null; perpComplete: boolean }[];
  /** Nến đột biến trong tập nến: kind SPOT = spot đột biến, perp bình thường (tiền thật); PERP = chỉ perp (đòn bẩy/thanh lý); BOTH = cả hai. */
  spikes: { i: number; time: number; kind: string; perpX: number | null; spotX: number | null }[];
  warnings?: string[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : 0;
};

/** Tóm tắt volume gộp cho get_features, gắn chỉ số `i` theo đúng tập nến của get_klines. */
export function summarizeVolumeAgg(agg: VolumeAggResponse, candleTimes: readonly number[], recentBars = 20): VolumeAggSummary {
  const idx = new Map(candleTimes.map((t, i) => [t, i]));
  const shares = agg.bars.filter(b => b.spot !== null && b.perp > 0).map(b => b.spot! / b.perp);
  const med = median(shares);
  const recent = agg.bars
    .filter(b => idx.has(b.time))
    .slice(-recentBars)
    .map(b => ({
      i: idx.get(b.time)!,
      time: b.time,
      perp: Math.round(b.perp * 10) / 10,
      spot: b.spot === null ? null : Math.round(b.spot * 10) / 10,
      spotShareX: b.spot !== null && b.perp > 0 && med > 0 ? Math.round((b.spot / b.perp / med) * 100) / 100 : null,
      perpComplete: b.perpComplete,
    }));
  const spikes = agg.spikes.filter(s => idx.has(s.time)).map(s => ({ i: idx.get(s.time)!, time: s.time, kind: s.kind, perpX: s.perpX, spotX: s.spotX }));
  return {
    note:
      'Volume gộp nến đã đóng: perp = Binance Futures + OKX + Bybit, spot = Binance spot (cột volume của get_klines chỉ là Binance Futures). ' +
      'Với Wyckoff: SC/BC/Spring/UTAD có đột biến SPOT hoặc BOTH đáng tin hơn đột biến chỉ PERP (thường là đòn bẩy/thanh lý).',
    spikeX: agg.spikeX,
    recent,
    spikes,
    ...(agg.notes.length ? { warnings: agg.notes } : {}),
  };
}
