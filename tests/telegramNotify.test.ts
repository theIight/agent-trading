import { describe, expect, it } from 'vitest';
import type { AnalysisRecord, AnalysisResult, ProgressEvent, TradeSetup } from '@wca/shared';
import { CAPTION_LIMIT, escapeHtml, fitEscaped, formatCaption, formatFailure, snapshotHiddenLayers, snapshotShots, snapshotTfs } from '../apps/server/src/notify/telegramFormat.ts';
import { TelegramClient } from '../apps/server/src/notify/telegramClient.ts';
import { TelegramNotifier, type TelegramSender } from '../apps/server/src/notify/telegramNotifier.ts';
import { parseSnapshotParams } from '../apps/web/src/snapshotMode.ts';

const TZ = 'Asia/Ho_Chi_Minh';
const FINISHED = Date.UTC(2026, 10, 14, 5, 34); // 12:34 giờ VN

const setup = (over: Partial<TradeSetup> = {}): TradeSetup => ({
  name: 'Long LPS',
  direction: 'LONG',
  entryType: 'LIMIT',
  tf: '1h',
  trigger: 'LPS',
  triggerNote: '',
  entryLow: 94200,
  entryHigh: 94500,
  stopLoss: 93600,
  takeProfits: [96000, 97500],
  confidence: 0.6,
  rationale: '',
  riskReward: 2.8,
  ...over,
});

function result(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    id: 'a1',
    createdAt: FINISHED,
    asOf: 1,
    tfs: ['1d', '4h', '1h'],
    symbol: 'BTCUSDT',
    primaryTf: '4h',
    schematic: 'ACCUMULATION',
    currentPhase: 'C',
    bias: 'BULLISH',
    confidence: 0.7,
    summary: 'Spring <test> & LPS giữ',
    topDown: [{ tf: '4h', role: 'PRIMARY', bias: 'BULLISH', phase: 'C', schematic: 'ACCUMULATION', note: '' }],
    events: [],
    ranges: [],
    phases: [],
    levels: [],
    scenarios: [],
    tfConflicts: [],
    tradePlan: { decision: 'WAIT_FOR_SETUP', reason: 'Chờ LPS', reconsiderWhen: '', setups: [setup()] },
    action: { type: 'WAIT', takeProfits: [], condition: '' },
    model: 'claude-code · opus',
    warnings: [],
    ...over,
  };
}

const record = (over: Partial<AnalysisRecord> = {}): AnalysisRecord => ({
  id: 'a1',
  symbol: 'BTCUSDT',
  primaryTf: '4h',
  tfs: ['4h', '1d', '1h'],
  status: 'DONE',
  createdAt: FINISHED - 60_000,
  finishedAt: FINISHED,
  result: result(),
  ...over,
});

describe('telegramFormat', () => {
  it('caption đủ dòng, escape HTML nội dung agent, R:R của server', () => {
    const c = formatCaption(record(), { timeZone: TZ });
    expect(c.split('\n')).toEqual([
      '<b>BTCUSDT · 4h</b> (1d → 4h → 1h)',
      'BULLISH 70% · Pha C · Accumulation',
      'Quyết định: <b>Chờ setup</b>',
      '① <b>LONG</b> LIMIT 1h · Entry 94,200–94,500 · SL 93,600 · TP 96,000 / 97,500 · R:R 2.80',
      '',
      'Spring &lt;test&gt; &amp; LPS giữ',
      'claude-code · opus · 12:34 14/11',
    ]);
  });

  it('tóm tắt dài bị cắt để caption ≤ 1024, giữ phần kế hoạch', () => {
    const c = formatCaption(record({ result: result({ summary: '<x> '.repeat(800) }) }), { timeZone: TZ });
    expect(c.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(c).toContain('R:R 2.80');
    expect(c).toContain('…');
    expect(c).not.toMatch(/&[a-z]*…/); // không cắt giữa entity
  });

  it('đứng ngoài có "Xem lại khi"; bản ghi cũ dùng action', () => {
    const aside = formatCaption(
      record({ result: result({ tradePlan: { decision: 'STAND_ASIDE', reason: 'x', reconsiderWhen: 'Phá 100k', setups: [] } }) }),
      { timeZone: TZ },
    );
    expect(aside).toContain('Quyết định: <b>Đứng ngoài</b>\nXem lại khi: Phá 100k');
    const legacy = formatCaption(
      record({ result: result({ tradePlan: undefined, action: { type: 'SHORT', entry: 100, stopLoss: 105, takeProfits: [90], riskReward: 2, condition: '' } }) }),
      { timeZone: TZ },
    );
    expect(legacy).toContain('Hành động: <b>SHORT</b> · Entry 100 · SL 105 · TP 90 · R:R 2.00');
  });

  it('tin lỗi, fitEscaped, khung chụp top-down', () => {
    const f = formatFailure(record({ status: 'FAILED', result: undefined, error: 'a<b' }), { timeZone: TZ });
    expect(f).toBe('❌ <b>BTCUSDT · 4h</b> phân tích lỗi (12:34 14/11)\na&lt;b');
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
    expect(fitEscaped('abcdef', 4)).toBe('abc…');
    expect(fitEscaped('&&&&', 6)).toBe('&amp;…');
    expect(snapshotTfs(record(), 'all')).toEqual(['1d', '4h', '1h']);
    expect(snapshotTfs(record(), 'primary')).toEqual(['4h']);
  });

  it('ảnh khung lớn ẩn Setup + Mức giá; khung chính / nhỏ giữ đủ', () => {
    expect(snapshotShots(record(), 'all')).toEqual([
      { tf: '1d', hide: ['action', 'levels'] },
      { tf: '4h', hide: [] },
      { tf: '1h', hide: [] },
    ]);
    expect(snapshotHiddenLayers('1d', '1h')).toEqual(['action', 'levels']);
    expect(snapshotHiddenLayers('4h', '1h')).toEqual(['action', 'levels']);
    expect(snapshotHiddenLayers('1m', '4h')).toEqual([]);
    expect(snapshotHiddenLayers('xx', '4h')).toEqual([]);
  });
});

describe('TelegramClient', () => {
  const TOKEN = '123:SECRET';
  function fake(responses: { status: number; body: unknown }[]) {
    const calls: { url: string; body: FormData }[] = [];
    const sleeps: number[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as FormData });
      const r = responses.shift() ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl, sleep: async ms => void sleeps.push(ms), retryDelayMs: 5 });
    return { client, calls, sleeps };
  }
  const png = (n: number) => ({ data: Buffer.from([n]), filename: `${n}.png` });

  it('1 ảnh → sendPhoto; nhiều ảnh → sendMediaGroup, caption ở ảnh đầu', async () => {
    const { client, calls } = fake([]);
    await client.sendPhotos('42', [png(1)], 'cap');
    await client.sendPhotos('42', [png(1), png(2), png(3)], 'cap');
    expect(calls[0]!.url).toMatch(/\/sendPhoto$/);
    expect(calls[0]!.body.get('caption')).toBe('cap');
    expect(calls[1]!.url).toMatch(/\/sendMediaGroup$/);
    const media = JSON.parse(String(calls[1]!.body.get('media'))) as { media: string; caption?: string }[];
    expect(media.map(m => m.media)).toEqual(['attach://p0', 'attach://p1', 'attach://p2']);
    expect(media[0]!.caption).toBe('cap');
    expect(media[1]!.caption).toBeUndefined();
    expect(calls[1]!.body.get('p2')).toBeInstanceOf(Blob);
  });

  it('429 → chờ retry_after rồi thử lại; lỗi 400 không thử lại, thông điệp không lộ token', async () => {
    const a = fake([{ status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } } }]);
    await a.client.sendMessage('42', 'hi');
    expect(a.calls).toHaveLength(2);
    expect(a.sleeps).toEqual([3000]);

    const b = fake([{ status: 400, body: { ok: false, description: `Bad Request: chat not found ${TOKEN}` } }]);
    const err = await b.client.sendMessage('42', 'hi').catch((e: Error) => e);
    expect(b.calls).toHaveLength(1);
    expect(String(err)).toContain('chat not found');
    expect(String(err)).not.toContain('SECRET');
  });

  it('threadId → message_thread_id ở mọi request', async () => {
    const calls: FormData[] = [];
    const client = new TelegramClient({
      token: TOKEN,
      threadId: 2052,
      fetchImpl: (async (_u: string, init: RequestInit) => (calls.push(init.body as FormData), new Response('{"ok":true}'))) as unknown as typeof fetch,
    });
    await client.sendMessage('-100', 'x');
    await client.sendPhotos('-100', [png(1), png(2)], 'c');
    expect(calls.map(f => f.get('message_thread_id'))).toEqual(['2052', '2052']);
  });

  it('lỗi mạng: thử lại tối đa 2 lần rồi báo lỗi không kèm URL', async () => {
    let n = 0;
    const client = new TelegramClient({
      token: TOKEN,
      fetchImpl: (async () => {
        n++;
        throw new Error(`connect failed https://api.telegram.org/bot${TOKEN}/sendMessage`);
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    const err = await client.sendMessage('1', 'x').catch((e: Error) => e);
    expect(n).toBe(3);
    expect(String(err)).not.toContain('SECRET');
  });
});

describe('TelegramNotifier', () => {
  function make(opts: { capture?: () => Promise<Buffer[]>; notifyFailed?: boolean } = {}) {
    const sent: { kind: 'msg' | 'photos'; text: string; n?: number }[] = [];
    const sender: TelegramSender = {
      sendMessage: async (_c, text) => void sent.push({ kind: 'msg', text }),
      sendPhotos: async (_c, photos, caption) => void sent.push({ kind: 'photos', text: caption, n: photos.length }),
    };
    const captured: string[][] = [];
    const logs: string[] = [];
    const n = new TelegramNotifier({
      chatId: '42',
      sender,
      capture: opts.capture ?? (async (_id, shots) => (captured.push(shots.map(s => s.tf)), shots.map(() => Buffer.from([1])))),
      tfs: 'all',
      notifyFailed: opts.notifyFailed ?? true,
      log: m => logs.push(m),
    });
    return { n, sent, captured, logs };
  }

  it('DONE gửi album theo khung top-down, đúng một lần; CANCELED bỏ', async () => {
    const { n, sent, captured } = make();
    n.enqueue(record());
    n.enqueue(record());
    n.enqueue(record({ id: 'c', status: 'CANCELED', result: undefined }));
    await n.idle();
    expect(captured).toEqual([['1d', '4h', '1h']]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'photos', n: 3 });
  });

  it('FAILED gửi chữ theo cờ; chụp lỗi → vẫn gửi caption dạng chữ', async () => {
    const a = make();
    a.n.enqueue(record({ id: 'f', status: 'FAILED', result: undefined, error: 'hết giờ' }));
    await a.n.idle();
    expect(a.sent[0]!.text).toContain('hết giờ');

    const b = make({ notifyFailed: false });
    b.n.enqueue(record({ id: 'f', status: 'FAILED', result: undefined }));
    await b.n.idle();
    expect(b.sent).toHaveLength(0);

    const c = make({ capture: async () => Promise.reject(new Error('no chrome')) });
    c.n.enqueue(record());
    await c.n.idle();
    expect(c.sent[0]!.kind).toBe('msg');
    expect(c.sent[0]!.text).toContain('Không chụp được chart');
    expect(c.logs.join()).toContain('no chrome');
  });

  it('lỗi gửi chỉ log, hàng đợi vẫn chạy tiếp', async () => {
    const logs: string[] = [];
    let calls = 0;
    const n = new TelegramNotifier({
      chatId: '42',
      sender: {
        sendMessage: async () => {},
        sendPhotos: async () => {
          if (++calls === 1) throw new Error('boom');
        },
      },
      capture: async (_id, shots) => shots.map(() => Buffer.from([1])),
      tfs: 'primary',
      notifyFailed: true,
      log: m => logs.push(m),
    });
    n.enqueue(record({ id: 'x' }));
    n.enqueue(record({ id: 'y' }));
    await n.idle();
    expect(calls).toBe(2);
    expect(logs.some(l => l.includes('boom'))).toBe(true);
  });

  it('start() chỉ nghe sự kiện result', async () => {
    const { n, sent } = make();
    const handlers: ((e: ProgressEvent) => void)[] = [];
    const stop = n.start(l => (handlers.push(l), () => handlers.splice(0)));
    handlers[0]!({ kind: 'status', analysisId: 'a1', status: 'DONE' });
    handlers[0]!({ kind: 'result', analysisId: 'a1', record: record() });
    await n.idle();
    stop();
    expect(sent).toHaveLength(1);
    expect(handlers).toHaveLength(0);
  });
});

describe('parseSnapshotParams', () => {
  it('nhận id + tf hợp lệ, từ chối còn lại', () => {
    expect(parseSnapshotParams('?snapshot=abc-1_2&tf=4h')).toEqual({ id: 'abc-1_2', tf: '4h', hide: [] });
    expect(parseSnapshotParams('?snapshot=abc&tf=1d&hide=action,levels,evil,action')).toEqual({ id: 'abc', tf: '1d', hide: ['action', 'levels'] });
    expect(parseSnapshotParams('?snapshot=abc&tf=7h')).toBeNull();
    expect(parseSnapshotParams('?snapshot=a/b&tf=4h')).toBeNull();
    expect(parseSnapshotParams('?tf=4h')).toBeNull();
    expect(parseSnapshotParams('')).toBeNull();
  });
});
