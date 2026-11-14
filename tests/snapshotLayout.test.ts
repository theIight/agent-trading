import { describe, expect, it } from 'vitest';
import type { AnalysisResult, Candle, TradeSetup } from '@wca/shared';
import { buildOverlayModel, makeTimeMapper, overlayPriceRange, webRightOffset, BASE_RIGHT_OFFSET, type OverlayModel } from '../apps/web/src/overlays/model.ts';
import { snapshotRange, toolStartIndex, SNAPSHOT_BARS } from '../apps/web/src/snapshotMode.ts';

const M1 = 60;
const T0 = 1_790_000_000 - (1_790_000_000 % M1);
const candles: Candle[] = Array.from({ length: 800 }, (_, i) => ({ time: T0 + i * M1, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
const lastIndex = candles.length - 1;
const last = candles[lastIndex]!;

const setup = (over: Partial<TradeSetup> = {}): TradeSetup => ({
  name: 'S', direction: 'SHORT', entryType: 'LIMIT', tf: '1m', trigger: 'LPSY', triggerNote: '',
  entryLow: 101, entryHigh: 102, stopLoss: 104, takeProfits: [95, 90], confidence: 0.6, rationale: '',
  validUntil: last.time + 360 * M1, ...over,
});

function analysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    id: 'a1', createdAt: 0, symbol: 'BTCUSDT', primaryTf: '1m', tfs: ['1h', '1m'], asOf: candles[600]!.time, warnings: [],
    schematic: 'DISTRIBUTION', currentPhase: 'B', bias: 'BEARISH', confidence: 0.6, summary: 's',
    topDown: [{ tf: '1m', role: 'PRIMARY', bias: 'BEARISH', phase: 'B', schematic: 'DISTRIBUTION', note: '' }],
    events: [], ranges: [], phases: [], levels: [], scenarios: [],
    action: { type: 'WAIT', takeProfits: [], condition: '' },
    tfConflicts: [],
    tradePlan: { decision: 'WAIT_FOR_SETUP', reason: 'r', reconsiderWhen: '', setups: [setup()] },
    ...over,
  };
}

describe('snapshotRange / toolStartIndex', () => {
  it('120 nến chiếm 60% bên trái, nến cuối ở mốc 60%', () => {
    const r = snapshotRange(lastIndex);
    const width = r.to - r.from;
    expect(width).toBeCloseTo(SNAPSHOT_BARS / 0.6);
    // Mép phải nến cuối (lastIndex + 0.5) nằm đúng mốc 60%.
    expect((lastIndex + 0.5 - r.from) / width).toBeCloseTo(0.6);
    // Nến đầu tiên hiện đủ: lastIndex − 119.
    expect(Math.ceil(r.from)).toBe(lastIndex - 119);
  });

  it('position tool bắt đầu ở nến có mép trái tại mốc 50% (phủ ~10% nến gần nhất)', () => {
    const r = snapshotRange(lastIndex);
    const idx = toolStartIndex(r);
    expect(idx).toBe(lastIndex - 19);
    expect((idx - 0.5 - r.from) / (r.to - r.from)).toBeCloseTo(0.5);
  });

  it('ít nến: chỉ số không âm', () => {
    expect(toolStartIndex(snapshotRange(5))).toBe(0);
  });
});

describe('buildOverlayModel: toolStartTime / toolEndTime', () => {
  const r = snapshotRange(lastIndex);
  const toolStartTime = candles[toolStartIndex(r)]!.time;
  const toolEndTime = last.time + Math.ceil(r.to - lastIndex) * M1;

  it('hộp setup từ mốc 50% tới mép phải, không theo validUntil', () => {
    const m = buildOverlayModel(analysis(), candles, '1m', { toolStartTime, toolEndTime });
    expect(m.rects.length).toBeGreaterThan(0);
    for (const rect of m.rects) expect(rect).toMatchObject({ t1: toolStartTime, t2: toolEndTime });
  });

  it('asOf muộn hơn mốc 50% → giữ asOf', () => {
    const m = buildOverlayModel(analysis({ asOf: last.time - 5 * M1 }), candles, '1m', { toolStartTime, toolEndTime });
    expect(m.rects[0]!.t1).toBe(last.time - 5 * M1);
  });

  it('không có option → như cũ (asOf → validUntil)', () => {
    const m = buildOverlayModel(analysis({ asOf: candles[700]!.time }), candles, '1m');
    expect(m.rects[0]).toMatchObject({ t1: candles[700]!.time, t2: last.time + 360 * M1 });
    expect(m.futureBars).toBe(360);
  });

  it('nhiều setup chia cột trong vùng 50% bên phải', () => {
    const a = analysis({
      tradePlan: { decision: 'WAIT_FOR_SETUP', reason: 'r', reconsiderWhen: '', setups: [setup(), setup({ entryLow: 97, entryHigh: 98 })] },
    });
    const m = buildOverlayModel(a, candles, '1m', { toolStartTime, toolEndTime });
    expect(Math.min(...m.rects.map(x => x.t1))).toBe(toolStartTime);
    expect(Math.max(...m.rects.map(x => x.t2))).toBeLessThanOrEqual(toolEndTime);
  });
});

describe('webRightOffset', () => {
  it('đủ chỗ cho overlay tương lai khi ngắn', () => {
    expect(webRightOffset(0, 200)).toBe(BASE_RIGHT_OFFSET);
    expect(webRightOffset(30, 200)).toBe(36);
  });
  it('validUntil xa: ≤ 40% số nến đang nhìn', () => {
    expect(webRightOffset(360, 200)).toBe(80);
  });
});

describe('overlayPriceRange', () => {
  const mapTime = makeTimeMapper(candles, '1m');
  const r = snapshotRange(lastIndex);
  const empty: Pick<OverlayModel, 'rects' | 'lines'> = { rects: [], lines: [] };

  it('điểm dự đoán xa ngoài khung nhìn không kéo giãn thang giá', () => {
    const lines = [{ points: [{ time: last.time, price: 100 }, { time: last.time + 360 * M1, price: 60 }], color: '', width: 1 }];
    expect(overlayPriceRange({ ...empty, lines }, mapTime, r.from, r.to)).toEqual({ min: 100, max: 100 });
  });

  it('hộp setup giao khung nhìn được tính, kể cả khi hai đầu nằm ngoài khung', () => {
    const rect = { t1: candles[600]!.time, t2: last.time + 500 * M1, top: 110, bottom: 90, fill: '' };
    expect(overlayPriceRange({ ...empty, rects: [rect] }, mapTime, r.from, r.to)).toEqual({ min: 90, max: 110 });
    expect(overlayPriceRange({ ...empty, rects: [{ ...rect, noAutoscale: true }] }, mapTime, r.from, r.to)).toBeNull();
  });
});
