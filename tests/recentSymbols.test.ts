import { describe, expect, it } from 'vitest';
import { buildSuggestions, parseRecent, pushRecent } from '../apps/web/src/store/recentSymbols.ts';

describe('symbol xem gần đây', () => {
  it('đưa lên đầu, bỏ trùng, cắt theo max', () => {
    expect(pushRecent([], 'btcusdt')).toEqual(['BTCUSDT']);
    expect(pushRecent(['ETHUSDT', 'SOLUSDT', 'BTCUSDT'], 'SOLUSDT')).toEqual(['SOLUSDT', 'ETHUSDT', 'BTCUSDT']);
    expect(pushRecent(['A', 'B', 'C'], 'D', 3)).toEqual(['D', 'A', 'B']);
    expect(pushRecent(['A'], '  ')).toEqual(['A']);
  });

  it('parse dữ liệu localStorage hỏng → rỗng / bỏ phần tử lạ', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent({ a: 1 })).toEqual([]);
    expect(parseRecent(['btcusdt', 3, 'BTCUSDT', '', 'gold'])).toEqual(['BTCUSDT', 'XAUUSD']);
    expect(parseRecent(['A', 'B', 'C'], 2)).toEqual(['A', 'B']);
  });

  it('gợi ý: gần đây trước, watchlist sau, không trùng, lọc theo query', () => {
    const watch = ['BTCUSDT', 'ETHUSDT', 'XAUUSD'];
    expect(buildSuggestions(['SOLUSDT', 'ETHUSDT'], watch, '')).toEqual([
      { symbol: 'SOLUSDT', recent: true },
      { symbol: 'ETHUSDT', recent: true },
      { symbol: 'BTCUSDT', recent: false },
      { symbol: 'XAUUSD', recent: false },
    ]);
    expect(buildSuggestions(['SOLUSDT', 'ETHUSDT'], watch, 'sol')).toEqual([{ symbol: 'SOLUSDT', recent: true }]);
    expect(buildSuggestions([], watch, 'USDT').map(s => s.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
});
