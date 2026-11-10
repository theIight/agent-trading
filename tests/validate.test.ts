import { describe, expect, it } from 'vitest';
import { buildTfPlan, type AnalysisSubmissionInput, type Candle, type TfPlanEntry } from '@wca/shared';
import { validateSubmission, referencedTfs, type ValidationContext } from '../apps/server/src/validate/index.ts';

const H4 = 14400;
const D1 = 86400;
const T0 = 1_790_000_000 - (1_790_000_000 % D1);

const mk = (step: number, n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ time: T0 + i * step, open: 100, high: 110, low: 90, close: 100, volume: 1 }));

const c4h = mk(H4, 60);
const c1d = mk(D1, 30);
const plan = (buildTfPlan('4h', ['1d']) as { ok: true; plan: TfPlanEntry[] }).plan;
const ctx: ValidationContext = { symbol: 'BTCUSDT', primaryTf: '4h', plan, candlesByTf: { '4h': c4h, '1d': c1d } };

function base(over: Partial<AnalysisSubmissionInput> = {}): AnalysisSubmissionInput {
  return {
    symbol: 'BTCUSDT',
    primaryTf: '4h',
    schematic: 'ACCUMULATION',
    currentPhase: 'C',
    bias: 'BULLISH',
    confidence: 0.6,
    summary: 'Tích luỹ 4H sau SC, Spring đã test với volume thấp; khung 1D vẫn trong range lớn, ưu tiên chờ SOS xác nhận.',
    topDown: [
      { tf: '1d', role: 'HTF', bias: 'BULLISH', note: 'Range lớn, đáy SC giữ vững' },
      { tf: '4h', role: 'PRIMARY', bias: 'BULLISH', note: 'Spring + test volume thấp' },
    ],
    events: [{ type: 'SC', tf: '4h', time: T0 + 2 * H4, price: 91 }],
    tradePlan: { decision: 'STAND_ASIDE', reason: 'Chưa có SOS xác nhận, đứng ngoài', reconsiderWhen: 'chờ' },
    ...over,
  };
}

function ok(raw: unknown) {
  const r = validateSubmission(raw, ctx);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r;
}

describe('validateSubmission', () => {
  it('lỗi schema trả về đường dẫn trường để agent sửa', () => {
    const r = validateSubmission({ ...base(), confidence: 2, events: [{ type: 'XYZ' }] }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some(e => e.startsWith('confidence'))).toBe(true);
      expect(r.errors.some(e => e.startsWith('events.0'))).toBe(true);
    }
  });

  it('sai symbol / primaryTf / thiếu khung top-down → lỗi', () => {
    expect(validateSubmission(base({ symbol: 'ETHUSDT' }), ctx).ok).toBe(false);
    expect(validateSubmission(base({ primaryTf: '1h' }), ctx).ok).toBe(false);
    const r = validateSubmission(base({ topDown: [{ tf: '4h', role: 'PRIMARY', bias: 'BULLISH', note: 'Spring + test volume thấp' }] }), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/topDown thiếu khung: 1d/);
  });

  it('top-down sai thứ tự / sai vai trò → tự sửa + warning', () => {
    const r = ok(
      base({
        topDown: [
          { tf: '4h', role: 'HTF', bias: 'BULLISH', note: 'Spring + test volume thấp' },
          { tf: '1d', role: 'HTF', bias: 'BEARISH', note: 'Range lớn, đáy SC giữ vững' },
        ],
      }),
    );
    expect(r.value.topDown.map(t => [t.tf, t.role])).toEqual([['1d', 'HTF'], ['4h', 'PRIMARY']]);
    expect(r.warnings.join('\n')).toMatch(/sắp lại/);
    expect(r.warnings.join('\n')).toMatch(/sửa vai trò/);
  });

  it('event: snap time về open time, giá ngoài nến → snap về high/low, ngoài dữ liệu → bỏ', () => {
    const r = ok(
      base({
        events: [
          { type: 'SC', tf: '4h', time: T0 + 5 * H4 + 1234, price: 91 },
          { type: 'AR', tf: '4h', time: T0 + 6 * H4, price: 150 },
          { type: 'ST', tf: '4h', time: T0 + 999 * H4, price: 95 },
          { type: 'BC', tf: '1h', time: T0, price: 100 },
        ],
      }),
    );
    expect(r.value.events).toHaveLength(2);
    expect(r.value.events[0]).toMatchObject({ type: 'SC', time: T0 + 5 * H4, price: 91 });
    expect(r.value.events[1]).toMatchObject({ type: 'AR', price: 110 });
    expect(r.warnings.length).toBe(3);
  });

  it('range: đảo top/bottom, clamp end, bỏ creek ngoài range', () => {
    const r = ok(base({ ranges: [{ tf: '4h', start: T0 + H4, end: T0 + 999 * H4, top: 90, bottom: 110, creek: 200 }] }));
    expect(r.value.ranges[0]).toMatchObject({ top: 110, bottom: 90, end: c4h.at(-1)!.time });
    expect(r.value.ranges[0]!.creek).toBeUndefined();
  });

  it('xác suất kịch bản chuẩn hoá về 1, path sắp theo thời gian', () => {
    const last = c4h.at(-1)!.time;
    const r = ok(
      base({
        scenarios: [
          { name: 'A', probability: 0.8, bias: 'BULLISH', path: [{ time: last + 5 * H4, price: 120 }, { time: last, price: 100 }], invalidation: 90 },
          { name: 'B', probability: 0.8, bias: 'BEARISH', path: [{ time: last, price: 100 }, { time: last + 5 * H4, price: 80 }], invalidation: 110 },
        ],
      }),
    );
    expect(r.value.scenarios.map(s => s.probability)).toEqual([0.5, 0.5]);
    expect(r.value.scenarios[0]!.path[0]!.time).toBe(last);
  });

  it('trade plan: dùng giá đóng cửa / ATR khung chính, suy ra action', () => {
    // Nến 4h: close 100, ATR 20 → dung sai vùng entry 5.
    const setup = { name: 'Long LPS', direction: 'LONG', entryType: 'MARKET', tf: '1h', trigger: 'LPS', entryLow: 97, entryHigh: 99, stopLoss: 93, takeProfits: [115] } as const;
    const r = ok(base({ tradePlan: { decision: 'ENTER', reason: 'LPS xác nhận trên khung nhỏ', setups: [setup] } }));
    expect(r.value.tradePlan.setups[0]).toMatchObject({ entryType: 'MARKET', riskReward: 3.4 });
    expect(r.value.action).toMatchObject({ type: 'LONG', entry: 98, stopLoss: 93, riskReward: 3.4 });

    const far = ok(base({ tradePlan: { decision: 'ENTER', reason: 'LPS xác nhận trên khung nhỏ', setups: [{ ...setup, entryLow: 90, entryHigh: 91, stopLoss: 85, takeProfits: [120] }] } }));
    expect(far.value.tradePlan.decision).toBe('WAIT_FOR_SETUP');
    expect(far.value.action.type).toBe('WAIT');
  });

  it('entry tinh chỉnh: ATR lấy từ nến khung tinh chỉnh; referencedTfs gồm khung đó', () => {
    // Nến 1h giả: high-low = 4 → ATR 4; SL cấu trúc cách giữa vùng 98 là 5.
    const c1h = mk(3600, 100).map(c => ({ ...c, high: 102, low: 98 }));
    const setup = {
      name: 'Long LPS', direction: 'LONG', entryType: 'MARKET', tf: '1h', trigger: 'LPS', entryLow: 97, entryHigh: 99, stopLoss: 93, takeProfits: [115],
      refinedEntry: { tf: '1h', trigger: 'CHOCH', condition: 'c', stopRule: 'r', estStopDistance: 2.5 },
    } as const;
    const raw = base({ tradePlan: { decision: 'ENTER', reason: 'LPS xác nhận trên khung nhỏ', setups: [setup] } });
    expect(referencedTfs(raw).sort()).toEqual(['1h', '4h']);
    const r = validateSubmission(raw, { ...ctx, candlesByTf: { ...ctx.candlesByTf, '1h': c1h } });
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.value.tradePlan.setups[0]!.refinedEntry).toMatchObject({ atr: 4, estStopDistance: 2.5, riskReward: 6.8 });
  });

  it('STAND_ASIDE thiếu reconsiderWhen → lỗi; action agent gửi bị bỏ qua', () => {
    expect(validateSubmission(base({ tradePlan: { decision: 'STAND_ASIDE', reason: 'Chưa có SOS xác nhận, đứng ngoài' } }), ctx).ok).toBe(false);
    const r = ok(base({ action: { type: 'LONG', entry: 100, stopLoss: 95, takeProfits: [110] } }));
    expect(r.value.action.type).toBe('WAIT');
    expect(r.warnings.join()).toMatch(/Bỏ qua trường action/);
  });

  it('thiếu tradePlan → lỗi schema', () => {
    const { tradePlan: _tp, ...rest } = base();
    const r = validateSubmission(rest, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/tradePlan/);
  });

  it('chặn bản nộp placeholder: báo đủ mọi lỗi trong 1 lần', () => {
    const r = validateSubmission(
      base({
        summary: 'test',
        topDown: [
          { tf: '1d', role: 'HTF', bias: 'BULLISH', note: 'todo' },
          { tf: '4h', role: 'PRIMARY', bias: 'BULLISH', note: 'ngắn' },
        ],
        events: [],
        tradePlan: { decision: 'STAND_ASIDE', reason: 'chưa rõ', reconsiderWhen: 'y' },
      }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const all = r.errors.join('\n');
      expect(all).toMatch(/summary: nội dung placeholder "test"/);
      expect(all).toMatch(/topDown.0.note: nội dung placeholder "todo"/);
      expect(all).toMatch(/topDown.1.note: quá ngắn/);
      expect(all).toMatch(/tradePlan.reason: quá ngắn/);
      expect(all).toMatch(/events: schematic ACCUMULATION cần ít nhất 1 sự kiện/);
    }
    // UNCLEAR được phép không có sự kiện.
    expect(validateSubmission(base({ schematic: 'UNCLEAR', events: [] }), ctx).ok).toBe(true);
  });

  it('chuẩn hoá khung chữ hoa (1D, 4H); 1M vẫn lỗi', () => {
    const r = validateSubmission(
      { ...base(), primaryTf: '4H', topDown: base().topDown!.map(t => ({ ...t, tf: t.tf.toUpperCase() })), events: [{ type: 'SC', tf: '4H', time: T0 + 2 * H4, price: 91 }] },
      ctx,
    );
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.value.primaryTf).toBe('4h');
    expect(r.value.events[0]!.tf).toBe('4h');
    expect(validateSubmission({ ...base(), events: [{ type: 'SC', tf: '1M', time: T0, price: 91 }] }, ctx).ok).toBe(false);
  });

  it('referencedTfs liệt kê khung cần nạp nến', () => {
    expect(referencedTfs(base({ events: [{ type: 'SC', tf: '5m', time: T0, price: 1 }] })).sort()).toEqual(['4h', '5m']);
  });
});
