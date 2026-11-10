import { tfSeconds, type AnalysisResult, type Candle, type Timeframe, type TradePlan, type RefinedEntry } from '@wca/shared';

export type DemoVariant = 'wait' | 'enter' | 'aside';

/**
 * Sinh một AnalysisResult GIẢ từ dữ liệu đang hiển thị để kiểm tra renderer (mở UI với `?demo=1`).
 * Không phải phân tích thật — chỉ đặt các sự kiện ở vị trí hợp lý về hình học.
 * `?demo=1` chờ setup, `?demo=enter` vào lệnh, `?demo=aside` đứng ngoài.
 */
export function buildDemoAnalysis(
  candles: readonly Candle[],
  tf: Timeframe,
  symbol: string,
  variant: DemoVariant = 'wait',
): AnalysisResult | null {
  const n = candles.length;
  if (n < 120) return null;
  const win = candles.slice(n - 120);
  const argBy = (from: number, to: number, pick: (c: Candle) => number, cmp: (a: number, b: number) => boolean) => {
    let best = from;
    for (let i = from; i <= to; i++) if (cmp(pick(win[i]!), pick(win[best]!))) best = i;
    return best;
  };
  const sc = argBy(5, 50, c => c.low, (a, b) => a < b);
  const ar = argBy(sc + 1, Math.min(sc + 25, 100), c => c.high, (a, b) => a > b);
  const st = argBy(ar + 1, Math.min(ar + 25, 105), c => c.low, (a, b) => a < b);
  const spring = argBy(st + 1, 112, c => c.low, (a, b) => a < b);
  const at = (i: number) => win[i]!;
  const top = at(ar).high;
  const bottom = at(sc).low;
  const last = candles[n - 1]!;
  const step = tfSeconds(tf);
  const entry = last.close;
  const sl = Math.min(at(spring).low, entry * 0.985);
  const risk = entry - sl;
  const rr = (mid: number, stop: number, tp: number) => Math.round((Math.abs(tp - mid) / Math.abs(mid - stop)) * 100) / 100;

  const limitLong = {
    name: 'Long LPS hồi về', direction: 'LONG', entryType: 'LIMIT', tf, trigger: 'LPS', triggerNote: 'demo: hồi về với volume thấp',
    entryLow: entry - risk * 0.6, entryHigh: entry - risk * 0.3, stopLoss: sl - risk * 0.2,
    takeProfits: [entry + risk * 1.5, entry + risk * 3], validUntil: last.time + 15 * step, scenario: 'SOS breakout',
    confidence: 0.6, rationale: 'demo',
    refinedEntry: {
      tf: '1m' as Timeframe, trigger: 'CHOCH', condition: 'demo: Spring 1m rồi CHoCH lên, volume giảm khi test',
      stopRule: 'Dưới đáy Spring 1m + 0.3 ATR(1m)', estStopDistance: risk * 0.25, atr: risk * 0.12,
    },
  } as const;
  const stopLong = {
    name: 'Long JAC phá Creek', direction: 'LONG', entryType: 'STOP', tf, trigger: 'JAC', triggerNote: 'demo: đóng cửa trên Creek, volume tăng',
    entryLow: entry + risk * 0.5, entryHigh: entry + risk * 0.5, stopLoss: entry - risk * 0.3, takeProfits: [entry + risk * 3.5],
    confidence: 0.4, rationale: 'demo',
  } as const;
  const marketLong = {
    name: 'Long Spring test', direction: 'LONG', entryType: 'MARKET', tf, trigger: 'TEST', triggerNote: 'demo',
    entryLow: entry, entryHigh: entry, stopLoss: sl, takeProfits: [entry + risk * 1.5, entry + risk * 3], confidence: 0.6, rationale: 'demo',
  } as const;
  const withRr = <T extends { entryLow: number; entryHigh: number; stopLoss: number; takeProfits: readonly number[] }>(x: T) => {
    const mid = (x.entryLow + x.entryHigh) / 2;
    const out = { ...x, takeProfits: [...x.takeProfits], riskReward: rr(mid, x.stopLoss, x.takeProfits.at(-1)!), riskRewardTp1: rr(mid, x.stopLoss, x.takeProfits[0]!) };
    const ref = 'refinedEntry' in x ? (x.refinedEntry as RefinedEntry) : undefined;
    if (!ref) return out;
    const far = x.takeProfits.at(-1)!;
    const fake = mid - ref.estStopDistance;
    return { ...out, refinedEntry: { ...ref, riskReward: rr(mid, fake, far), riskRewardTp1: rr(mid, fake, x.takeProfits[0]!) } };
  };
  const plans: Record<DemoVariant, TradePlan> = {
    wait: { decision: 'WAIT_FOR_SETUP', reason: 'Demo: chờ LPS hồi về hoặc JAC phá Creek.', reconsiderWhen: '', setups: [withRr(limitLong), withRr(stopLong)] },
    enter: { decision: 'ENTER', reason: 'Demo: test sau Spring đã xác nhận.', reconsiderWhen: '', setups: [withRr(marketLong)] },
    aside: {
      decision: 'STAND_ASIDE', reason: 'Demo: giá giữa range Phase B, chưa có sự kiện test.',
      reconsiderWhen: 'Spring dưới đáy range rồi đóng cửa lại trong range', setups: [withRr(limitLong)],
    },
  };

  return {
    id: 'demo',
    createdAt: Date.now(),
    symbol,
    primaryTf: tf,
    tfs: [tf],
    asOf: last.time,
    model: 'demo',
    warnings: ['DỮ LIỆU DEMO — không phải phân tích thật'],
    schematic: 'ACCUMULATION',
    currentPhase: 'C',
    bias: 'BULLISH',
    confidence: 0.5,
    summary: 'Demo renderer: các sự kiện được đặt tự động theo đáy/đỉnh trong 120 nến gần nhất.',
    topDown: [{ tf, role: 'PRIMARY', bias: 'BULLISH', phase: 'C', schematic: 'ACCUMULATION', note: 'demo' }],
    events: [
      { type: 'SC', tf, time: at(sc).time, price: at(sc).low, confidence: 0.7, note: 'demo' },
      { type: 'AR', tf, time: at(ar).time, price: at(ar).high, confidence: 0.7, note: 'demo' },
      { type: 'ST', tf, time: at(st).time, price: at(st).low, confidence: 0.6, note: 'demo' },
      { type: 'SPRING', tf, time: at(spring).time, price: at(spring).low, confidence: 0.5, note: 'demo' },
    ],
    ranges: [{ tf, start: at(sc).time, end: last.time, top, bottom, label: 'TR (demo)', creek: bottom + (top - bottom) * 0.7 }],
    phases: [
      { tf, phase: 'A', start: at(sc).time, end: at(ar).time },
      { tf, phase: 'B', start: at(ar).time + step, end: at(spring).time - step },
      { tf, phase: 'C', start: at(spring).time, end: last.time },
    ],
    levels: [{ kind: 'INVALIDATION', price: sl, note: 'demo' }],
    scenarios: [
      {
        name: 'SOS breakout', probability: 0.6, bias: 'BULLISH',
        path: [{ time: last.time, price: entry }, { time: last.time + 8 * step, price: top }, { time: last.time + 20 * step, price: top + (top - bottom) * 0.5 }],
        trigger: 'demo', invalidation: sl, note: '',
      },
      {
        name: 'Thủng range', probability: 0.4, bias: 'BEARISH',
        path: [{ time: last.time, price: entry }, { time: last.time + 10 * step, price: bottom * 0.99 }],
        trigger: 'demo', invalidation: top, note: '',
      },
    ],
    tradePlan: plans[variant],
    action: { type: 'WAIT', takeProfits: [], condition: 'demo' },
    tfConflicts: [],
  };
}
