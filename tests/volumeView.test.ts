import { describe, expect, it } from 'vitest';
import { spikeRatios, volumeSourceValue, type Candle, type VolumeAggBar } from '@wca/shared';
import { buildVolumeView } from '../apps/web/src/chart/volumeView.ts';
import { DEFAULT_DISPLAY, sanitizeDisplay } from '../apps/web/src/chart/displaySettings.ts';

const colors = { up: 'u', down: 'd', upSolid: 'U', downSolid: 'D' };
const candle = (time: number, volume = 100, up = true): Candle => ({ time, open: 1, high: 2, low: 0.5, close: up ? 1.5 : 0.8, volume });
const agg = (time: number, fut: number, okx: number | null, bybit: number, spot: number | null): VolumeAggBar => ({
  time,
  perp: fut + (okx ?? 0) + bybit,
  spot,
  venues: { binanceFut: fut, okx, bybit, binanceSpot: spot },
  perpComplete: okx !== null,
});

describe('lõi đột biến + giá trị theo nguồn', () => {
  it('spikeRatios: trung vị cửa sổ trước, bỏ null/0, cần đủ minBars', () => {
    const vals = [10, 10, 10, null, 0, 40];
    expect(spikeRatios(vals, 20, 3)).toEqual([null, null, null, null, 0, 4]);
    expect(spikeRatios([10, 30], 20, 3)).toEqual([null, null]);
  });

  it('volumeSourceValue: từng sàn; tổng cần đủ 4 sàn', () => {
    const b = agg(0, 50, 30, 20, 5);
    expect(volumeSourceValue(b, 'okx')).toBe(30);
    expect(volumeSourceValue(b, 'binanceSpot')).toBe(5);
    expect(volumeSourceValue(b, 'total')).toBe(105);
    expect(volumeSourceValue(agg(0, 50, null, 20, 5), 'total')).toBeNull();
  });
});

describe('buildVolumeView', () => {
  const candles = Array.from({ length: 21 }, (_, i) => candle(i * 60, 100, i % 2 === 0));
  const bars = new Map(candles.slice(0, 20).map((c, i) => [c.time, agg(c.time, 50, 30, 20, i === 19 ? 40 : 5)])); // nến 20 đang chạy, không có agg

  it('futures: như cũ (volume nến, màu trong suốt)', () => {
    const v = buildVolumeView(candles, bars, 'futures', 3, colors);
    expect(v.main[0]).toEqual({ time: 0, value: 100, color: 'u' });
    expect(v.spot).toEqual([]);
    expect(v.labels).toEqual([]);
  });

  it('nguồn đơn lẻ: cột = volume nguồn, nến đang chạy để trống, dấu đột biến theo nguồn', () => {
    const v = buildVolumeView(candles, bars, 'binanceSpot', 3, colors);
    expect(v.main[0]).toEqual({ time: 0, value: 5, color: 'u' });
    expect(v.main[20]).toEqual({ time: 1200 });
    expect(v.runningMissing).toBe(true);
    expect(v.labels).toEqual([{ time: 1140, value: 40, text: 'SP', color: '#ff9800' }]);
    // ngưỡng cao hơn bội số (8×) → không có dấu
    expect(buildVolumeView(candles, bars, 'binanceSpot', 8, colors).labels).toEqual([]);
  });

  it('gộp: cột perp màu đặc + cột perp+spot, dấu S theo ngưỡng chart', () => {
    const v = buildVolumeView(candles, bars, 'stacked', 3, colors);
    expect(v.main[0]).toEqual({ time: 0, value: 100, color: 'U' });
    expect(v.main[20]).toEqual({ time: 1200, value: 100, color: 'u' }); // nến đang chạy giữ Binance Futures
    expect(v.spot[19]).toEqual({ time: 1140, value: 140 });
    expect(v.labels).toEqual([{ time: 1140, value: 140, text: 'S', color: '#ff9800' }]);
  });
});

describe('cài đặt hiển thị', () => {
  it('sanitize: thiếu → mặc định, ngoài khoảng → kẹp, làm tròn theo bước', () => {
    expect(sanitizeDisplay(null)).toEqual(DEFAULT_DISPLAY);
    expect(sanitizeDisplay({ spikeFontPx: 99, spikeX: 3.3, heatmapOpacity: 'x', showCountdown: false })).toEqual({
      ...DEFAULT_DISPLAY,
      spikeFontPx: 14,
      spikeX: 3.5,
      showCountdown: false,
    });
  });
});
