import {
  analysisSubmissionSchema,
  normalizeTfInput,
  tfSeconds,
  type Candle,
  type Timeframe,
  type TfPlanEntry,
  type TopDownStep,
  type AnalysisSubmission,
  type ValidatedSubmission,
} from '@wca/shared';
import { atr } from '../features/structure.ts';
import { validateBinanceOrderflow, validateOrderflow, type BinanceOrderflowContext, type OrderflowContext } from './orderflow.ts';
import { deriveAction, validateTradePlan } from './tradePlan.ts';

// Validator kết quả agent: schema → top-down → snap time/price về nến thật → kiểm tra trade plan.
// Lỗi nghiêm trọng (schema, thiếu khung top-down) trả về cho agent để sửa; lỗi nhỏ thì tự sửa + warning.

export interface ValidationContext {
  symbol: string;
  primaryTf: Timeframe;
  plan: TfPlanEntry[];
  /** Nến đã đóng theo khung. Phải có đủ các khung agent tham chiếu. */
  candlesByTf: Partial<Record<Timeframe, readonly Candle[]>>;
  /** R:R tối thiểu của setup (mặc định 2). */
  minRiskReward?: number;
  /** Có khi phân tích kèm ảnh Bookmap: offset quy đổi + dữ liệu kiểm tra ảnh cũ. */
  bookmap?: OrderflowContext;
  /** Có khi phân tích dùng order flow Binance (server tự tính levels). */
  binance?: BinanceOrderflowContext;
}

export const DEFAULT_MIN_RR = 2;

/** Ngưỡng chống bản nộp placeholder (vd agent nộp thử "test" trước khi đọc dữ liệu). */
export const MIN_SUMMARY_CHARS = 80;
export const MIN_TOPDOWN_NOTE_CHARS = 15;
export const MIN_REASON_CHARS = 20;
const PLACEHOLDER_RE = /^(test|testing|todo|tbd|n\/?a|none|null|placeholder|x+|\.+|-+|\?+)$/i;

function placeholderErrors(s: AnalysisSubmission): string[] {
  const errs: string[] = [];
  const check = (path: string, text: string, min: number) => {
    const t = text.trim();
    if (PLACEHOLDER_RE.test(t)) errs.push(`${path}: nội dung placeholder "${t}" — viết phân tích thật`);
    else if (t.length < min) errs.push(`${path}: quá ngắn (${t.length} ký tự, cần ≥ ${min}) — nêu lý do Wyckoff cụ thể`);
  };
  check('summary', s.summary, MIN_SUMMARY_CHARS);
  s.topDown.forEach((t, i) => check(`topDown.${i}.note`, t.note, MIN_TOPDOWN_NOTE_CHARS));
  check('tradePlan.reason', s.tradePlan.reason, MIN_REASON_CHARS);
  if (s.schematic !== 'UNCLEAR' && !s.events.length) errs.push(`events: schematic ${s.schematic} cần ít nhất 1 sự kiện Wyckoff (hoặc dùng UNCLEAR)`);
  return errs;
}

export type ValidationOutcome =
  | { ok: true; value: ValidatedSubmission; warnings: string[] }
  | { ok: false; errors: string[] };

/** Ngưỡng sai lệch giá cho phép ngoài biên nến, theo bội số ATR14 của khung. */
const PRICE_EPS_ATR = 0.1;

interface TfData {
  candles: readonly Candle[];
  atr: number;
  eps: number;
  step: number;
}

function bsearch(candles: readonly Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.time <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const fmtTime = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Danh sách khung mà bản nộp tham chiếu (để caller nạp đủ nến trước khi validate). */
export function referencedTfs(raw: unknown): Timeframe[] {
  const parsed = analysisSubmissionSchema.safeParse(normalizeTfInput(raw));
  if (!parsed.success) return [];
  const s = parsed.data;
  const set = new Set<Timeframe>([s.primaryTf]);
  for (const x of [...s.events, ...s.ranges, ...s.phases]) set.add(x.tf);
  for (const st of s.tradePlan.setups) {
    set.add(st.tf);
    if (st.refinedEntry) set.add(st.refinedEntry.tf);
  }
  return [...set];
}

export function validateSubmission(raw: unknown, ctx: ValidationContext): ValidationOutcome {
  const parsed = analysisSubmissionSchema.safeParse(normalizeTfInput(raw));
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const s = structuredClone(parsed.data);
  const warnings: string[] = [];
  const errors: string[] = [...placeholderErrors(s)];

  if (s.symbol.toUpperCase() !== ctx.symbol) errors.push(`symbol phải là ${ctx.symbol}`);
  if (s.primaryTf !== ctx.primaryTf) errors.push(`primaryTf phải là ${ctx.primaryTf}`);

  // --- Top-down: đủ mọi khung đã chọn, đúng vai trò, thứ tự lớn → nhỏ.
  const planTfs = ctx.plan.map(p => p.tf);
  const missing = planTfs.filter(tf => !s.topDown.some(t => t.tf === tf));
  if (missing.length) errors.push(`topDown thiếu khung: ${missing.join(', ')} (cần đủ ${planTfs.join(' → ')})`);
  if (errors.length) return { ok: false, errors };

  const extra = s.topDown.filter(t => !planTfs.includes(t.tf));
  if (extra.length) warnings.push(`Bỏ topDown của khung không được giao: ${extra.map(t => t.tf).join(', ')}`);
  const ordered: TopDownStep[] = ctx.plan.map(p => {
    const step = s.topDown.find(t => t.tf === p.tf)!;
    if (step.role !== p.role) {
      warnings.push(`topDown ${p.tf}: sửa vai trò ${step.role} → ${p.role}`);
      return { ...step, role: p.role };
    }
    return step;
  });
  const givenOrder = s.topDown.filter(t => planTfs.includes(t.tf)).map(t => t.tf).join(',');
  if (givenOrder !== planTfs.join(',')) warnings.push(`topDown đã sắp lại theo thứ tự khung lớn → nhỏ: ${planTfs.join(' → ')}`);
  s.topDown = ordered;

  // --- Chuẩn bị dữ liệu nến theo khung.
  const data = new Map<Timeframe, TfData>();
  const tfData = (tf: Timeframe): TfData | null => {
    if (data.has(tf)) return data.get(tf)!;
    const candles = ctx.candlesByTf[tf];
    if (!candles?.length) return null;
    const a = atr(candles, 14);
    const d = { candles, atr: a, eps: a * PRICE_EPS_ATR, step: tfSeconds(tf) };
    data.set(tf, d);
    return d;
  };

  /** Snap time về open time của nến chứa nó; null nếu ngoài cửa sổ dữ liệu. */
  const snapTime = (tf: Timeframe, time: number, clampEnd = false): { time: number; index: number } | null => {
    const d = tfData(tf);
    if (!d) return null;
    const last = d.candles[d.candles.length - 1]!;
    if (time >= last.time + d.step) return clampEnd ? { time: last.time, index: d.candles.length - 1 } : null;
    const idx = bsearch(d.candles, time);
    if (idx < 0) return clampEnd ? { time: d.candles[0]!.time, index: 0 } : null;
    return { time: d.candles[idx]!.time, index: idx };
  };

  // --- Events: time khớp nến thật, price nằm trong [low-ε, high+ε].
  s.events = s.events
    .filter(ev => {
      if (!tfData(ev.tf)) {
        warnings.push(`Bỏ event ${ev.type}: không có dữ liệu khung ${ev.tf}`);
        return false;
      }
      return true;
    })
    .flatMap(ev => {
      const snapped = snapTime(ev.tf, ev.time);
      if (!snapped) {
        warnings.push(`Bỏ event ${ev.type}@${ev.tf}: thời điểm ${fmtTime(ev.time)} ngoài dữ liệu`);
        return [];
      }
      const d = tfData(ev.tf)!;
      const bar = d.candles[snapped.index]!;
      let price = ev.price;
      if (price > bar.high + d.eps || price < bar.low - d.eps) {
        const fixed = Math.abs(price - bar.high) < Math.abs(price - bar.low) ? bar.high : bar.low;
        warnings.push(`Event ${ev.type}@${ev.tf} ${fmtTime(bar.time)}: giá ${price} ngoài nến [${bar.low}, ${bar.high}] → ${fixed}`);
        price = fixed;
      }
      return [{ ...ev, time: snapped.time, price }];
    })
    .sort((a, b) => a.time - b.time);

  // --- Ranges.
  s.ranges = s.ranges.flatMap(r => {
    if (!tfData(r.tf)) {
      warnings.push(`Bỏ range "${r.label}": không có dữ liệu khung ${r.tf}`);
      return [];
    }
    let { start, end, top, bottom } = r;
    if (start > end) {
      [start, end] = [end, start];
      warnings.push(`Range "${r.label}": đảo start/end`);
    }
    if (bottom > top) {
      [top, bottom] = [bottom, top];
      warnings.push(`Range "${r.label}": đảo top/bottom`);
    }
    const st = snapTime(r.tf, start, true);
    const en = snapTime(r.tf, end, true);
    const d = tfData(r.tf)!;
    if (!st || !en || end < d.candles[0]!.time) {
      warnings.push(`Bỏ range "${r.label}": ngoài dữ liệu`);
      return [];
    }
    const out = { ...r, start: st.time, end: en.time, top, bottom };
    for (const key of ['creek', 'ice'] as const) {
      const v = out[key];
      if (v !== undefined && (v > top * 1.02 || v < bottom * 0.98)) {
        warnings.push(`Range "${r.label}": bỏ ${key}=${v} vì nằm ngoài range`);
        delete out[key];
      }
    }
    return [out];
  });

  // --- Phases.
  s.phases = s.phases
    .flatMap(p => {
      if (!tfData(p.tf)) return [];
      const [a, b] = p.start <= p.end ? [p.start, p.end] : [p.end, p.start];
      const st = snapTime(p.tf, a, true);
      const en = snapTime(p.tf, b, true);
      if (!st || !en) return [];
      return [{ ...p, start: st.time, end: en.time }];
    })
    .sort((a, b) => a.start - b.start);

  // --- Scenarios: path theo thời gian, xác suất chuẩn hoá về tổng 1.
  s.scenarios = s.scenarios.map(sc => ({ ...sc, path: [...sc.path].sort((a, b) => a.time - b.time) }));
  const total = s.scenarios.reduce((sum, sc) => sum + sc.probability, 0);
  if (s.scenarios.length && total > 0 && Math.abs(total - 1) > 0.001) {
    if (Math.abs(total - 1) > 0.05) warnings.push(`Tổng xác suất kịch bản = ${r2(total)} → chuẩn hoá về 1`);
    s.scenarios = s.scenarios.map(sc => ({ ...sc, probability: r2(sc.probability / total) }));
  }

  // --- Trade plan: chiều giá, loại lệnh, R:R tối thiểu, hạ cấp quyết định; suy ra action.
  const primary = tfData(ctx.primaryTf);
  if (!primary) return { ok: false, errors: [`Không có dữ liệu khung chính ${ctx.primaryTf} để kiểm tra trade plan`] };
  const lastBar = primary.candles[primary.candles.length - 1]!;
  if (s.action) warnings.push('Bỏ qua trường action agent gửi: server suy ra từ tradePlan');
  const tp = validateTradePlan(s.tradePlan, {
    lastClose: lastBar.close,
    atr: primary.atr,
    asOf: lastBar.time,
    minRiskReward: ctx.minRiskReward ?? DEFAULT_MIN_RR,
    scenarioNames: s.scenarios.map(sc => sc.name),
    topDown: s.topDown,
    primaryTf: ctx.primaryTf,
    atrByTf: Object.fromEntries(
      [...new Set(s.tradePlan.setups.flatMap(st => (st.refinedEntry ? [st.refinedEntry.tf] : [])))].flatMap(tf => {
        const d = tfData(tf);
        return d ? [[tf, d.atr]] : [];
      }),
    ),
  });
  if (!tp.ok) return { ok: false, errors: tp.errors };
  warnings.push(...tp.warnings);
  const value: ValidatedSubmission = { ...s, tradePlan: tp.plan, action: deriveAction(tp.plan) };

  // --- Order flow (Bookmap): quy đổi giá, lọc mức ngoài vùng giá, kiểm tra ảnh cũ. Không ảnh hưởng trade plan.
  const of = ctx.binance ? validateBinanceOrderflow(s.orderflow, ctx.binance) : validateOrderflow(s.orderflow, ctx.bookmap, primary, tp.plan.setups);
  warnings.push(...of.warnings);
  if (of.orderflow) value.orderflow = of.orderflow;
  else delete value.orderflow;

  return { ok: true, value, warnings };
}
