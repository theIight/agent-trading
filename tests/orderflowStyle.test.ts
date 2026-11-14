import { describe, expect, it } from 'vitest';
import { defaultHeatStops, heatColor, wallStyle } from '../apps/web/src/overlays/orderflowStyle.ts';
import { buildWallSegmentLines, type OrderflowLineItem } from '../apps/web/src/overlays/model.ts';
import { DEFAULT_DISPLAY, sanitizeDisplay } from '../apps/web/src/chart/displaySettings.ts';

const wall = (side: 'BID' | 'ASK', ratio: number, width: number): OrderflowLineItem => ({
  price: 100, color: 'old', textColor: 'oldText', label: '521', width, dashed: false, kind: 'wall', side, ratio,
});

describe('heatColor (thang Bookmap)', () => {
  it('mốc thang màu, nội suy, kẹp ngoài [0, 1]', () => {
    expect(heatColor(0.4, 1)).toBe('rgba(255,213,79,1)');
    expect(heatColor(0.6, 1)).toBe('rgba(255,152,0,1)');
    expect(heatColor(1, 0.5)).toBe('rgba(255,243,224,0.5)');
    expect(heatColor(0.5, 1)).toBe('rgba(255,183,40,1)');
    expect(heatColor(0, 1)).toBe(heatColor(0.4, 1));
    expect(heatColor(2, 1)).toBe(heatColor(1, 1));
    expect(heatColor(Number.NaN, 1)).toBe(heatColor(0.4, 1));
  });

  it('nền sáng kết thúc ở đỏ đậm (trắng nóng không thấy trên nền trắng)', () => {
    expect(heatColor(1, 1, true)).toBe('rgba(142,0,0,1)');
  });
});

describe('thang màu tự chọn', () => {
  const custom = ['#0000ff', '#00ff00', '#ffff00', '#ff0000'] as [string, string, string, string];

  it('heatColor dùng 4 mốc tự chọn (40/60/80/100%), nội suy giữa mốc', () => {
    expect(heatColor(1, 1, false, custom)).toBe('rgba(255,0,0,1)');
    expect(heatColor(0.2, 1, true, custom)).toBe('rgba(0,0,255,1)');
    expect(heatColor(0.5, 1, false, custom)).toBe('rgba(0,128,128,1)');
    expect(heatColor(1, 1, false, null)).toBe('rgba(255,243,224,1)');
  });

  it('wallStyle áp thang tự chọn; mặc định theo theme dạng hex', () => {
    const r = wallStyle(wall('ASK', 1, 6), { ofColorMode: 'bookmap', ofWidthX: 1, ofOpacity: 1, ofHeatStops: custom });
    expect(r.text).toBe('rgba(255,0,0,0.95)');
    expect(defaultHeatStops()).toEqual(['#ffd54f', '#ff9800', '#ff5722', '#fff3e0']);
    expect(defaultHeatStops(true)[3]).toBe('#8e0000');
  });

  it('sanitizeDisplay: đủ 4 hex hợp lệ mới nhận', () => {
    expect(sanitizeDisplay({ ofHeatStops: ['#0000FF', '#00ff00', '#ffff00', '#ff0000'] }).ofHeatStops).toEqual(['#0000ff', '#00ff00', '#ffff00', '#ff0000']);
    expect(sanitizeDisplay({ ofHeatStops: ['#0000ff', '#00ff00', '#ffff00'] }).ofHeatStops).toBeNull();
    expect(sanitizeDisplay({ ofHeatStops: ['#0000ff', 'red', '#ffff00', '#ff0000'] }).ofHeatStops).toBeNull();
    expect(sanitizeDisplay({}).ofHeatStops).toBeNull();
  });
});

describe('wallStyle', () => {
  const s = { ofColorMode: 'bookmap' as const, ofWidthX: 1.5, ofOpacity: 1 };

  it('bookmap: cùng ratio thì bid/ask cùng màu, nhãn có tiền tố B/A, độ dày × hệ số', () => {
    const b = wallStyle(wall('BID', 1, 6), s);
    const a = wallStyle(wall('ASK', 1, 6), s);
    expect(b.fill).toBe(a.fill);
    expect(b).toMatchObject({ fill: 'rgba(255,243,224,0.675)', text: 'rgba(255,243,224,0.95)', width: 9, label: 'B 521' });
    expect(a.label).toBe('A 521');
    expect(wallStyle(wall('BID', 0.4, 0.5), s).width).toBe(1);
  });

  it('theo phía: giữ màu chữ + nhãn cũ, dải xanh/đỏ alpha 0.3 × độ đậm', () => {
    const r = wallStyle(wall('BID', 1, 6), { ofColorMode: 'side', ofWidthX: 1, ofOpacity: 1 });
    expect(r).toEqual({ fill: 'rgba(38,166,154,0.3)', text: 'oldText', width: 6, label: '521' });
    expect(wallStyle(wall('ASK', 1, 6), { ofColorMode: 'side', ofWidthX: 1, ofOpacity: 0.5 }).fill).toBe('rgba(239,83,80,0.15)');
  });

  it('tường bị rút xám ở chế độ bookmap; POC giữ nguyên', () => {
    const [pulled] = buildWallSegmentLines([{ side: 'BID', sourcePrice: 120, price: 100, start: 1, end: 9, peakSize: 50, status: 'pulled' }]);
    expect(wallStyle(pulled!, s)).toMatchObject({ fill: 'rgba(180,180,180,0.4)', width: 1, label: '' });
    const poc: OrderflowLineItem = { price: 1, color: 'p', textColor: 'pt', label: 'POC', width: 1, dashed: true, kind: 'poc' };
    expect(wallStyle(poc, s)).toEqual({ fill: 'p', text: 'pt', width: 1, label: 'POC' });
  });

  it('model gắn side + ratio cho đoạn tường', () => {
    const lines = buildWallSegmentLines([
      { side: 'BID', sourcePrice: 120, price: 100, start: 1, end: null, peakSize: 60, status: 'active' },
      { side: 'ASK', sourcePrice: 220, price: 200, start: 1, end: null, peakSize: 30, status: 'active' },
    ]);
    expect(lines.map(l => [l.kind, l.side, l.ratio])).toEqual([['wall', 'ASK', 0.5], ['wall', 'BID', 1]]);
  });
});

describe('sanitizeDisplay: cài đặt order flow', () => {
  it('thiếu trường mới → mặc định; mode sai → bookmap; kẹp khoảng', () => {
    expect(sanitizeDisplay({ spikeX: 4 })).toMatchObject({ ofColorMode: 'bookmap', ofWidthX: 1.5, ofOpacity: 1 });
    expect(sanitizeDisplay({ ofColorMode: 'xyz' }).ofColorMode).toBe('bookmap');
    expect(sanitizeDisplay({ ofColorMode: 'side', ofWidthX: 10, ofOpacity: 0 })).toMatchObject({ ofColorMode: 'side', ofWidthX: 3, ofOpacity: 0.3 });
    expect(DEFAULT_DISPLAY.ofColorMode).toBe('bookmap');
  });
});
