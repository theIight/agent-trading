import { describe, expect, it } from 'vitest';
import { tradePlanSchema, type TopDownStep, type TradePlan, type tradeSetupSchema } from '@wca/shared';
import type { z } from 'zod';
import { deriveAction, validateTradePlan, type TradePlanContext } from '../apps/server/src/validate/tradePlan.ts';

const ctx: TradePlanContext = {
  lastClose: 100,
  atr: 4, // dung sai vùng entry = 1
  asOf: 1_000_000,
  minRiskReward: 2,
  scenarioNames: ['Tăng'],
  topDown: [{ tf: '1d', role: 'HTF', bias: 'BULLISH', phase: null, schematic: 'UNCLEAR', note: '' } satisfies TopDownStep],
  primaryTf: '4h',
  atrByTf: { '1m': 0.4, '5m': 1 },
};

type SetupIn = Partial<z.input<typeof tradeSetupSchema>>;

const longSetup = (over: SetupIn = {}) => ({
  name: 'Long LPS',
  direction: 'LONG' as const,
  entryType: 'MARKET' as const,
  tf: '1h' as const,
  trigger: 'LPS' as const,
  entryLow: 99,
  entryHigh: 101,
  stopLoss: 95,
  takeProfits: [120, 110],
  ...over,
});

const plan = (over: Record<string, unknown> = {}): TradePlan =>
  tradePlanSchema.parse({ decision: 'ENTER', reason: 'r', setups: [longSetup()], ...over });

function ok(p: TradePlan, c: TradePlanContext = ctx) {
  const r = validateTradePlan(p, c);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r;
}

describe('validateTradePlan', () => {
  it('LONG hợp lệ: sắp TP, R:R theo giữa vùng entry, ghi đè R:R agent', () => {
    const r = ok(plan({ setups: [longSetup({ riskReward: 9 })] }));
    const s = r.plan.setups[0]!;
    expect(s.takeProfits).toEqual([110, 120]);
    expect(s.riskReward).toBe(4); // (120-100)/(100-95)
    expect(s.riskRewardTp1).toBe(2);
    expect(r.plan.decision).toBe('ENTER');
    expect(r.warnings.join()).toMatch(/tính lại 4/);
  });

  it('SHORT hợp lệ; entryLow > entryHigh tự đảo', () => {
    const r = ok(
      plan({
        setups: [longSetup({ direction: 'SHORT', entryLow: 101, entryHigh: 99, stopLoss: 104, takeProfits: [90] })],
      }),
    );
    expect(r.plan.setups[0]).toMatchObject({ entryLow: 99, entryHigh: 101, riskReward: 2.5 });
  });

  it('sai chiều → bỏ setup, quyết định hạ cấp STAND_ASIDE kèm reconsiderWhen mặc định', () => {
    const r = ok(plan({ setups: [longSetup({ stopLoss: 102 })] }));
    expect(r.plan.setups).toHaveLength(0);
    expect(r.plan.decision).toBe('STAND_ASIDE');
    expect(r.plan.reconsiderWhen).toMatch(/R:R ≥ 2/);
    expect(r.warnings.join('\n')).toMatch(/stopLoss < entryLow/);
  });

  it('R:R < 2 → bỏ setup', () => {
    const r = ok(plan({ decision: 'WAIT_FOR_SETUP', setups: [longSetup({ takeProfits: [108] })] }));
    expect(r.plan.setups).toHaveLength(0);
    expect(r.plan.decision).toBe('STAND_ASIDE');
    expect(r.warnings.join()).toMatch(/R:R 1.6 < tối thiểu 2/);
  });

  it('giá đã vượt SL hoặc TP xa nhất → bỏ setup', () => {
    expect(ok(plan(), { ...ctx, lastClose: 94 }).plan.setups).toHaveLength(0);
    expect(ok(plan(), { ...ctx, lastClose: 121 }).plan.setups).toHaveLength(0);
  });

  it('MARKET nhưng giá không ở vùng entry → đổi LIMIT/STOP; ENTER hạ cấp WAIT_FOR_SETUP', () => {
    const r = ok(plan({ setups: [longSetup({ entryLow: 96, entryHigh: 97, stopLoss: 94, takeProfits: [110] })] }));
    expect(r.plan.setups[0]!.entryType).toBe('LIMIT');
    expect(r.plan.decision).toBe('WAIT_FOR_SETUP');

    const brk = ok(plan({ decision: 'WAIT_FOR_SETUP', setups: [longSetup({ entryType: 'LIMIT', entryLow: 103, entryHigh: 104, stopLoss: 98, takeProfits: [115] })] }));
    expect(brk.plan.setups[0]!.entryType).toBe('STOP');
    const brk2 = ok(plan({ decision: 'WAIT_FOR_SETUP', setups: [longSetup({ entryType: 'STOP', entryLow: 103, entryHigh: 104, stopLoss: 101, takeProfits: [115] })] }));
    // STOP: giá hiện tại dưới SL nghĩa là chưa kích hoạt, không phải đã vô hiệu.
    expect(brk2.plan.setups).toHaveLength(1);
  });

  it('giá trong vùng (± 0.25 ATR) → giữ MARKET; LIMIT trong vùng giữ nguyên', () => {
    const r = ok(plan({ setups: [longSetup({ entryLow: 100.5, entryHigh: 100.8 })] }));
    expect(r.plan.setups[0]!.entryType).toBe('MARKET');
    const w = ok(plan({ decision: 'WAIT_FOR_SETUP', setups: [longSetup({ entryType: 'LIMIT' })] }));
    expect(w.plan.setups[0]!.entryType).toBe('LIMIT');
  });

  it('ENTER: setup MARKET được đưa lên đầu', () => {
    const r = ok(
      plan({
        setups: [
          longSetup({ name: 'B', entryType: 'LIMIT', entryLow: 97, entryHigh: 98, stopLoss: 95, takeProfits: [110] }),
          longSetup({ name: 'A' }),
        ],
      }),
    );
    expect(r.plan.setups.map(s => s.name)).toEqual(['A', 'B']);
  });

  it('validUntil quá khứ và kịch bản không tồn tại → bỏ trường', () => {
    const r = ok(plan({ setups: [longSetup({ validUntil: 999, scenario: 'Không có' })] }));
    expect(r.plan.setups[0]!.validUntil).toBeUndefined();
    expect(r.plan.setups[0]!.scenario).toBeUndefined();
    const keep = ok(plan({ setups: [longSetup({ validUntil: 2_000_000, scenario: 'Tăng' })] }));
    expect(keep.plan.setups[0]).toMatchObject({ validUntil: 2_000_000, scenario: 'Tăng' });
  });

  it('setup ngược bias khung lớn → chỉ cảnh báo', () => {
    const r = ok(plan({ setups: [longSetup({ direction: 'SHORT', entryLow: 99, entryHigh: 101, stopLoss: 104, takeProfits: [90] })] }));
    expect(r.plan.setups).toHaveLength(1);
    expect(r.warnings.join()).toMatch(/ngược bias khung lớn 1d/);
  });

  it('STAND_ASIDE thiếu reconsiderWhen → lỗi trả về agent; có thì giữ setup tham khảo', () => {
    const bad = validateTradePlan(plan({ decision: 'STAND_ASIDE', setups: [] }), ctx);
    expect(bad.ok).toBe(false);
    const r = ok(plan({ decision: 'STAND_ASIDE', reconsiderWhen: 'Spring dưới 95' }));
    expect(r.plan.decision).toBe('STAND_ASIDE');
    expect(r.plan.setups).toHaveLength(1);
  });
});

describe('entry tinh chỉnh (SL tầng 2)', () => {
  const ref = (over: Record<string, unknown> = {}) => ({ tf: '1m', trigger: 'CHOCH', condition: 'c', stopRule: 'r', estStopDistance: 1, ...over });

  it('hợp lệ → điền ATR và R:R tinh chỉnh (giữa vùng entry); SL cấu trúc giữ nguyên', () => {
    const r = ok(plan({ setups: [longSetup({ refinedEntry: ref() })] }));
    const s = r.plan.setups[0]!;
    expect(s.stopLoss).toBe(95);
    expect(s.riskReward).toBe(4);
    expect(s.refinedEntry).toMatchObject({ atr: 0.4, estStopDistance: 1, riskReward: 20, riskRewardTp1: 10 });
  });

  it('quá chặt (< 0.5 ATR) → nâng lên 0.5 ATR', () => {
    const r = ok(plan({ setups: [longSetup({ refinedEntry: ref({ tf: '5m', estStopDistance: 0.2 }) })] }));
    expect(r.plan.setups[0]!.refinedEntry).toMatchObject({ estStopDistance: 0.5, riskReward: 40 });
    expect(r.warnings.join()).toMatch(/quá chặt/);
  });

  it('không chặt hơn SL cấu trúc / khung lớn hơn khung chính / thiếu dữ liệu → bỏ entry tinh chỉnh', () => {
    for (const over of [{ estStopDistance: 5 }, { tf: '1d' }, { tf: '15m' }]) {
      const r = ok(plan({ setups: [longSetup({ refinedEntry: ref(over) })] }));
      expect(r.plan.setups).toHaveLength(1);
      expect(r.plan.setups[0]!.refinedEntry).toBeUndefined();
    }
  });

  it('ngưỡng 2R vẫn xét theo SL cấu trúc', () => {
    const r = ok(plan({ setups: [longSetup({ takeProfits: [108], refinedEntry: ref() })] }));
    expect(r.plan.setups).toHaveLength(0);
  });
});

describe('deriveAction', () => {
  it('ENTER → LONG/SHORT của setup chính, entry = giữa vùng', () => {
    const p = ok(plan()).plan;
    expect(deriveAction(p)).toMatchObject({ type: 'LONG', entry: 100, stopLoss: 95, takeProfits: [110, 120], riskReward: 4 });
  });

  it('WAIT_FOR_SETUP → WAIT kèm mức giá dự kiến', () => {
    const p = ok(plan({ decision: 'WAIT_FOR_SETUP', setups: [longSetup({ entryType: 'LIMIT' })] })).plan;
    const a = deriveAction(p);
    expect(a).toMatchObject({ type: 'WAIT', entry: 100 });
    expect(a.condition).toMatch(/^Chờ Long LPS · LPS/);
  });

  it('STAND_ASIDE → WAIT không có mức giá, condition gồm lý do + điều kiện xem lại', () => {
    const p = ok(plan({ decision: 'STAND_ASIDE', reason: 'Nhiễu', reconsiderWhen: 'Spring dưới 95' })).plan;
    const a = deriveAction(p);
    expect(a).toMatchObject({ type: 'WAIT', takeProfits: [] });
    expect(a.entry).toBeUndefined();
    expect(a.condition).toBe('Nhiễu Xem lại khi: Spring dưới 95');
  });
});
