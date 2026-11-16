import { describe, expect, it } from 'vitest';
import { readUrlPrefs, writeUrlPrefs } from '../apps/web/src/store/urlPrefs.ts';

describe('symbol + khung trên URL', () => {
  it('đọc tham số hợp lệ', () => {
    expect(readUrlPrefs('?symbol=INJUSDT&tf=1m')).toEqual({ symbol: 'INJUSDT', tf: '1m' });
    expect(readUrlPrefs('?symbol=injusdt')).toEqual({ symbol: 'INJUSDT' });
    expect(readUrlPrefs('?tf=4h')).toEqual({ tf: '4h' });
    expect(readUrlPrefs('')).toEqual({});
  });

  it('chuẩn hoá alias, bỏ giá trị sai', () => {
    expect(readUrlPrefs('?symbol=gold&tf=xx')).toEqual({ symbol: 'XAUUSD' });
    expect(readUrlPrefs('?symbol=XAU_USD')).toEqual({ symbol: 'XAUUSD' });
    expect(readUrlPrefs('?symbol=%20%20&tf=')).toEqual({});
    expect(readUrlPrefs('?symbol=<script>')).toEqual({ symbol: 'SCRIPT' });
    expect(readUrlPrefs(`?symbol=${'A'.repeat(40)}`)).toEqual({});
  });

  it('ghi query: symbol/tf đứng đầu, giữ tham số khác, ghi đè giá trị cũ', () => {
    expect(writeUrlPrefs('', 'BTCUSDT', '4h')).toBe('?symbol=BTCUSDT&tf=4h');
    expect(writeUrlPrefs('?demo=enter', 'ETHUSDT', '1h')).toBe('?symbol=ETHUSDT&tf=1h&demo=enter');
    expect(writeUrlPrefs('?tf=1m&symbol=INJUSDT&demo', 'XAUUSD', '1d')).toBe('?symbol=XAUUSD&tf=1d&demo=');
  });
});
