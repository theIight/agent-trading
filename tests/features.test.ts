import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Candle } from '@wca/shared';
import {
  atr,
  atrSeries,
  computeFeatures,
  detectStructureBreaks,
  detectTrend,
  findClimaxBars,
  findRangeCandidates,
  findSwings,
  priorVolumeSma,
} from '../apps/server/src/features/index.ts';

const load = <T>(name: string): T => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
const btc4h = load<Candle[]>('btcusdt-4h.json');

interface Expected {
  swings: { index: number; type: string; price: number; label: string | null }[];
  trend: string;
  breaks: { type: string; direction: string; index: number; level: number }[];
  state: string | null;
  atr14: number;
}
// Kết quả của code gốc pumping-token-detect/src/indicators/marketStructure.js trên cùng fixture.
const expected = load<Expected>('btcusdt-4h.expected-structure.json');

describe('structure (khớp code gốc pumping-token-detect)', () => {
  const swings = findSwings(btc4h, 2, 2);

  it('swings + nhãn HH/HL/LH/LL', () => {
    expect(swings.map(s => ({ index: s.index, type: s.type, price: s.price, label: s.label }))).toEqual(expected.swings);
  });

  it('trend, BOS/CHoCH, ATR14', () => {
    expect(detectTrend(swings)).toBe(expected.trend);
    const { breaks, state } = detectStructureBreaks(btc4h, swings);
    expect(breaks.map(b => ({ type: b.type, direction: b.direction, index: b.index, level: b.level }))).toEqual(expected.breaks);
    expect(state).toBe(expected.state);
    expect(atr(btc4h, 14)).toBeCloseTo(expected.atr14, 6);
  });
});

describe('series helpers', () => {
  const flat: Candle[] = Array.from({ length: 30 }, (_, i) => ({ time: i, open: 10, high: 11, low: 9, close: 10, volume: i + 1 }));

  it('priorVolumeSma không gồm nến hiện tại', () => {
    const sma = priorVolumeSma(flat, 20);
    expect(sma[19]).toBe(0);
    expect(sma[20]).toBeCloseTo((1 + 20) / 2); // TB volume 1..20
    expect(sma[25]).toBeCloseTo((6 + 25) / 2);
  });

  it('atrSeries khớp atr tại nến cuối', () => {
    expect(atrSeries(btc4h, 14).at(-1)).toBeCloseTo(atr(btc4h, 14), 6);
  });
});

describe('wyckoff hints', () => {
  // Kịch bản tổng hợp: giảm → nến SC volume lớn → AR → đi ngang có Spring → còn active.
  const synth: Candle[] = [];
  let t = 0;
  const push = (o: number, h: number, l: number, c: number, v: number) => synth.push({ time: (t += 3600), open: o, high: h, low: l, close: c, volume: v });
  for (let i = 0; i < 25; i++) push(200 - i * 2, 201 - i * 2, 197 - i * 2, 198 - i * 2, 100); // downtrend
  push(150, 151, 120, 135, 600); // SC: volume 6x, spread lớn, đóng xa đáy
  push(135, 142, 133, 140, 250);
  push(140, 150, 139, 148, 200);
  push(148, 155, 146, 150, 180); // AR đỉnh 155
  push(150, 152, 140, 142, 120);
  push(142, 145, 136, 138, 110);
  for (let i = 0; i < 6; i++) push(138, 146, 130, 140, 80); // range
  push(138, 140, 118, 128, 90); // Spring: thủng 120, đóng lại trong range
  for (let i = 0; i < 4; i++) push(130, 145, 128, 142, 70);

  it('phát hiện SC là climax cực trị', () => {
    const cx = findClimaxBars(synth).filter(c => c.isExtreme);
    expect(cx.map(c => c.index)).toContain(25);
    const sc = cx.find(c => c.index === 25)!;
    expect(sc.direction).toBe('DOWN');
    expect(sc.volRatio).toBeGreaterThan(4);
  });

  it('dựng range sau SC, ghi nhận probe dưới đáy và volume cạn', () => {
    const swings = findSwings(synth, 2, 2);
    const ranges = findRangeCandidates(synth, swings, findClimaxBars(synth));
    expect(ranges).toHaveLength(1);
    const r = ranges[0]!;
    expect(r).toMatchObject({ kind: 'AFTER_SC', climaxIndex: 25, top: 155, bottom: 120, status: 'ACTIVE' });
    expect(r.probesBelow).toContain(37);
    expect(r.volumeDryUpRatio).toBeLessThan(1);
  });

  it('computeFeatures trên BTC 4h trả cấu trúc gọn, chỉ số hợp lệ', () => {
    const f = computeFeatures(btc4h, '4h');
    expect(f.bars).toBe(300);
    expect(f.swings.length).toBeLessThanOrEqual(40);
    expect(f.breaks.length).toBeLessThanOrEqual(15);
    for (const s of f.swings) expect(btc4h[s.i]!.time).toBe(s.time);
    for (const r of f.rangeCandidates) expect(r.top).toBeGreaterThan(r.bottom);
    expect(JSON.stringify(f).length).toBeLessThan(30_000);
  });

  it('nến volume 0 (không có dữ liệu) bị bỏ qua khi tính SMA volume và climax', async () => {
    const { priorVolumeSma } = await import('../apps/server/src/features/structure.ts');
    const { findClimaxBars } = await import('../apps/server/src/features/wyckoffHints.ts');
    const bars = Array.from({ length: 40 }, (_, i) => ({ time: i * 3600, open: 100, high: 101, low: 99, close: 100, volume: i < 25 ? 0 : 10 }));
    const sma = priorVolumeSma(bars, 20);
    expect(sma[24]).toBe(0); // cửa sổ toàn nến không có volume
    expect(sma[39]).toBe(10); // chỉ tính nến có volume
    // Nến đầu tiên có volume không bị coi là climax chỉ vì so với nến volume 0.
    expect(findClimaxBars(bars).length).toBe(0);
  });
});
