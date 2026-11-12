import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tfSeconds, type AnalysisSubmissionInput, type Candle, type Orderflow } from '@wca/shared';
import { openDb } from '../apps/server/src/db/index.ts';
import { AnalysisRepo } from '../apps/server/src/analysis/repo.ts';
import { AnalysisService } from '../apps/server/src/analysis/service.ts';
import { KlineService } from '../apps/server/src/market/klineService.ts';
import type { FetchKlinesParams, MarketDataProvider } from '../apps/server/src/market/provider.ts';
import type { AgentRunHooks, AgentRunRequest, AgentRunner, AgentRunOutcome } from '../apps/server/src/runner/types.ts';
import { LocalBook, sampleBook, type BookSample } from '../apps/server/src/orderflow/localBook.ts';
import {
  buildSnapshot,
  cvdStats,
  findAbsorption,
  findWalls,
  basisByMinute,
  findWallSegments,
  medianBasis,
  profileBucket,
  volumeProfile,
  type SpotCandle,
} from '../apps/server/src/orderflow/calc.ts';
import { BookCollector, depthSnapshotUrl, streamEndpoints } from '../apps/server/src/orderflow/collector.ts';
import { BinanceOrderflow, parseSpotKline, sizeUnit, venueLabel } from '../apps/server/src/orderflow/binanceOrderflow.ts';
import { formatOrderflowForAgent } from '../apps/server/src/orderflow/format.ts';
import { validateBinanceOrderflow } from '../apps/server/src/validate/orderflow.ts';
import { buildUserPrompt } from '../apps/server/src/runner/prompt.ts';
import { buildAgyPromptSuffix } from '../apps/server/src/runner/agyFormat.ts';

// ---------- Sổ lệnh cục bộ ----------

describe('LocalBook (quy trình đồng bộ Binance)', () => {
  const snap = { lastUpdateId: 100, bids: [['99', '1'], ['98', '2']] as [string, string][], asks: [['101', '1'], ['102', '3']] as [string, string][] };

  it('bỏ diff cũ, diff đầu phải chứa lastUpdateId+1, sau đó phải liền mạch', () => {
    const b = new LocalBook();
    b.applySnapshot(snap);
    expect(b.applyDiff({ U: 90, u: 100, b: [], a: [] })).toBe('stale');
    expect(b.isSynced).toBe(false);
    expect(b.applyDiff({ U: 95, u: 105, b: [['99', '0'], ['97', '4']], a: [['101', '2']] })).toBe('applied');
    expect(b.isSynced).toBe(true);
    expect([...b.bids.entries()].sort()).toEqual([[97, 4], [98, 2]]);
    expect(b.asks.get(101)).toBe(2);
    expect(b.applyDiff({ U: 107, u: 110, b: [], a: [] })).toBe('gap');
    expect(b.applyDiff({ U: 106, u: 110, b: [], a: [] })).toBe('applied');
    expect(b.lastUpdateId).toBe(110);
  });

  it('diff đầu bắt đầu sau lastUpdateId+1 → gap (snapshot quá cũ)', () => {
    const b = new LocalBook();
    b.applySnapshot(snap);
    expect(b.applyDiff({ U: 150, u: 160, b: [], a: [] })).toBe('gap');
  });

  it('sampleBook gom theo bucket, chỉ trong vùng snapshot phủ', () => {
    const b = new LocalBook();
    b.applySnapshot({ lastUpdateId: 1, bids: [['73005', '1'], ['73001', '2'], ['72990', '5']], asks: [['73012', '1'], ['73025', '4']] });
    b.applyDiff({ U: 2, u: 2, b: [['70000', '99']], a: [] }); // ngoài vùng snapshot → bỏ
    const s = sampleBook(b, 10, 1000)!;
    expect(s.mid).toBe(73008.5);
    expect(s.bids).toEqual([[72990, 5], [73000, 3]]);
    expect(s.asks).toEqual([[73010, 1], [73020, 4]]);
  });
});

// ---------- Tính toán ----------

/** Mẫu mỗi 10s trong `minutes` phút; `extra(t)` thêm bucket ask/bid. */
function samples(minutes: number, extra: (i: number, n: number) => { bids?: [number, number][]; asks?: [number, number][] } = () => ({})): BookSample[] {
  const n = minutes * 6 + 1;
  return Array.from({ length: n }, (_, i) => {
    const e = extra(i, n);
    const bids: [number, number][] = [[72900, 1], [72910, 1], [72920, 1], [72930, 1], ...(e.bids ?? [])];
    const asks: [number, number][] = [[73100, 1], [73110, 1], [73120, 1], [73130, 1], ...(e.asks ?? [])];
    return { t: 1_000_000 + i * 10, mid: 73000, bids, asks };
  });
}

describe('findWalls', () => {
  it('tường đứng lâu được giữ kèm persistMin; tường vừa xuất hiện (spoof) bị loại', () => {
    const s = samples(60, (i, n) => ({
      bids: [[72800, 50]], // đứng suốt 60 phút
      asks: i >= n - 2 ? [[73200, 80]] : [], // chỉ 2 mẫu cuối
    }));
    const walls = findWalls(s);
    expect(walls).toEqual([{ side: 'BID', price: 72800, size: 50, persistMin: 60, maxSize: 50 }]);
  });

  it('lịch sử ngắn hơn minPersistMin → không lọc theo thời gian đứng', () => {
    const s = samples(2, (i, n) => ({ asks: i >= n - 2 ? [[73200, 80]] : [] }));
    expect(findWalls(s).map(w => w.price)).toEqual([73200]);
  });

  it('tường bị rút bớt rồi giữ: maxSize ghi lại mức lớn nhất', () => {
    const s = samples(30, (i, n) => ({ bids: [[72800, i < n / 2 ? 100 : 40]] }));
    const [w] = findWalls(s);
    expect(w).toMatchObject({ price: 72800, size: 40, maxSize: 100 });
    expect(w!.persistMin).toBeCloseTo(30, 0);
  });
});

const c = (time: number, low: number, high: number, volume: number, takerBuy: number, open = low, close = high): SpotCandle => ({
  time, open, high, low, close, volume, takerBuy,
});

describe('volume profile / CVD / hấp thụ', () => {
  it('POC ở vùng khớp nhiều nhất; bucket profile theo biên độ', () => {
    const cs = [c(0, 100, 110, 10, 5), c(60, 100, 110, 10, 5), c(120, 150, 160, 2, 1), c(180, 120, 130, 1, 0.5)];
    const p = volumeProfile(cs, 10)!;
    expect(p.poc.price).toBe(105);
    expect(p.valueArea.low).toBeLessThanOrEqual(100);
    expect(profileBucket(2000, 10)).toBe(30);
    expect(profileBucket(100, 10)).toBe(10);
  });

  it('CVD: giá xuống đáy mới mà CVD không xuống → phân kỳ tăng', () => {
    // 200 nến bán chủ động mạnh, giảm dần; 40 nến cuối giá thủng nhẹ nhưng mua chủ động.
    const cs: SpotCandle[] = [];
    for (let i = 0; i < 200; i++) cs.push(c(i * 60, 1000 - i, 1001 - i, 10, 2));
    for (let i = 200; i < 240; i++) cs.push(c(i * 60, 799 - (i - 200) * 0.1, 805, 10, 8));
    const s = cvdStats(cs)!;
    expect(s.last4h).toBeLessThan(0);
    expect(s.divergence).toMatch(/phân kỳ tăng/);
  });

  it('bán chủ động lớn mà giá giữ → hấp thụ; giá thủng → không', () => {
    const trades = [
      { t: 1000, price: 73005, qty: 15, side: 'SELL' as const },
      { t: 1010, price: 73002, qty: 15, side: 'SELL' as const },
      { t: 1000, price: 73505, qty: 40, side: 'SELL' as const },
    ];
    const cs = Array.from({ length: 20 }, (_, i) => c(960 + i * 60, i < 10 ? 72995 : 73400, 73100));
    const held = findAbsorption(trades, cs, { bucket: 10, now: 960 + 20 * 60, minQty: 25 });
    expect(held).toEqual([{ price: 73000, aggressor: 'SELL', qty: 30, trades: 2, lastAt: 1010 }]);
  });
});

describe('buildSnapshot', () => {
  const s = samples(60, () => ({ bids: [[72800, 50]], asks: [[73200, 30]] }));
  const candles = Array.from({ length: 300 }, (_, i) => c(1_000_000 - 18_000 + i * 60, 72950, 73050, 5, 2.5));

  it('quy đổi về giá chart bằng basis truyền vào', () => {
    const snap = buildSnapshot({
      symbol: 'BTCUSDT', venue: 'Binance spot', unit: 'BTC', now: s.at(-1)!.t, bucket: 10, samples: s, candles, trades: [],
      appPrice: 72966, absorptionMinQty: 25, offset: 33,
    });
    const bid = snap.levels.find(l => l.kind === 'BID_WALL')!;
    expect(bid).toMatchObject({ sourcePrice: 72800, price: 72767, size: 50, sizeSource: 'BOOK', persistMin: 60 });
    expect(snap.levels.every(l => l.price === Math.round((l.sourcePrice! - 33) * 100) / 100)).toBe(true);
    expect(snap.offset).toBe(33);
    expect(snap.levels.find(l => l.kind === 'POC')?.sizeSource).toBe('VOLUME');
    expect(snap.notes).toEqual([]);
    const text = formatOrderflowForAgent(snap);
    expect(text).toContain('giá Binance spot − basis 33');
    expect(text).toContain('chênh lệch thực tế 34');
    expect(text).toContain('Tường mua 72767');
  });

  it('chưa có sổ lệnh → ghi chú, không có tường', () => {
    const snap = buildSnapshot({
      symbol: 'BTCUSDT', venue: 'Binance spot', unit: 'BTC', now: 2_000_000, bucket: 10, samples: [], candles, trades: [], appPrice: null, absorptionMinQty: 25,
    });
    expect(snap.walls).toEqual([]);
    expect(snap.notes.join(' ')).toMatch(/Chưa có dữ liệu sổ lệnh/);
  });
});

describe('findWallSegments (lịch sử tường)', () => {
  // Mẫu mỗi 10s từ t=0; mid 73050; nến 1m spot theo low/high cho trước.
  const T0 = 1_000_020;
  const mk = (n: number, f: (i: number) => { bids?: [number, number][]; asks?: [number, number][] }): BookSample[] =>
    Array.from({ length: n }, (_, i) => ({
      t: T0 + i * 10,
      mid: 73050,
      bids: [[72950, 1], [72960, 1], [72970, 1], ...(f(i).bids ?? [])],
      asks: [[73150, 1], [73160, 1], [73170, 1], ...(f(i).asks ?? [])],
    }));
  const flat = (from: number, minutes: number, low: number, high: number) =>
    Array.from({ length: minutes }, (_, i) => c(from + i * 60, low, high, 1, 0.5));
  const opts = { bucket: 10, minSize: 8 };

  it('tường bị giá quét → consumed, end = lúc giá chạm (không sớm hơn lần cuối còn thấy)', () => {
    // Tường mua 73000 (40 BTC) đứng 10 phút rồi biến mất; nến phút thứ 10 chạm 73005.
    const samples = mk(90, i => ({ bids: i < 60 ? [[73000, 40]] : [] }));
    const candles = [...flat(T0 - 20, 10, 73030, 73080), c(T0 - 20 + 600, 73005, 73060, 1, 0.5), ...flat(T0 - 20 + 660, 5, 73020, 73080)];
    const segs = findWallSegments(samples, candles, opts);
    // Nến chạm mở lúc T0+580, tường còn thấy tới T0+590 → end không sớm hơn lần cuối còn thấy.
    expect(segs).toEqual([{ side: 'BID', sourcePrice: 73000, start: T0, end: T0 + 590, peakSize: 40, status: 'consumed' }]);
  });

  it('tường biến mất khi giá chưa chạm → pulled; đang còn → active; ngắn < 5 phút → bỏ', () => {
    const samples = mk(90, i => ({
      bids: i < 60 ? [[73000, 40]] : [],
      asks: [[73300, 30], ...(i >= 10 && i < 20 ? ([[73400, 50]] as [number, number][]) : [])],
    }));
    const candles = flat(T0 - 20, 16, 73030, 73080);
    const segs = findWallSegments(samples, candles, opts);
    expect(segs.map(s => [s.side, s.sourcePrice, s.status, s.end])).toEqual([
      ['BID', 73000, 'pulled', T0 + 590],
      ['ASK', 73300, 'active', null],
    ]);
  });

  it('dưới ngưỡng tối thiểu không tính; hụt 1 mẫu (nhiễu) không cắt tường', () => {
    const samples = mk(60, i => ({ bids: [[73000, i === 30 ? 0 : 40]], asks: [[73300, 6]] }));
    const segs = findWallSegments(samples, [], { bucket: 10, minSize: 8, k: 3 });
    expect(segs).toEqual([{ side: 'BID', sourcePrice: 73000, start: T0, end: null, peakSize: 40, status: 'active' }]);
  });
});

// ---------- Collector ----------

class FakeWs extends EventTarget {
  readyState = 1;
  close() {
    this.readyState = 3;
  }
  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ data }) }));
  }
}

describe('BookCollector', () => {
  it('buffer diff trước snapshot, đồng bộ, ghi mẫu và lệnh lớn vào DB', async () => {
    const db = openDb(':memory:');
    const ws = new FakeWs();
    let now = 5000;
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ lastUpdateId: 100, bids: [['72995', '1'], ['72800', '50']], asks: [['73005', '1'], ['73200', '9']] }))) as typeof fetch;
    const col = new BookCollector({
      symbol: 'BTCUSDT', bucket: 10, sampleSec: 3600, retainH: 24, resyncMin: 600, bigTradeQty: 2, db, fetchImpl,
      wsFactory: () => ws as unknown as WebSocket, now: () => now,
    });
    col.start();
    // diff tới trước khi snapshot xong → buffer
    ws.emit({ e: 'depthUpdate', U: 99, u: 101, b: [['72800', '60']], a: [] });
    await col.resync('test');
    expect(col.takeSample()).toMatchObject({ t: 5000, bids: [[72800, 60], [72990, 1]] });
    ws.emit({ e: 'depthUpdate', U: 102, u: 102, b: [], a: [['73200', '0']] });
    now = 5010;
    expect(col.takeSample()?.asks).toEqual([[73000, 1]]);
    // Cùng giây, cùng bên → gộp (VWAP); nhóm nhỏ hơn ngưỡng → bỏ.
    ws.emit({ e: 'aggTrade', p: '73000', q: '1.5', T: 5_005_100, m: true });
    ws.emit({ e: 'aggTrade', p: '73002', q: '1.5', T: 5_005_900, m: true });
    ws.emit({ e: 'aggTrade', p: '73001', q: '0.5', T: 5_005_500, m: false });
    expect(col.trades(0, 9999)).toEqual([]); // giây 5005 chưa chốt
    ws.emit({ e: 'aggTrade', p: '73001', q: '0.1', T: 5_006_000, m: false });
    expect(col.trades(0, 9999)).toEqual([{ t: 5005, price: 73001, qty: 3, side: 'SELL' }]);
    expect(col.samples(0, 9999)).toHaveLength(2);
    expect(col.status()).toMatchObject({ symbol: 'BTCUSDT', synced: true, since: 5000, lastSampleAt: 5010, spotPrice: 73000 });
    // mất chuỗi → snapshot lại
    ws.emit({ e: 'depthUpdate', U: 200, u: 201, b: [], a: [] });
    col.stop();
  });

  it('samples() bỏ đoạn trước khoảng mất dữ liệu > 5 phút', () => {
    const db = openDb(':memory:');
    const col = new BookCollector({ symbol: 'BTCUSDT', bucket: 10, sampleSec: 10, retainH: 24, resyncMin: 30, bigTradeQty: 2, db });
    for (const t of [100, 110, 1000, 1010]) {
      db.prepare('INSERT INTO book_samples (symbol, t, data) VALUES (?, ?, ?)').run('BTCUSDT', t, JSON.stringify({ t, mid: 1, bids: [], asks: [] }));
    }
    expect(col.samples(0, 2000).map(s => s.t)).toEqual([1000, 1010]);
  });
});

describe('parseSpotKline', () => {
  it('lấy taker buy volume (cột 9)', () => {
    const k = [1794449760000, '73844.02', '73847.42', '73832.71', '73832.71', '2.96716', 1794449819999, '219103.8', 764, '0.84848', '62650.4', '0'] as const;
    expect(parseSpotKline(k as never)).toEqual({ time: 1794449760, open: 73844.02, high: 73847.42, low: 73832.71, close: 73832.71, volume: 2.96716, takerBuy: 0.84848 });
  });
});

// ---------- Validator ----------

describe('validateBinanceOrderflow', () => {
  const snapshot = buildSnapshot({
    symbol: 'BTCUSDT', venue: 'Binance spot', unit: 'BTC', now: 1_036_000, bucket: 10,
    samples: samples(60, () => ({ bids: [[72800, 50]] })), candles: [], trades: [], appPrice: 72990, absorptionMinQty: 25,
  });
  const ctx = { snapshot, cvdText: 'CVD 24h +10 BTC' };

  it('bỏ levels/lastPrices agent gửi, gắn levels server tính', () => {
    const agent: Orderflow = {
      summary: 'Tường mua dày bên dưới.', cvd: '', lastPrices: [{ image: 'ltf', bookmapPrice: 1 }],
      levels: [{ kind: 'ASK_WALL', bookmapPrice: 1, strength: 0.5, note: '' }],
    };
    const r = validateBinanceOrderflow(agent, ctx);
    expect(r.orderflow).toMatchObject({ source: 'binance', summary: 'Tường mua dày bên dưới.', cvd: 'CVD 24h +10 BTC', lastPrices: [] });
    expect(r.orderflow.offset).toBe(0);
    expect(r.orderflow.levels).toEqual(snapshot.levels);
    expect(r.warnings).toHaveLength(2);
  });

  it('agent không nộp orderflow → vẫn hiện số liệu server, cảnh báo', () => {
    const r = validateBinanceOrderflow(undefined, ctx);
    expect(r.orderflow.levels).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/không nộp orderflow/);
  });
});

// ---------- Tích hợp AnalysisService ----------

const END = Math.floor(Date.now() / 1000) - 86400;
class FakeProvider implements MarketDataProvider {
  name = 'fake';
  maxLimit = 1500;
  async fetchKlines(p: FetchKlinesParams): Promise<Candle[]> {
    const step = tfSeconds(p.tf);
    const last = END - (END % step);
    return Array.from({ length: p.limit }, (_, i) => ({ time: last - (p.limit - 1 - i) * step, open: 100, high: 110, low: 90, close: 100, volume: 1 }));
  }
}

class FakeRunner implements AgentRunner {
  readonly id = 'claude-code' as const;
  readonly label = 'fake';
  readonly supportsScreenshot = true;
  readonly supportsBookmap = true;
  lastReq: AgentRunRequest | null = null;
  constructor(private behavior: (req: AgentRunRequest, hooks: AgentRunHooks) => Promise<AgentRunOutcome>) {}
  availability() {
    return { available: true };
  }
  async listModels() {
    return [];
  }
  run(req: AgentRunRequest, hooks: AgentRunHooks) {
    this.lastReq = req;
    return this.behavior(req, hooks);
  }
}

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 5));
  }
};

const lastH4 = () => END - (END % tfSeconds('4h'));

function submission(over: Partial<AnalysisSubmissionInput> = {}): AnalysisSubmissionInput {
  return {
    symbol: 'BTCUSDT', primaryTf: '4h', schematic: 'ACCUMULATION', currentPhase: 'C', bias: 'BULLISH', confidence: 0.7,
    summary: 'Tích luỹ 4H sau SC, Spring đã test với volume thấp; khung 1D vẫn trong range lớn, 5m xác nhận LPS.',
    topDown: [{ tf: '4h', role: 'PRIMARY', bias: 'BULLISH', note: 'Spring + test volume thấp' }],
    events: [{ type: 'SC', tf: '4h', time: lastH4() - 20 * 14400, price: 90 }],
    tradePlan: { decision: 'STAND_ASIDE', reason: 'Chờ LPS xác nhận trên khung nhỏ', reconsiderWhen: 'LPS trên 95 với volume thấp' },
    ...over,
  };
}

function setup(behavior: (req: AgentRunRequest, hooks: AgentRunHooks, svc: AnalysisService) => Promise<AgentRunOutcome>) {
  const db = openDb(':memory:');
  const repo = new AnalysisRepo(db);
  const now = END;
  const bookSamples = samples(60, () => ({ bids: [[80, 50]] })).map((s, i) => ({ ...s, t: now - 3600 + i * 10, mid: 103 }));
  const fetchImpl = (async (url: string) => {
    expect(String(url)).toContain('api.binance.com/api/v3/klines');
    return new Response(JSON.stringify([[(now - 120) * 1000, '102', '104', '101', '103', '5', 0, '0', 1, '3', '0', '0']]));
  }) as typeof fetch;
  const binanceOrderflow = new BinanceOrderflow({
    collectors: {
      BTCUSDT: {
        samples: () => bookSamples,
        rawSamples: (from: number, to: number) => bookSamples.filter(x => x.t >= from && x.t <= to),
        trades: () => [],
        status: () => ({ symbol: 'BTCUSDT', sourceSymbol: 'BTCUSDT', market: 'spot' as const, coverLow: 0, coverHigh: 0, connected: true, synced: true, since: now - 3600, lastSampleAt: now, historyMin: 60, spotPrice: 103 }),
      },
    },
    buckets: { BTCUSDT: 10 },
    absorptionQty: { BTCUSDT: 25 },
    fetchImpl,
    now: () => now,
  });
  const holder: { service?: AnalysisService } = {};
  const runner = new FakeRunner((req, hooks) => behavior(req, hooks, holder.service!));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-of-'));
  const service = new AnalysisService(repo, new KlineService(db, new FakeProvider(), 0), runner, {
    maxTfs: 4, barsPerTf: 300, screenshotDir: dir, validationBars: 300,
    bookmap: { images: { BTCUSDT: { htf: '/x.png' }, XAUUSD: { htf: '/y.png' } }, offsets: {}, tolerances: {}, maxAgeMin: 30 },
    binanceOrderflow,
  });
  holder.service = service;
  return { service, repo, runner, dir };
}

describe('AnalysisService + order flow Binance', () => {
  it('symbol dùng Binance không còn nhận ảnh Bookmap; symbol khác báo lỗi; không chọn cả hai', () => {
    const { service } = setup(async () => ({ ok: true }));
    expect(service.bookmapSymbols).toEqual(['XAUUSD']);
    expect(service.orderflowSymbols).toEqual(['BTCUSDT']);
    expect(() => service.start({ symbol: 'ETHUSDT', primaryTf: '4h', contextTfs: [], orderflow: true })).toThrow(/Chưa bật order flow Binance/);
    expect(() => service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], orderflow: true, bookmap: {} })).toThrow(/Chọn một nguồn/);
    expect(service.orderflowStatus('btcusdt')).toMatchObject({ connected: true, historyMin: 60 });
  });

  it('symbol dùng Binance futures làm đại diện (vàng) vẫn giữ ảnh Bookmap', () => {
    const stub = { samples: () => [], rawSamples: () => [], trades: () => [], status: () => ({}) as never };
    const of = new BinanceOrderflow({
      collectors: { BTCUSDT: stub, XAUUSD: stub },
      sources: { XAUUSD: { market: 'futures', symbol: 'XAUUSDT' } },
      buckets: {},
      absorptionQty: {},
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-of-'));
    const db = openDb(':memory:');
    const service = new AnalysisService(new AnalysisRepo(db), new KlineService(db, new FakeProvider(), 0), new FakeRunner(async () => ({ ok: true })), {
      maxTfs: 4, barsPerTf: 300, screenshotDir: dir, validationBars: 300,
      bookmap: { images: { BTCUSDT: { htf: '/x.png' }, XAUUSD: { htf: '/y.png' } }, offsets: {}, tolerances: {}, maxAgeMin: 30 },
      binanceOrderflow: of,
    });
    expect(service.bookmapSymbols).toEqual(['XAUUSD']);
    expect(service.orderflowSymbols).toEqual(['BTCUSDT', 'XAUUSD']);
  });

  it('chụp order flow lúc job chạy, request có orderflow, submit gắn levels server tính', async () => {
    const { service, repo, runner } = setup(async (req, _hooks, svc) => {
      expect(req.hasBinanceOrderflow).toBe(true);
      const info = await svc.getRequest(req.analysisId);
      expect(info.orderflow).toMatchObject({ source: 'binance', venue: 'Binance spot' });
      expect(info.bookmap).toBeNull();
      const snap = svc.orderflowSnapshot(req.analysisId);
      expect(snap.appPrice).toBe(100);
      const res = await svc.submit(req.analysisId, submission({ orderflow: { summary: 'Tường mua 77 giữ giá.', cvd: 'CVD tăng' } }));
      expect(res.ok).toBe(true);
      return { ok: true, durationMs: 1 };
    });
    const rec = service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], orderflow: true });
    expect(rec.orderflowSource).toBe('binance');
    await waitFor(() => repo.get(rec.id)?.status === 'DONE');
    const done = repo.get(rec.id)!;
    expect(done.orderflowSource).toBe('binance');
    expect(repo.list().find(r => r.id === rec.id)?.orderflowSource).toBe('binance');
    expect(done.result?.orderflow).toMatchObject({ source: 'binance', summary: 'Tường mua 77 giữ giá.', cvd: 'CVD tăng' });
    expect(done.result?.orderflow?.levels.find(l => l.kind === 'BID_WALL')).toMatchObject({ sourcePrice: 80, price: 80, size: 50 });
    expect(runner.lastReq?.hasBookmap).toBe(false);
  });
});

describe('order flow live cho chart', () => {
  it('cache nến spot: lần sau chỉ tải phần mới; bản live dùng lại trong 10 giây', async () => {
    let now = 1_000_000 * 60; // phút chẵn
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      const p = new URL(String(url)).searchParams;
      const start = Number(p.get('startTime'));
      const end = Number(p.get('endTime'));
      const rows = [];
      for (let t = Math.ceil(start / 60_000) * 60_000; t <= end && rows.length < 1000; t += 60_000) rows.push([t, '1', '2', '0.5', '1.5', '3', 0, '0', 1, '2', '0', '0']);
      return new Response(JSON.stringify(rows));
    }) as typeof fetch;
    const of = new BinanceOrderflow({
      collectors: { BTCUSDT: { samples: () => [], rawSamples: () => [], trades: () => [], status: () => ({ symbol: 'BTCUSDT', sourceSymbol: 'BTCUSDT', market: 'spot' as const, coverLow: 0, coverHigh: 0, connected: true, synced: true, since: null, lastSampleAt: null, historyMin: 0, spotPrice: null }) } },
      buckets: { BTCUSDT: 10 },
      absorptionQty: {},
      fetchImpl,
      now: () => now,
    });
    const first = await of.spotCandles('BTCUSDT', now);
    expect(first).toHaveLength(1440);
    expect(of.klineRequests).toBe(2);
    expect(await of.spotCandles('BTCUSDT', now + 30)).toHaveLength(1439); // cửa sổ trượt bỏ nến đầu; chưa có nến đóng mới → không gọi
    expect(of.klineRequests).toBe(2);
    now += 120;
    const next = await of.spotCandles('BTCUSDT', now);
    expect(of.klineRequests).toBe(3);
    expect(next.at(-1)!.time).toBe(now - 60);
    expect(next[0]!.time).toBeGreaterThanOrEqual(now - 86400);
    expect(new Set(next.map(c => c.time)).size).toBe(next.length);

    // Mẫu sổ lệnh: lần sau chỉ đọc mẫu mới.
    const reads: [number, number][] = [];
    const store: BookSample[] = [{ t: now - 100, mid: 1, bids: [], asks: [] }];
    const of2 = new BinanceOrderflow({
      collectors: {
        BTCUSDT: {
          samples: () => [],
          rawSamples: (from: number, to: number) => (reads.push([from, to]), store.filter(x => x.t >= from && x.t <= to)),
          trades: () => [],
          status: () => ({ symbol: 'BTCUSDT', sourceSymbol: 'BTCUSDT', market: 'spot' as const, coverLow: 0, coverHigh: 0, connected: true, synced: true, since: null, lastSampleAt: null, historyMin: 0, spotPrice: null }),
        },
      },
      buckets: {},
      absorptionQty: {},
    });
    expect(of2.historySamples('BTCUSDT', now)).toHaveLength(1);
    store.push({ t: now + 5, mid: 1, bids: [], asks: [] });
    expect(of2.historySamples('BTCUSDT', now + 10).map(x => x.t)).toEqual([now - 100, now + 5]);
    expect(reads[1]).toEqual([now - 99, now + 10]);

    let priceCalls = 0;
    const price = async () => (priceCalls++, 1.4);
    const a = await of.live('BTCUSDT', price);
    now += 5;
    expect(await of.live('BTCUSDT', price)).toBe(a);
    expect(priceCalls).toBe(1);
    now += 10;
    await of.live('BTCUSDT', price);
    expect(priceCalls).toBe(2);
  });

  it('service.orderflowLive trả levels + lịch sử tường đã quy đổi; symbol không bật → 404', async () => {
    const { service } = setup(async () => ({ ok: true }));
    const live = await service.orderflowLive('btcusdt');
    expect(live).toMatchObject({ source: 'binance', symbol: 'BTCUSDT', connected: true });
    expect(live.levels.find(l => l.kind === 'BID_WALL')).toMatchObject({ sourcePrice: 80, price: 80 });
    expect(live.wallSegments).toEqual([expect.objectContaining({ side: 'BID', sourcePrice: 80, price: 80, status: 'active', end: null, peakSize: 50 })]);
    await expect(service.orderflowLive('ETHUSDT')).rejects.toThrow(/Chưa bật/);
  });
});

describe('basis spot − chart ổn định', () => {
  const T = 1_794_400_020 - (1_794_400_020 % 60);
  // 120 phút: basis 30 ở 60 phút đầu, 40 ở 60 phút sau; nhiễu ±5 ở phút lẻ.
  const spot = Array.from({ length: 120 }, (_, i) => ({ time: T + i * 60, close: 70000 + (i < 60 ? 30 : 40) + (i % 2 ? 5 : -5) + (i % 7 === 0 ? 0 : 0) }));
  const fut = spot.map(c => ({ time: c.time, close: 70000 }));

  it('trung vị 60 phút, thiếu dữ liệu → null', () => {
    const m = basisByMinute(spot, fut);
    expect(m.size).toBe(120);
    expect(medianBasis(m, T + 59 * 60)).toBe(30);
    expect(medianBasis(m, T + 119 * 60)).toBe(40);
    expect(medianBasis(m, T + 5 * 60)).toBeNull(); // mới 6 cặp
  });

  it('tường đã kết thúc dùng basis lúc kết thúc; tường còn tồn tại và các mức dùng basis hiện tại; nến futures cache theo phút', async () => {
    const now = T + 120 * 60 + 30;
    const spotRows = spot.map(c => [c.time * 1000, '1', '1', '1', String(c.close), '1', 0, '0', 1, '0.5', '0', '0']);
    let futCalls = 0;
    const samplesData: BookSample[] = Array.from({ length: 6 * 110 }, (_, i) => ({
      t: T + 600 + i * 10,
      mid: 70035,
      bids: [[69900, 1], [69910, 1], [69920, 1], ...(i < 6 * 30 ? ([[69800, 40]] as [number, number][]) : []), [69700, 30]],
      asks: [[70100, 1], [70110, 1], [70120, 1]],
    }));
    const of = new BinanceOrderflow({
      collectors: {
        BTCUSDT: {
          samples: (from, to) => samplesData.filter(x => x.t >= from && x.t <= to),
          rawSamples: (from, to) => samplesData.filter(x => x.t >= from && x.t <= to),
          trades: () => [],
          status: () => ({ symbol: 'BTCUSDT', sourceSymbol: 'BTCUSDT', market: 'spot' as const, coverLow: 0, coverHigh: 0, connected: true, synced: true, since: null, lastSampleAt: null, historyMin: 0, spotPrice: null }),
        },
      },
      buckets: { BTCUSDT: 10 },
      absorptionQty: {},
      wallMin: { BTCUSDT: 8 },
      offsets: { BTCUSDT: 33 },
      chartCandles: async () => (futCalls++, fut),
      fetchImpl: (async () => new Response(JSON.stringify(spotRows))) as typeof fetch,
      now: () => now,
    });
    const live = await of.live('BTCUSDT', async () => 70000);
    expect(live.offset).toBe(40);
    expect(live.notes.join(' ')).not.toMatch(/dự phòng/);
    const ended = live.wallSegments.find(sg => sg.sourcePrice === 69800)!;
    expect(ended.end).toBeLessThan(T + 60 * 60); // kết thúc trong giờ đầu → basis 30
    expect(ended.price).toBe(69770);
    const active = live.wallSegments.find(sg => sg.sourcePrice === 69700)!;
    expect(active).toMatchObject({ status: 'active', price: 69660 });
    await of.basisFn('BTCUSDT', now);
    expect(futCalls).toBe(1); // cùng phút → dùng cache
  });

  it('không có nến futures → offset dự phòng + ghi chú', async () => {
    const { service } = setup(async () => ({ ok: true }));
    const live = await service.orderflowLive('BTCUSDT');
    expect(live.offset).toBe(0);
    expect(live.notes.join(' ')).toMatch(/offset dự phòng/);
  });
});

describe('prompt', () => {
  const req = { analysisId: 'abc', symbol: 'BTCUSDT', primaryTf: '4h' as const, plan: [{ tf: '4h' as const, role: 'PRIMARY' as const }], barsPerTf: 300, hasScreenshot: false };
  it('nhắc get_orderflow khi có Binance; skeleton agy chỉ có summary + cvd', () => {
    expect(buildUserPrompt({ ...req, hasBinanceOrderflow: true })).toContain('get_orderflow');
    expect(buildUserPrompt(req)).not.toContain('get_orderflow');
    const suffix = buildAgyPromptSuffix({ ...req, hasBinanceOrderflow: true });
    expect(suffix).toContain('"orderflow"');
    expect(suffix).not.toContain('lastPrices');
  });
});

// ---------- Vàng: Binance Futures XAUUSDT perp ----------

describe('LocalBook futures (đồng bộ theo pu)', () => {
  it('event đầu phải phủ lastUpdateId; event sau phải có pu = u trước', () => {
    const b = new LocalBook('futures');
    b.applySnapshot({ lastUpdateId: 100, bids: [['3977', '30']], asks: [['3978', '20']] });
    expect(b.applyDiff({ U: 80, u: 99, pu: 79, b: [], a: [] })).toBe('stale');
    expect(b.applyDiff({ U: 101, u: 110, pu: 100, b: [], a: [] })).toBe('gap'); // U > lastUpdateId
    expect(b.applyDiff({ U: 95, u: 105, pu: 94, b: [['3977', '0'], ['3976', '5']], a: [] })).toBe('applied');
    expect(b.bestBid()).toBe(3976);
    // futures: U không liền u+1 vẫn hợp lệ, miễn pu khớp
    expect(b.applyDiff({ U: 120, u: 130, pu: 105, b: [], a: [] })).toBe('applied');
    expect(b.applyDiff({ U: 140, u: 150, pu: 131, b: [], a: [] })).toBe('gap');
  });
});

describe('nguồn futures', () => {
  it('endpoint WS tách /public (sổ lệnh) và /market (lệnh khớp); snapshot fapi 1000 mức', () => {
    expect(streamEndpoints('futures', 'XAUUSDT')).toEqual([
      { url: 'wss://fstream.binance.com/public/stream?streams=xauusdt@depth@100ms', depth: true },
      { url: 'wss://fstream.binance.com/market/stream?streams=xauusdt@aggTrade', depth: false },
    ]);
    expect(streamEndpoints('spot', 'BTCUSDT')).toHaveLength(1);
    expect(depthSnapshotUrl('futures', 'XAUUSDT')).toBe('https://fapi.binance.com/fapi/v1/depth?symbol=XAUUSDT&limit=1000');
    expect(sizeUnit('XAUUSDT')).toBe('oz');
    expect(sizeUnit('BTCUSDT')).toBe('BTC');
    expect(venueLabel({ market: 'futures', symbol: 'XAUUSDT' })).toBe('Binance Futures XAUUSDT perp');
  });

  it('collector futures: lưu theo symbol chart, đồng bộ bằng pu, lệnh khớp từ socket riêng', async () => {
    const db = openDb(':memory:');
    const sockets: Record<string, FakeWs> = {};
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ lastUpdateId: 100, bids: [['3977.2', '30'], ['3970', '400']], asks: [['3977.3', '25'], ['3985', '300']] }));
    }) as typeof fetch;
    const col = new BookCollector({
      symbol: 'XAUUSD', sourceSymbol: 'XAUUSDT', market: 'futures', bucket: 1, sampleSec: 3600, retainH: 24, resyncMin: 600, bigTradeQty: 50, db, fetchImpl,
      wsFactory: url => (sockets[url] = new FakeWs()) as unknown as WebSocket, now: () => 5000,
    });
    col.start();
    expect(Object.keys(sockets)).toHaveLength(2);
    const depth = sockets['wss://fstream.binance.com/public/stream?streams=xauusdt@depth@100ms']!;
    const trades = sockets['wss://fstream.binance.com/market/stream?streams=xauusdt@aggTrade']!;
    depth.emit({ e: 'depthUpdate', U: 98, u: 102, pu: 97, b: [['3970', '450']], a: [] });
    await col.resync('test');
    expect(urls[0]).toContain('fapi.binance.com/fapi/v1/depth?symbol=XAUUSDT');
    depth.emit({ e: 'depthUpdate', U: 110, u: 111, pu: 102, b: [], a: [['3985', '0']] });
    const s = col.takeSample()!;
    expect(s.bids).toEqual([[3970, 450], [3977, 30]]);
    expect(s.asks).toEqual([[3977, 25]]);
    trades.emit({ e: 'aggTrade', p: '3977', q: '60', T: 5_001_000, m: false });
    trades.emit({ e: 'aggTrade', p: '3977', q: '1', T: 5_002_000, m: false });
    expect(col.trades(0, 9999)).toEqual([{ t: 5001, price: 3977, qty: 60, side: 'BUY' }]);
    expect(col.status()).toMatchObject({ symbol: 'XAUUSD', sourceSymbol: 'XAUUSDT', market: 'futures', coverLow: 3970, coverHigh: 3985 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM book_samples WHERE symbol = ?').get('XAUUSD')).toEqual({ n: 1 });
    col.stop();
  });

  it('BinanceOrderflow futures: nến fapi, đơn vị oz, basis theo nến chart, ghi chú vùng phủ', async () => {
    const T = 1_794_400_020 - (1_794_400_020 % 60);
    const now = T + 90 * 60 + 5;
    const rows = Array.from({ length: 90 }, (_, i) => [(T + i * 60) * 1000, '1', '1', '1', '3980', '10', 0, '0', 1, '6', '0', '0']);
    const chart = rows.map(r => ({ time: (r[0] as number) / 1000, close: 3978.5 }));
    const klineUrls: string[] = [];
    const sample: BookSample = { t: now - 10, mid: 3980, bids: [[3975, 600]], asks: [[3985, 100]] };
    const of = new BinanceOrderflow({
      collectors: {
        XAUUSD: {
          samples: () => [sample],
          rawSamples: () => [sample],
          trades: () => [],
          status: () => ({ symbol: 'XAUUSD', sourceSymbol: 'XAUUSDT', market: 'futures', coverLow: 3967, coverHigh: 3993, connected: true, synced: true, since: null, lastSampleAt: null, historyMin: 0, spotPrice: 3980 }),
        },
      },
      sources: { XAUUSD: { market: 'futures', symbol: 'XAUUSDT' } },
      buckets: { XAUUSD: 1 },
      absorptionQty: {},
      chartCandles: async () => chart,
      fetchImpl: (async (u: string) => (klineUrls.push(String(u)), new Response(JSON.stringify(rows)))) as typeof fetch,
      now: () => now,
    });
    const snap = await of.snapshot('XAUUSD', 3978.5);
    expect(klineUrls[0]).toMatch(/^https:\/\/fapi\.binance\.com\/fapi\/v1\/klines\?symbol=XAUUSDT&/);
    expect(snap).toMatchObject({ venue: 'Binance Futures XAUUSDT perp', unit: 'oz', offset: 1.5 });
    expect(snap.notes.join(' ')).toMatch(/±13/);
    expect(formatOrderflowForAgent(snap)).toContain('giá Binance Futures XAUUSDT perp − basis 1.5');
  });

  it('thị trường nghỉ (không có nến chart mới): giữ basis của phút cuối còn dữ liệu', async () => {
    const T = 1_794_400_020 - (1_794_400_020 % 60);
    const now = T + 200 * 60 + 5; // nến chart dừng ở phút 89
    const rows = Array.from({ length: 200 }, (_, i) => [(T + i * 60) * 1000, '1', '1', '1', '3980', '10', 0, '0', 1, '6', '0', '0']);
    const chart = rows.slice(0, 90).map(r => ({ time: (r[0] as number) / 1000, close: 3977 }));
    const of = new BinanceOrderflow({
      collectors: {},
      sources: { XAUUSD: { market: 'futures', symbol: 'XAUUSDT' } },
      buckets: {},
      absorptionQty: {},
      offsets: { XAUUSD: 0 },
      chartCandles: async () => chart,
      fetchImpl: (async () => new Response(JSON.stringify(rows))) as typeof fetch,
      now: () => now,
    });
    const b = await of.basisFn('XAUUSD', now);
    expect(b).toMatchObject({ current: 3, fallback: false });
  });
});
