import { describe, expect, it } from 'vitest';
import type { AnalysisResult, Candle, TradePlan, TradeSetup } from '@wca/shared';
import { buildOverlayModel, layoutLabels, makeTimeMapper, snapToBar, ALL_LAYERS_ON, LABEL_HEIGHT, MIN_TOOL_BARS } from '../apps/web/src/overlays/model.ts';

const H4 = 14400;
const T0 = 1_790_000_000 - (1_790_000_000 % H4);
const candles: Candle[] = Array.from({ length: 50 }, (_, i) => ({
  time: T0 + i * H4,
  open: 100,
  high: 110,
  low: 90,
  close: 105,
  volume: 1,
}));
const last = candles[49]!;

function analysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    id: 'a1', createdAt: 0, symbol: 'BTCUSDT', primaryTf: '4h', tfs: ['1d', '4h', '5m'], asOf: last.time, warnings: [],
    schematic: 'ACCUMULATION', currentPhase: 'C', bias: 'BULLISH', confidence: 0.6, summary: 's',
    topDown: [{ tf: '4h', role: 'PRIMARY', bias: 'BULLISH', phase: 'C', schematic: 'ACCUMULATION', note: '' }],
    events: [], ranges: [], phases: [], levels: [], scenarios: [],
    action: { type: 'WAIT', takeProfits: [], condition: '' },
    tfConflicts: [],
    ...over,
  };
}

describe('makeTimeMapper', () => {
  const map = makeTimeMapper(candles, '4h');
  it('trả chỉ số nến trong dữ liệu', () => {
    expect(map(T0)).toBe(0);
    expect(map(T0 + 10 * H4)).toBe(10);
    expect(map(T0 + 10 * H4 + H4 / 2)).toBeCloseTo(10.5);
  });
  it('ngoại suy tương lai và quá khứ', () => {
    expect(map(last.time + 5 * H4)).toBe(54);
    expect(map(T0 - 2 * H4)).toBe(-2);
  });
});

describe('snapToBar', () => {
  it('snap thời điểm giữa nến về open time; ngoài dữ liệu → null', () => {
    expect(snapToBar(candles, '4h', T0 + 3 * H4 + 100)).toBe(T0 + 3 * H4);
    expect(snapToBar(candles, '4h', T0 - 1)).toBeNull();
    expect(snapToBar(candles, '4h', last.time + H4)).toBeNull();
  });
});

describe('buildOverlayModel', () => {
  it('rỗng khi chưa có phân tích', () => {
    expect(buildOverlayModel(null, candles, '4h').markers).toEqual([]);
  });

  it('marker: vị trí theo giá so với thân nến, nhãn khung khác, ẩn sự kiện khung nhỏ hơn', () => {
    const m = buildOverlayModel(
      analysis({
        events: [
          { type: 'SC', tf: '4h', time: T0 + 5 * H4, price: 90, confidence: 0.8, note: '' },
          { type: 'BC', tf: '1d', time: T0 + 6 * H4, price: 110, confidence: 0.8, note: '' },
          { type: 'SPRING', tf: '5m', time: T0 + 7 * H4, price: 91, confidence: 0.8, note: '' },
        ],
      }),
      candles,
      '4h',
    );
    expect(m.markers).toHaveLength(2);
    expect(m.markers[0]).toMatchObject({ text: 'SC', position: 'belowBar', shape: 'arrowUp' });
    expect(m.markers[1]).toMatchObject({ text: 'BC·1D', position: 'aboveBar', shape: 'arrowDown' });

    const all = buildOverlayModel(
      analysis({ events: [{ type: 'SPRING', tf: '5m', time: T0 + 7 * H4 + 300, price: 91, confidence: 0.8, note: '' }] }),
      candles,
      '4h',
      { showLowerTfItems: true },
    );
    expect(all.markers[0]).toMatchObject({ time: T0 + 7 * H4, text: 'SPRING·5m' });
  });

  it('bản ghi cũ (không có tradePlan): công cụ Long từ action', () => {
    const m = buildOverlayModel(
      analysis({ action: { type: 'LONG', entry: 100, stopLoss: 95, takeProfits: [105, 115], riskReward: 3, condition: '' } }),
      candles,
      '4h',
      { positionToolBars: 20 },
    );
    expect(m.rects).toHaveLength(2);
    expect(m.rects[0]).toMatchObject({ top: 115, bottom: 100 });
    expect(m.rects[1]).toMatchObject({ top: 100, bottom: 95 });
    expect(m.lines.map(l => l.label)).toEqual(['Entry 100', 'TP1']);
    expect(m.futureBars).toBe(20);
  });

  describe('trade plan', () => {
    const setup = (over: Partial<TradeSetup> = {}): TradeSetup => ({
      name: 'S', direction: 'LONG', entryType: 'MARKET', tf: '4h', trigger: 'LPS', triggerNote: '',
      entryLow: 100, entryHigh: 100, stopLoss: 95, takeProfits: [105, 115], confidence: 0.6, rationale: '', riskReward: 3, ...over,
    });
    const withPlan = (plan: Partial<TradePlan>) =>
      analysis({ tradePlan: { decision: 'ENTER', reason: 'r', reconsiderWhen: '', setups: [setup()], ...plan } });

    it('ENTER + MARKET: công cụ Long nét liền, không có viền', () => {
      const m = buildOverlayModel(withPlan({}), candles, '4h', { positionToolBars: 20 });
      expect(m.rects).toHaveLength(2);
      expect(m.rects[0]).toMatchObject({ top: 115, bottom: 100, dashed: false });
      expect(m.rects[0]!.stroke).toBeUndefined();
      expect(m.futureBars).toBe(20);
    });

    it('setup chờ: nét đứt, vùng entry, kéo tới validUntil', () => {
      const m = buildOverlayModel(
        withPlan({ decision: 'WAIT_FOR_SETUP', setups: [setup({ entryType: 'LIMIT', entryLow: 98, entryHigh: 100, stopLoss: 94, validUntil: last.time + 15 * H4 })] }),
        candles,
        '4h',
      );
      expect(m.rects).toHaveLength(3);
      expect(m.rects.every(r => r.dashed)).toBe(true);
      expect(m.rects[0]!.label).toMatch(/^Chờ hồi LPS · LONG/);
      expect(m.rects[2]).toMatchObject({ top: 100, bottom: 98 });
      expect(m.futureBars).toBe(15);
    });

    it('STAND_ASIDE: không vẽ, trừ khi bật setup tham khảo', () => {
      const a = withPlan({ decision: 'STAND_ASIDE', reconsiderWhen: 'x' });
      expect(buildOverlayModel(a, candles, '4h').rects).toHaveLength(0);
      const ref = buildOverlayModel(a, candles, '4h', { showReferenceSetups: true });
      expect(ref.rects[0]!.label).toMatch(/^Tham khảo/);
    });

    it('entry tinh chỉnh: đường SL ước lượng tại giữa vùng entry ∓ khoảng cách', () => {
      const ref = { tf: '1m' as const, trigger: 'CHOCH' as const, condition: '', stopRule: '', estStopDistance: 1.5 };
      const m = buildOverlayModel(withPlan({ setups: [setup({ entryLow: 99, entryHigh: 101, refinedEntry: ref })] }), candles, '4h');
      const line = m.lines.find(l => l.label?.startsWith('SL 1m ≈'));
      expect(line?.points[0]!.price).toBe(98.5);
      const short = buildOverlayModel(
        withPlan({ setups: [setup({ direction: 'SHORT', stopLoss: 105, takeProfits: [85], refinedEntry: ref })] }),
        candles,
        '4h',
      );
      expect(short.lines.find(l => l.label?.startsWith('SL 1m'))?.points[0]!.price).toBe(101.5);
      expect(buildOverlayModel(withPlan({}), candles, '4h').lines.some(l => l.label?.startsWith('SL '))).toBe(false);
    });

    it('độ rộng tối thiểu MIN_TOOL_BARS nến dù validUntil gần', () => {
      const m = buildOverlayModel(
        withPlan({ decision: 'WAIT_FOR_SETUP', setups: [setup({ entryType: 'LIMIT', validUntil: last.time + 2 * H4 })] }),
        candles,
        '4h',
      );
      expect(m.rects[0]!.t1).toBe(last.time);
      expect(m.rects[0]!.t2 - m.rects[0]!.t1).toBe(MIN_TOOL_BARS * H4);
    });

    it('2 setup: 2 cột không giao nhau, setup chính bên trái, mỗi cột ≥ MIN_TOOL_BARS nến', () => {
      const a = withPlan({
        decision: 'WAIT_FOR_SETUP',
        setups: [
          setup({ direction: 'SHORT', entryType: 'LIMIT', stopLoss: 105, takeProfits: [90, 85], validUntil: last.time + 6 * H4 }),
          setup({ direction: 'SHORT', entryType: 'STOP', stopLoss: 103, takeProfits: [85], validUntil: last.time + 6 * H4 }),
        ],
      });
      const m = buildOverlayModel(a, candles, '4h');
      const tp = m.rects.filter(r => r.label?.startsWith('Chờ'));
      expect(tp).toHaveLength(2);
      expect(tp[0]!.label).toMatch(/^Chờ hồi/);
      expect(tp[0]!.t1).toBe(last.time);
      expect(tp[0]!.t2).toBeLessThan(tp[1]!.t1);
      for (const r of tp) expect(r.t2 - r.t1).toBeGreaterThanOrEqual(MIN_TOOL_BARS * H4);
      // Đường TP trung gian theo cột của setup.
      const tp1 = m.lines.find(l => l.label === 'TP1')!;
      expect(tp1.points[0]!.time).toBe(tp[0]!.t1);
      expect(m.futureBars).toBe(Math.ceil((tp[1]!.t2 - last.time) / H4));
    });

    it('chọn 1 setup chỉ vẽ setup đó', () => {
      const a = withPlan({ decision: 'WAIT_FOR_SETUP', setups: [setup({ entryType: 'LIMIT' }), setup({ direction: 'SHORT', entryType: 'STOP', stopLoss: 105, takeProfits: [85] })] });
      expect(buildOverlayModel(a, candles, '4h').rects).toHaveLength(4);
      const one = buildOverlayModel(a, candles, '4h', { selectedSetup: 1 });
      expect(one.rects).toHaveLength(2);
      expect(one.rects[0]).toMatchObject({ top: 100, bottom: 85, t1: last.time });
    });
  });

  describe('layoutLabels', () => {
    const overlap = (a: { l: number; r: number; y: number }, b: { l: number; r: number; y: number }) =>
      a.l < b.r && a.r > b.l && Math.abs(a.y - b.y) < LABEL_HEIGHT;

    it('nhãn trùng vị trí được giãn ra, không còn đè', () => {
      const labels = [
        { x: 10, y: 100, width: 200, align: 'left' as const },
        { x: 10, y: 100, width: 220, align: 'left' as const },
        { x: 50, y: 104, width: 30, align: 'left' as const },
      ];
      const ys = layoutLabels(labels);
      expect(ys[0]).toBe(100);
      const boxes = labels.map((l, i) => ({ l: l.x, r: l.x + l.width, y: ys[i]! }));
      expect(overlap(boxes[0]!, boxes[1]!)).toBe(false);
      expect(overlap(boxes[0]!, boxes[2]!)).toBe(false);
      expect(overlap(boxes[1]!, boxes[2]!)).toBe(false);
    });

    it('không đụng nhãn không giao theo chiều ngang', () => {
      expect(layoutLabels([
        { x: 10, y: 100, width: 50, align: 'left' },
        { x: 200, y: 100, width: 50, align: 'right' },
      ])).toEqual([100, 100]);
    });
  });

  it('kịch bản: sắp theo xác suất, nét đậm cho kịch bản chính', () => {
    const m = buildOverlayModel(
      analysis({
        scenarios: [
          { name: 'B', probability: 0.3, bias: 'BEARISH', path: [{ time: last.time, price: 100 }, { time: last.time + 10 * H4, price: 80 }], trigger: '', invalidation: 110, note: '' },
          { name: 'A', probability: 0.7, bias: 'BULLISH', path: [{ time: last.time, price: 100 }, { time: last.time + 30 * H4, price: 130 }], trigger: '', invalidation: 90, note: '' },
        ],
      }),
      candles,
      '4h',
    );
    expect(m.lines[0]).toMatchObject({ label: 'A 70%', width: 2.5 });
    expect(m.lines[1]).toMatchObject({ label: 'B 30%', width: 1.5 });
    expect(m.futureBars).toBe(30);
  });

  it('tắt layer thì không sinh phần tử tương ứng', () => {
    const m = buildOverlayModel(
      analysis({
        events: [{ type: 'SC', tf: '4h', time: T0, price: 90, confidence: 1, note: '' }],
        ranges: [{ tf: '4h', start: T0, end: T0 + 10 * H4, top: 110, bottom: 90, label: 'TR', creek: 105 }],
        levels: [{ kind: 'ICE', price: 92, note: '' }],
      }),
      candles,
      '4h',
      { layers: { ...ALL_LAYERS_ON, events: false, levels: false } },
    );
    expect(m.markers).toHaveLength(0);
    expect(m.priceLines).toHaveLength(0);
    expect(m.rects).toHaveLength(1);
    expect(m.lines.map(l => l.label)).toEqual(['Creek']);
  });
});

describe('layer Order flow (Bookmap)', () => {
  const orderflow: AnalysisResult['orderflow'] = {
    lastPrices: [],
    summary: 'Hấp thụ ở đáy',
    cvd: '',
    offset: 10,
    levels: [
      { kind: 'ASK_WALL', image: 'htf', bookmapPrice: 4078, price: 4068, size: 77, sizeSource: 'COB', strength: 0.8, note: '' },
      { kind: 'BID_WALL', image: 'htf', bookmapPrice: 4060, price: 4050, size: 30, sizeSource: 'COB', strength: 0.5, note: '' },
      { kind: 'POC', image: 'ltf', bookmapPrice: 4054.5, price: 4044.5, size: 8135, sizeSource: 'SVP', strength: 0.7, note: '' },
      { kind: 'ABSORPTION', image: 'ltf', bookmapPrice: 4055, price: 4045, strength: 0.6, note: '' },
    ],
  };

  it('vẽ price line tím kèm khối lượng; độ dày so trong cùng ảnh + nguồn', () => {
    const m = buildOverlayModel(analysis({ symbol: 'XAUUSD', orderflow }), candles, '4h');
    const bm = m.priceLines.filter(p => p.title.startsWith('BM'));
    expect(bm.map(p => [p.title, p.price, p.width])).toEqual([
      ['BM Tường bán · 77 lot', 4068, 3],
      ['BM Tường mua · 30 lot', 4050, 1],
      ['BM POC · 8135 lot', 4044.5, 3],
      ['BM Hấp thụ', 4045, 1],
    ]);
  });

  it('tắt layer hoặc không có orderflow → không vẽ', () => {
    const off = buildOverlayModel(analysis({ symbol: 'XAUUSD', orderflow }), candles, '4h', { layers: { ...ALL_LAYERS_ON, orderflow: false } });
    expect(off.priceLines.some(p => p.title.startsWith('BM'))).toBe(false);
    expect(buildOverlayModel(analysis(), candles, '4h').priceLines.some(p => p.title.startsWith('BM'))).toBe(false);
  });
});
