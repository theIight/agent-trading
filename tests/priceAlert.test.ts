import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisRecord, AnalysisResult, Candle, PriceAlert, ProgressEvent, TradePlan, TradeSetup } from '@wca/shared';
import { openDb, type Db } from '../apps/server/src/db/index.ts';
import {
  alertsFromRecord,
  evaluateCandles,
  evaluatePrice,
  formatAlert,
  NOTE_IN_ZONE,
  NOTE_SL_SAME_CANDLE,
} from '../apps/server/src/alerts/alertLogic.ts';
import { AlertRepo } from '../apps/server/src/alerts/alertRepo.ts';
import { AlertWatcher, type AlertDestination } from '../apps/server/src/alerts/alertWatcher.ts';
import { CollectorPriceFeed, type PriceListener } from '../apps/server/src/alerts/priceFeed.ts';
import type { GetKlinesOptions } from '../apps/server/src/market/klineService.ts';
import { TelegramMessageStore } from '../apps/server/src/notify/telegramMessages.ts';
import { TelegramClient } from '../apps/server/src/notify/telegramClient.ts';
import { TelegramNotifier } from '../apps/server/src/notify/telegramNotifier.ts';
import { parseCommand } from '../apps/server/src/notify/telegramCommands.ts';

const TZ = 'Asia/Ho_Chi_Minh';
/** 12:34:20 14/11/2026 giờ VN. */
const T0 = Date.UTC(2026, 10, 14, 5, 34, 20) / 1000;
const M0 = Math.floor(T0 / 60) * 60;

const setup = (over: Partial<TradeSetup> = {}): TradeSetup => ({
  name: 'Short LPSY',
  direction: 'SHORT',
  entryType: 'LIMIT',
  tf: '1m',
  trigger: 'LPSY',
  triggerNote: '',
  entryLow: 67400,
  entryHigh: 67500,
  stopLoss: 67900,
  takeProfits: [66600, 66050],
  confidence: 0.6,
  rationale: '',
  riskReward: 4.11,
  ...over,
});

function record(over: Partial<AnalysisRecord> = {}, plan?: Partial<TradePlan> | null): AnalysisRecord {
  const tradePlan: TradePlan | undefined =
    plan === null ? undefined : { decision: 'WAIT_FOR_SETUP', reason: 'Chờ LPSY', reconsiderWhen: '', setups: [setup()], ...plan };
  const result = {
    id: over.id ?? 'a1',
    createdAt: T0 * 1000,
    tradePlan,
    action: { type: 'WAIT', takeProfits: [], condition: '' },
  } as unknown as AnalysisResult;
  return { id: 'a1', symbol: 'BTCUSDT', primaryTf: '4h', tfs: ['4h'], status: 'DONE', createdAt: T0 * 1000, finishedAt: T0 * 1000, result, ...over };
}

const candle = (time: number, low: number, high: number, open = (low + high) / 2): Candle => ({ time, open, high, low, close: open, volume: 1 });

function armed(over: Partial<PriceAlert> = {}): PriceAlert {
  const [a] = alertsFromRecord(record(), T0, 72);
  return { ...a!, id: 1, status: 'ARMED', statusAt: T0, ...over };
}

describe('alertsFromRecord', () => {
  it('lọc setup: STAND_ASIDE, MARKET khi ENTER, không tradePlan', () => {
    expect(alertsFromRecord(record(), T0, 72)).toHaveLength(1);
    expect(alertsFromRecord(record({}, { decision: 'STAND_ASIDE' }), T0, 72)).toEqual([]);
    expect(alertsFromRecord(record({}, null), T0, 72)).toEqual([]);
    const enter = record({}, { decision: 'ENTER', setups: [setup({ entryType: 'MARKET' }), setup({ entryType: 'STOP', direction: 'LONG', entryLow: 68000, entryHigh: 68100, stopLoss: 67000 })] });
    const list = alertsFromRecord(enter, T0, 72);
    expect(list.map(a => [a.setupIndex, a.entryType])).toEqual([[1, 'STOP']]);
    expect(alertsFromRecord(record({ status: 'FAILED' }), T0, 72)).toEqual([]);
  });

  it('hạn: validUntil của setup, thiếu → maxAgeH; đã quá hạn → bỏ', () => {
    expect(alertsFromRecord(record(), T0, 72)[0]!.validUntil).toBe(T0 + 72 * 3600);
    expect(alertsFromRecord(record({}, { setups: [setup({ validUntil: T0 + 600 })] }), T0, 72)[0]!.validUntil).toBe(T0 + 600);
    expect(alertsFromRecord(record({}, { setups: [setup({ validUntil: T0 - 1 })] }), T0, 72)).toEqual([]);
  });
});

describe('evaluateCandles', () => {
  it('chạm vùng theo high/low (râu nến), giá = open kẹp vào vùng', () => {
    const a = armed();
    expect(evaluateCandles(a, [candle(M0, 67000, 67300)], T0 + 60)).toEqual({ status: 'ARMED', checkedUntil: M0 });
    const ev = evaluateCandles(a, [candle(M0, 67000, 67300), candle(M0 + 60, 67250, 67420, 67300)], T0 + 120);
    expect(ev).toEqual({ status: 'TRIGGERED', price: 67400, at: M0 + 60 });
  });

  it('bỏ nến trước lúc đặt và nến đã kiểm', () => {
    const a = armed({ checkedUntil: M0 + 60 });
    expect(evaluateCandles(a, [candle(M0 - 60, 67450, 67460), candle(M0 + 60, 67450, 67460)], T0 + 180)).toEqual({ status: 'ARMED' });
  });

  it('chạm SL trước entry → INVALIDATED; cùng nến chạm cả hai → TRIGGERED kèm ghi chú', () => {
    const a = armed();
    // SHORT: SL 67900 trên vùng; nến nhảy qua cả vùng lên SL → cùng nến.
    expect(evaluateCandles(a, [candle(M0, 67300, 67950, 67300)], T0 + 60)).toMatchObject({ status: 'TRIGGERED', note: NOTE_SL_SAME_CANDLE, price: 67400 });
    // LONG: giá rơi thủng SL mà chưa lên vùng (vùng trên giá: STOP LONG).
    const long = armed({ direction: 'LONG', entryLow: 68000, entryHigh: 68100, stopLoss: 67000 });
    expect(evaluateCandles(long, [candle(M0, 66900, 67500)], T0 + 60)).toMatchObject({ status: 'INVALIDATED' });
  });

  it('STOP có SL nằm giữa giá lúc đặt và entry → không huỷ khi giá đi qua SL', () => {
    // SHORT STOP 612.5, SL 615, giá lúc đặt 617 (đã trên SL).
    const a = armed({ entryType: 'STOP', entryLow: 612.5, entryHigh: 612.5, stopLoss: 615, armPrice: 617 });
    expect(evaluateCandles(a, [candle(M0, 616, 618)], T0 + 60)).toEqual({ status: 'ARMED', checkedUntil: M0 });
    expect(evaluateCandles(a, [candle(M0, 612, 616, 616)], T0 + 60)).toEqual({ status: 'TRIGGERED', price: 612.5, at: M0 });
    expect(evaluatePrice(a, 616, T0)).toEqual({ status: 'ARMED' });
    // Giá lúc đặt dưới SL → luật SL áp dụng bình thường.
    expect(evaluateCandles({ ...a, armPrice: 614 }, [candle(M0, 614, 615.5)], T0 + 60)).toMatchObject({ status: 'INVALIDATED' });
  });

  it('hết hạn khi nến đã phủ tới validUntil (hoặc quá hạn + 10 phút)', () => {
    const a = armed({ validUntil: M0 + 120 });
    expect(evaluateCandles(a, [candle(M0, 67000, 67100), candle(M0 + 60, 67000, 67100)], M0 + 180)).toMatchObject({ status: 'EXPIRED' });
    expect(evaluateCandles(a, [candle(M0, 67000, 67100)], M0 + 180)).toEqual({ status: 'ARMED', checkedUntil: M0 });
    expect(evaluateCandles(a, [], M0 + 120 + 600)).toMatchObject({ status: 'EXPIRED' });
    // Nến sau hạn không tính chạm.
    expect(evaluateCandles(a, [candle(M0 + 120, 67400, 67500)], M0 + 200)).toMatchObject({ status: 'ARMED' });
  });

  it('evaluatePrice: giá trong vùng / vượt SL', () => {
    const a = armed();
    expect(evaluatePrice(a, 67450, T0, NOTE_IN_ZONE)).toEqual({ status: 'TRIGGERED', price: 67450, at: T0, note: NOTE_IN_ZONE });
    expect(evaluatePrice(a, 68000, T0)).toMatchObject({ status: 'INVALIDATED' });
    expect(evaluatePrice(a, 67000, T0)).toEqual({ status: 'ARMED' });
  });

  it('formatAlert theo mẫu', () => {
    expect(formatAlert(armed(), { price: 67452 }, T0 * 1000, TZ)).toBe(
      '🔔 <b>BTCUSDT</b> chạm entry ① <b>SHORT</b> LIMIT 1m · vùng 67,400–67,500 · giá 67,452 · SL 67,900 · TP 66,600 / 66,050 · R:R 4.11 · phân tích 12:34 14/11',
    );
    expect(formatAlert(armed(), { price: 67452, note: NOTE_IN_ZONE }, undefined, TZ)).toMatch(/R:R 4\.11\n<i>đang ở trong vùng entry<\/i>$/);
  });
});

// ---------- Repo + watcher (SQLite trong bộ nhớ, kline / đồng hồ / sender giả) ----------

let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

function harness(opts: { price?: number; dest?: AlertDestination; feed?: CollectorPriceFeed } = {}) {
  db = openDb(':memory:');
  const repo = new AlertRepo(db);
  let now = T0 * 1000;
  let candles: Candle[] = [];
  const price = { value: opts.price ?? 67000 };
  const sent: { chatId: string; text: string; replyTo?: number; threadId?: number | null }[] = [];
  const kcalls: GetKlinesOptions[] = [];
  const records = new Map<string, AnalysisRecord>();
  const events: ProgressEvent[] = [];
  const make = () => {
    const w = new AlertWatcher({
      repo,
      klines: {
        getKlines: async o => {
          kcalls.push(o);
          if (!o.closedOnly) return { candles: [candle(Math.floor(now / 60_000) * 60, price.value, price.value, price.value)] };
          const nowSec = now / 1000;
          return { candles: candles.filter(c => c.time + 60 <= nowSec).slice(-o.limit) };
        },
      },
      isCrypto: s => s !== 'XAUUSD',
      getRecord: id => records.get(id) ?? null,
      maxAgeH: 72,
      sender: { sendMessage: async (chatId, text, send) => void sent.push({ chatId, text, ...send }) },
      destinationOf: () => opts.dest ?? { chatId: '42' },
      priceFeed: opts.feed,
      timeZone: TZ,
      now: () => now,
      log: () => {},
    });
    w.subscribe(e => events.push(e));
    return w;
  };
  return {
    repo,
    sent,
    kcalls,
    events,
    records,
    price,
    make,
    setNow: (sec: number) => (now = sec * 1000),
    setCandles: (c: Candle[]) => (candles = c),
    add: (rec: AnalysisRecord) => (records.set(rec.id, rec), rec),
  };
}

describe('AlertWatcher', () => {
  it('đặt alert, chạm một lần dù kiểm nhiều lần; trả lời vào album', async () => {
    const h = harness({ dest: { chatId: '-100', threadId: 7, replyTo: 555 } });
    const w = h.make();
    await w.onResult(h.add(record()));
    expect(h.repo.armed()).toHaveLength(1);
    expect(h.repo.armed()[0]!.armPrice).toBe(67000);
    h.setCandles([candle(M0, 67000, 67100), candle(M0 + 60, 67300, 67420, 67300)]);
    h.setNow(M0 + 60 + 3);
    await w.check();
    expect(h.repo.armed()[0]!.checkedUntil).toBe(M0);
    h.setNow(M0 + 120 + 3);
    await w.check();
    await w.check();
    await w.idle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ chatId: '-100', threadId: 7, replyTo: 555 });
    expect(h.sent[0]!.text).toContain('chạm entry ①');
    expect(h.repo.byAnalysis('a1')[0]).toMatchObject({ status: 'TRIGGERED', triggerPrice: 67400 });
    expect(h.events.filter(e => e.kind === 'alert').map(e => e.kind === 'alert' && e.alert.status)).toEqual(['ARMED', 'TRIGGERED']);
  });

  it('chạm SL trước → huỷ, không báo; hết hạn → EXPIRED', async () => {
    const h = harness();
    const w = h.make();
    await w.onResult(h.add(record({}, { setups: [setup(), setup({ validUntil: M0 + 120 })] })));
    h.setCandles([candle(M0, 67000, 67100), candle(M0 + 60, 67000, 67100)]);
    h.setNow(M0 + 180 + 3);
    await w.check();
    expect(h.repo.byAnalysis('a1').map(a => a.status)).toEqual(['ARMED', 'EXPIRED']);
    h.setCandles([candle(M0 + 180, 67600, 67950, 67600)]);
    // SHORT, giá từ trên vùng (67,600) lên SL mà nến không chạm vùng → INVALIDATED.
    h.setNow(M0 + 240 + 3);
    await w.check();
    await w.idle();
    expect(h.repo.byAnalysis('a1')[0]!.status).toBe('INVALIDATED');
    expect(h.sent).toEqual([]);
  });

  it('phân tích mới cùng symbol → REPLACED; symbol khác giữ nguyên; XAUUSD không đặt', async () => {
    const h = harness();
    const w = h.make();
    await w.onResult(h.add(record()));
    await w.onResult(h.add(record({ id: 'e1', symbol: 'ETHUSDT' })));
    await w.onResult(h.add(record({ id: 'a2' }, { setups: [] })));
    await w.onResult(h.add(record({ id: 'x1', symbol: 'XAUUSD' })));
    expect(h.repo.byAnalysis('a1')[0]!.status).toBe('REPLACED');
    expect(h.repo.byAnalysis('e1')[0]!.status).toBe('ARMED');
    expect(h.repo.byAnalysis('a2')).toEqual([]);
    expect(h.repo.byAnalysis('x1')).toEqual([]);
    // Phát lại result của a1 → không đặt lại, không thay alert khác.
    await w.onResult(h.add(record()));
    expect(h.repo.byAnalysis('a1')).toHaveLength(1);
  });

  it('giá đã trong vùng lúc đặt → báo ngay', async () => {
    const h = harness({ price: 67450 });
    const w = h.make();
    await w.onResult(h.add(record()));
    await w.idle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain(NOTE_IN_ZONE);
    expect(h.repo.byAnalysis('a1')[0]!.status).toBe('TRIGGERED');
  });

  it('restart: watcher mới kiểm bù nến từ lần kiểm cuối, không báo trùng', async () => {
    const h = harness();
    const w1 = h.make();
    await w1.onResult(h.add(record()));
    h.setCandles([candle(M0, 67000, 67100)]);
    h.setNow(M0 + 63);
    await w1.check();
    // "Tắt server" 2 giờ; trong lúc đó giá chạm vùng.
    const touch = M0 + 3600;
    h.setCandles([candle(M0, 67000, 67100), candle(touch, 67380, 67410, 67390)]);
    h.setNow(M0 + 7200 + 3);
    const w2 = h.make();
    await w2.check();
    await w2.check();
    const w3 = h.make();
    await w3.check();
    await w2.idle();
    await w3.idle();
    expect(h.sent).toHaveLength(1);
    expect(h.repo.byAnalysis('a1')[0]).toMatchObject({ status: 'TRIGGERED', statusAt: touch });
    // Lần kiểm bù lấy đủ nến từ sau checkedUntil.
    expect(h.kcalls[2]).toMatchObject({ tf: '1m', closedOnly: true, limit: (M0 + 7200 - 60 - (M0 + 60)) / 60 + 1 });
  });

  it('đường nhanh: giá khớp − basis chạm vùng → báo ngay đúng một lần; đã vượt SL thì để nến 1m quyết định', async () => {
    const listeners: PriceListener[] = [];
    const feed = new CollectorPriceFeed({
      sources: { BTCUSDT: { onTrade: l => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)) } },
      basisOf: async () => 30,
    });
    const h = harness({ feed });
    const w = h.make();
    w.start(() => () => {});
    await w.onResult(h.add(record({}, { setups: [setup(), setup({ direction: 'LONG', entryLow: 66000, entryHigh: 66100, stopLoss: 65500 })] })));
    expect(listeners).toHaveLength(1);
    const tick = (p: number, sec: number) => listeners.forEach(l => l(p, sec * 1000));
    tick(67000, T0 + 1); // chưa có basis → bỏ qua, đang tải
    await new Promise(r => setTimeout(r, 0));
    tick(67430, T0 + 2); // 67,400 sau basis → chạm SHORT
    tick(67440, T0 + 2);
    await w.idle();
    expect(h.sent).toHaveLength(1);
    expect(h.repo.byAnalysis('a1').map(a => [a.status, a.triggerPrice])).toEqual([
      ['TRIGGERED', 67400],
      ['ARMED', undefined],
    ]);
    tick(65480, T0 + 3); // LONG thủng SL qua đường nhanh
    tick(66080, T0 + 4); // quay lại vùng → không báo qua đường nhanh
    await w.idle();
    expect(h.sent).toHaveLength(1);
    expect(h.repo.byAnalysis('a1')[1]!.status).toBe('ARMED');
  });

  it('cancelSymbol (bot /alerts off)', async () => {
    const h = harness();
    const w = h.make();
    await w.onResult(h.add(record()));
    expect(w.listArmed()).toHaveLength(1);
    expect(await w.cancelSymbol('BTCUSDT')).toBe(1);
    expect(await w.cancelSymbol('BTCUSDT')).toBe(0);
    expect(h.repo.byAnalysis('a1')[0]!.status).toBe('CANCELED');
  });
});

describe('Telegram: lưu message_id album, lệnh /alerts', () => {
  it('client trả message_id; notifier lưu tin đầu của album', async () => {
    const responses = [{ ok: true, result: [{ message_id: 11 }, { message_id: 12 }] }, { ok: true, result: { message_id: 20 } }];
    const fetchImpl = (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as unknown as typeof fetch;
    const client = new TelegramClient({ token: '1:X', fetchImpl });
    const png = (n: number) => ({ data: Buffer.from([n]), filename: `${n}.png` });
    expect(await client.sendPhotos('1', [png(1), png(2)], 'c')).toEqual([11, 12]);
    expect(await client.sendMessage('1', 'x')).toEqual([20]);

    db = openDb(':memory:');
    const store = new TelegramMessageStore(db);
    const notifier = new TelegramNotifier({
      chatId: '42',
      sender: { sendMessage: async () => [1], sendPhotos: async () => [77, 78] },
      capture: async (_id, shots) => shots.map(() => Buffer.from([1])),
      tfs: 'primary',
      notifyFailed: true,
      messages: store,
      log: () => {},
    });
    notifier.setRouter(rec => (rec.id === 'bot1' ? { chatId: '-100', threadId: null, replyTo: 5 } : undefined));
    const rec = { ...record(), result: { ...record().result!, tfs: ['4h'], topDown: [], summary: '', bias: 'BEARISH', schematic: 'DISTRIBUTION', confidence: 0.5, events: [], ranges: [], phases: [], levels: [], scenarios: [], tfConflicts: [], warnings: [] } } as AnalysisRecord;
    notifier.enqueue(rec);
    notifier.enqueue({ ...rec, id: 'bot1' });
    await notifier.idle();
    expect(store.first('a1')).toEqual({ chatId: '42', messageId: 77 });
    expect(store.first('bot1')).toEqual({ chatId: '-100', threadId: null, messageId: 77 });
    expect(store.first('none')).toBeNull();
  });

  it('parseCommand /alerts', () => {
    const d = { primaryTf: '4h' as const, contextTfs: [] };
    expect(parseCommand('/alerts', 'B', d)).toEqual({ cmd: 'alerts' });
    expect(parseCommand('/alerts off btcusdt', 'B', d)).toEqual({ cmd: 'alerts', off: 'BTCUSDT' });
    expect(parseCommand('/alerts off', 'B', d)).toMatchObject({ cmd: 'error' });
    expect(parseCommand('/alerts xyz', 'B', d)).toMatchObject({ cmd: 'error' });
  });
});
