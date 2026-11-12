import { describe, expect, it } from 'vitest';
import { closeTime, countdownLabel, formatCountdown, updateSkew } from '../apps/web/src/chart/countdown.ts';

describe('đếm ngược đóng nến', () => {
  it('định dạng theo thời gian còn lại', () => {
    expect(formatCountdown(42)).toBe('00:42');
    expect(formatCountdown(197.9)).toBe('03:17');
    expect(formatCountdown(2 * 3600 + 15 * 60 + 9)).toBe('02:15:09');
    expect(formatCountdown(86400 + 4 * 3600 + 12 * 60 + 30)).toBe('1d 04:12');
    expect(formatCountdown(-3)).toBe('00:00');
  });

  it('mốc đóng theo khung', () => {
    expect(closeTime(1_000_020, '1m')).toBe(1_000_080);
    expect(closeTime(0, '4h')).toBe(14_400);
    expect(closeTime(0, '1w')).toBe(604_800);
  });

  it('nhãn: đếm trong nến, 00:00 vài giây sau giờ đóng, ẩn khi quá hạn hoặc chưa có nến', () => {
    const open = 1_794_458_280; // phút chẵn
    expect(countdownLabel(open, '1m', open + 1)).toBe('00:59');
    expect(countdownLabel(open, '1m', open + 60)).toBe('00:00');
    expect(countdownLabel(open, '1m', open + 63)).toBe('00:00');
    expect(countdownLabel(open, '1m', open + 70)).toBeNull(); // không có nến mới (đóng cửa / mất kết nối)
    expect(countdownLabel(open, '4h', open + 600)).toBe('03:50:00');
    expect(countdownLabel(open, '1d', open + 3600)).toBe('23:00:00');
    expect(countdownLabel(undefined, '1m', open)).toBeNull();
    expect(countdownLabel(open, '1m', open - 120)).toBeNull(); // nến "tương lai" do lệch giờ lớn
  });

  it('lệch giờ: dưới 1 giây bỏ qua; lớn thì làm mượt', () => {
    expect(updateSkew(0, 10_300, 10_000)).toBe(0);
    expect(updateSkew(0, 15_000, 10_000)).toBe(5000);
    expect(updateSkew(5000, 16_000, 10_000)).toBe(5200);
  });
});
