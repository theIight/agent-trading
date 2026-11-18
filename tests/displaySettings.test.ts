import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, sanitizeDisplay, shouldCompactLevels } from '../apps/web/src/chart/displaySettings.ts';

describe('displaySettings', () => {
  it('giữ mặc định khi dữ liệu rỗng hoặc không hợp lệ', () => {
    const s = sanitizeDisplay({});
    expect(s.logScale).toBe(false);
    expect(s.compactLevels).toBe(false);
    expect(s.showCountdown).toBe(true);
    expect(s.axisFontPx).toBe(DEFAULT_DISPLAY.axisFontPx);
  });

  it('chuẩn hoá boolean logScale', () => {
    expect(sanitizeDisplay({ logScale: true }).logScale).toBe(true);
    expect(sanitizeDisplay({ logScale: false }).logScale).toBe(false);
    expect(sanitizeDisplay({ logScale: 'true' }).logScale).toBe(false);
    expect(sanitizeDisplay({ logScale: 1 }).logScale).toBe(false);
    expect(sanitizeDisplay({ logScale: null }).logScale).toBe(false);
  });

  it('chuẩn hoá boolean compactLevels', () => {
    expect(sanitizeDisplay({ compactLevels: true }).compactLevels).toBe(true);
    expect(sanitizeDisplay({ compactLevels: false }).compactLevels).toBe(false);
    expect(sanitizeDisplay({ compactLevels: 'invalid' }).compactLevels).toBe(false);
    expect(sanitizeDisplay({ compactLevels: 1 }).compactLevels).toBe(false);
  });

  it('shouldCompactLevels tự động bật trên mobile/màn hình nhỏ', () => {
    expect(shouldCompactLevels(375)).toBe(true);
    expect(shouldCompactLevels(768)).toBe(true);
    expect(shouldCompactLevels(1024)).toBe(false);
  });
});
