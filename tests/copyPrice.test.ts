import { describe, expect, it } from 'vitest';
import { clampMenuPosition, formatPriceForCopy, pricePrecision } from '../apps/web/src/chart/copyPrice.ts';

describe('copy giá từ chart', () => {
  it('định dạng số thô theo số lẻ', () => {
    expect(formatPriceForCopy(97234.4999, 1)).toBe('97234.5');
    expect(formatPriceForCopy(2650.126, 2)).toBe('2650.13');
    expect(formatPriceForCopy(1.23456, 4)).toBe('1.2346');
    expect(formatPriceForCopy(0.0000123456, 7)).toBe('0.0000123');
    expect(formatPriceForCopy(1234567.8, 1)).toBe('1234567.8');
    expect(formatPriceForCopy(-0.00001, 2)).toBe('0.00');
    expect(formatPriceForCopy(-5.5, 1)).toBe('-5.5');
  });

  it('số lẻ theo độ lớn giá hoặc cố định', () => {
    expect(pricePrecision(97000, null)).toBe(1);
    expect(pricePrecision(150, null)).toBe(2);
    expect(pricePrecision(2.5, null)).toBe(4);
    expect(pricePrecision(0.05, null)).toBe(5);
    expect(pricePrecision(0.00001, null)).toBe(7);
    expect(pricePrecision(2650, 2)).toBe(2);
  });

  it('lật menu vào trong khung ở các góc', () => {
    expect(clampMenuPosition(10, 10, 100, 50, 800, 600)).toEqual({ left: 10, top: 10 });
    expect(clampMenuPosition(750, 10, 100, 50, 800, 600)).toEqual({ left: 650, top: 10 });
    expect(clampMenuPosition(10, 580, 100, 50, 800, 600)).toEqual({ left: 10, top: 530 });
    expect(clampMenuPosition(750, 580, 100, 50, 800, 600)).toEqual({ left: 650, top: 530 });
    expect(clampMenuPosition(50, 30, 100, 50, 80, 40)).toEqual({ left: 0, top: 0 });
  });
});
