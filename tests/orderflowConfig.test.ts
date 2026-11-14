import { afterEach, describe, expect, it, vi } from 'vitest';

// Cấu hình order flow mặc định: BTC (spot), vàng (futures XAUUSDT) + 8 top coin (futures cùng tên). Env vẫn ghi đè.

const COINS = ['ETHUSDT', 'SOLUSDT', 'SUIUSDT', 'GRAMUSDT', 'XRPUSDT', 'BNBUSDT', 'NEARUSDT', 'LINKUSDT'];
const OF_ENV = /^ORDERFLOW_/;

const saved = { ...process.env };

async function loadConfig(env: Record<string, string> = {}) {
  vi.resetModules();
  // Không để env thật (.env của máy) ảnh hưởng mặc định.
  for (const key of Object.keys(process.env)) if (OF_ENV.test(key)) delete process.env[key];
  Object.assign(process.env, env);
  return (await import('../apps/server/src/config.ts')).config;
}

afterEach(() => {
  for (const key of Object.keys(process.env)) if (OF_ENV.test(key)) delete process.env[key];
  for (const [k, v] of Object.entries(saved)) if (OF_ENV.test(k)) process.env[k] = v;
});

describe('order flow config mặc định', () => {
  it('đủ 10 symbol, 8 coin mới dùng futures cùng tên, resync 5 phút, offset 0', async () => {
    const cfg = await loadConfig();
    expect(cfg.orderflowBinanceSymbols).toEqual(['BTCUSDT', 'XAUUSD', ...COINS]);
    expect(cfg.orderflowSources.BTCUSDT).toEqual({ market: 'spot', symbol: 'BTCUSDT' });
    expect(cfg.orderflowSources.XAUUSD).toEqual({ market: 'futures', symbol: 'XAUUSDT' });
    for (const sym of COINS) {
      expect(cfg.orderflowSources[sym]).toEqual({ market: 'futures', symbol: sym });
      expect(cfg.orderflowResyncMinBySymbol[sym]).toBe(5);
      expect(cfg.orderflowOffsets[sym]).toBe(0);
      expect(cfg.orderflowSampleRangePctBySymbol[sym]).toBe(3);
      for (const table of [cfg.orderflowBuckets, cfg.orderflowBigTrade, cfg.orderflowAbsorb, cfg.orderflowWallMin]) {
        expect(table[sym]).toBeGreaterThan(0);
      }
      // absorb ≈ 8 × bigTrade
      expect(cfg.orderflowAbsorb[sym]! / cfg.orderflowBigTrade[sym]!).toBeCloseTo(8, 0);
    }
    // BTC / vàng giữ nguyên.
    expect(cfg.orderflowBuckets).toMatchObject({ BTCUSDT: 10, XAUUSD: 1, SUIUSDT: 0.0002, ETHUSDT: 0.5 });
    expect(cfg.orderflowBigTrade).toMatchObject({ BTCUSDT: 1, XAUUSD: 80 });
    expect(cfg.orderflowOffsets).toMatchObject({ BTCUSDT: 33, XAUUSD: 0 });
    expect(cfg.orderflowResyncMinBySymbol.BTCUSDT).toBeUndefined();
    // BTC / vàng không giới hạn vùng lấy mẫu.
    expect(cfg.orderflowSampleRangePct).toBe(0);
    expect(cfg.orderflowSampleRangePctBySymbol.BTCUSDT).toBeUndefined();
  });

  it('env ghi đè danh sách, nguồn và ngưỡng theo symbol', async () => {
    const cfg = await loadConfig({
      ORDERFLOW_BINANCE_SYMBOLS: 'btcusdt, solusdt',
      ORDERFLOW_SOURCE_SOLUSDT: 'spot:SOLUSDT',
      ORDERFLOW_BUCKET_SOLUSDT: '0.05',
      ORDERFLOW_BIG_TRADE_SUIUSDT: '12345',
      ORDERFLOW_WALL_MIN_XRPUSDT: '1',
      ORDERFLOW_RESYNC_MIN_ETHUSDT: '15',
      ORDERFLOW_SAMPLE_RANGE_PCT: '5',
      ORDERFLOW_SAMPLE_RANGE_PCT_SUIUSDT: '0',
    });
    expect(cfg.orderflowBinanceSymbols).toEqual(['BTCUSDT', 'SOLUSDT']);
    expect(cfg.orderflowSources.SOLUSDT).toEqual({ market: 'spot', symbol: 'SOLUSDT' });
    expect(cfg.orderflowBuckets.SOLUSDT).toBe(0.05);
    expect(cfg.orderflowBigTrade.SUIUSDT).toBe(12345);
    expect(cfg.orderflowWallMin.XRPUSDT).toBe(1);
    expect(cfg.orderflowResyncMinBySymbol.ETHUSDT).toBe(15);
    expect(cfg.orderflowSampleRangePct).toBe(5);
    expect(cfg.orderflowSampleRangePctBySymbol.SUIUSDT).toBe(0);
    // Mã không bị ghi đè vẫn giữ mặc định.
    expect(cfg.orderflowSources.SUIUSDT).toEqual({ market: 'futures', symbol: 'SUIUSDT' });
  });

  it('ORDERFLOW_BINANCE_SYMBOLS đặt rỗng = tắt', async () => {
    const off = await loadConfig({ ORDERFLOW_BINANCE_SYMBOLS: '' });
    expect(off.orderflowBinanceSymbols).toEqual([]);
  });
});
