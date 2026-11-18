import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TITLE, formatTabTitle, TabTitleController, type DailyRef } from '../apps/web/src/chart/tabTitle.ts';

describe('formatTabTitle', () => {
  it('symbol + giá theo precision, phân cách nghìn', () => {
    expect(formatTabTitle({ symbol: 'BTCUSDT', price: 64083.1, precision: 1 })).toBe('BTCUSDT 64,083.1');
    expect(formatTabTitle({ symbol: 'XAUUSD', price: 2650, precision: 2 })).toBe('XAUUSD 2,650.00');
    expect(formatTabTitle({ symbol: 'PEPEUSDT', price: 0.0000123, precision: 7 })).toBe('PEPEUSDT 0.0000123');
  });

  it('tăng ▲ +, giảm ▼ −, không đổi 0.00%', () => {
    expect(formatTabTitle({ symbol: 'BTCUSDT', price: 101, precision: 0, refClose: 100 })).toBe('BTCUSDT 101 ▲ +1.00%');
    expect(formatTabTitle({ symbol: 'BTCUSDT', price: 98.5, precision: 1, refClose: 100 })).toBe('BTCUSDT 98.5 ▼ −1.50%');
    expect(formatTabTitle({ symbol: 'BTCUSDT', price: 100, precision: 0, refClose: 100 })).toBe('BTCUSDT 100 0.00%');
  });

  it('thiếu giá / tham chiếu 0 / lỗi / chưa có symbol', () => {
    expect(formatTabTitle({ symbol: 'BTCUSDT' })).toBe('BTCUSDT');
    expect(formatTabTitle({ symbol: 'BTCUSDT', price: 5, precision: 0, refClose: 0 })).toBe('BTCUSDT 5');
    expect(formatTabTitle({ symbol: 'BTCUSDT', price: 5, error: true })).toBe('BTCUSDT · Lỗi');
    expect(formatTabTitle({ symbol: '' })).toBe(DEFAULT_TITLE);
  });
});

describe('TabTitleController', () => {
  const DAY = 86_400;
  const setup = (refs: Record<string, DailyRef | null>, nowSec: number) => {
    const titles: string[] = [];
    let now = nowSec * 1000;
    const fetchDailyRef = vi.fn(async (s: string) => refs[s] ?? null);
    const c = new TabTitleController({ fetchDailyRef, setTitle: t => titles.push(t), now: () => now });
    return { c, titles, fetchDailyRef, advance: (sec: number) => (now += sec * 1000) };
  };
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('loading → giá → thêm % khi có tham chiếu ngày; chỉ fetch 1 lần', async () => {
    const t0 = 10 * DAY + 3600;
    const { c, titles, fetchDailyRef } = setup({ BTCUSDT: { close: 100, time: 9 * DAY } }, t0);
    c.update({ symbol: 'BTCUSDT', status: 'loading' });
    c.update({ symbol: 'BTCUSDT', status: 'live', close: 102, precision: 0 });
    await flush();
    c.update({ symbol: 'BTCUSDT', status: 'live', close: 99, precision: 0 });
    expect(titles).toEqual(['BTCUSDT', 'BTCUSDT 102', 'BTCUSDT 102 ▲ +2.00%', 'BTCUSDT 99 ▼ −1.00%']);
    expect(fetchDailyRef).toHaveBeenCalledTimes(1);
  });

  it('đổi symbol bỏ giá/tham chiếu cũ; kết quả fetch của symbol cũ bị bỏ qua', async () => {
    const { c, titles } = setup({ BTCUSDT: { close: 100, time: 0 }, ETHUSDT: { close: 2000, time: 0 } }, DAY / 2);
    c.update({ symbol: 'BTCUSDT', status: 'live', close: 101, precision: 0 });
    c.update({ symbol: 'ETHUSDT', status: 'loading' });
    await flush();
    expect(titles.at(-1)).toBe('ETHUSDT');
    c.update({ symbol: 'ETHUSDT', status: 'live', close: 2100, precision: 0 });
    await flush();
    expect(titles.at(-1)).toBe('ETHUSDT 2,100 ▲ +5.00%');
  });

  it('qua mốc đóng nến ngày → lấy tham chiếu mới (giới hạn mỗi 10 phút)', async () => {
    const refs: Record<string, DailyRef> = { BTCUSDT: { close: 100, time: 0 } };
    const { c, titles, fetchDailyRef, advance } = setup(refs, DAY + 60);
    c.update({ symbol: 'BTCUSDT', status: 'live', close: 110, precision: 0 });
    await flush();
    expect(titles.at(-1)).toBe('BTCUSDT 110 ▲ +10.00%');
    advance(DAY); // đã qua 2 * DAY → nến 1D kế tiếp đóng
    refs.BTCUSDT = { close: 120, time: DAY };
    c.update({ symbol: 'BTCUSDT', status: 'live', close: 108, precision: 0 });
    await flush();
    expect(titles.at(-1)).toBe('BTCUSDT 108 ▼ −10.00%');
    expect(fetchDailyRef).toHaveBeenCalledTimes(2);
  });

  it('lỗi tải nến', () => {
    const { c, titles, fetchDailyRef } = setup({}, 0);
    c.update({ symbol: 'BTCUSDTX', status: 'error' });
    expect(titles).toEqual(['BTCUSDTX · Lỗi']);
    expect(fetchDailyRef).not.toHaveBeenCalled();
  });
});
