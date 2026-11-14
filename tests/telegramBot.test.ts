import { describe, expect, it } from 'vitest';
import type { AnalysisRecord, AnalysisResult, ProgressEvent } from '@wca/shared';
import { parseCommand, type CommandDefaults } from '../apps/server/src/notify/telegramCommands.ts';
import { TelegramBot, type BotApi, type BotService } from '../apps/server/src/notify/telegramBot.ts';
import { TelegramClient, type SendOptions, type TgMessage } from '../apps/server/src/notify/telegramClient.ts';
import { TelegramNotifier, type Destination } from '../apps/server/src/notify/telegramNotifier.ts';

const D: CommandDefaults = { primaryTf: '4h', contextTfs: ['1d', '1h', '1m'] };

describe('parseCommand', () => {
  it('analyze: mặc định, chỉ khung chính, tự chọn, cờ runner/model', () => {
    expect(parseCommand('/analyze btcusdt', 'WyBot', D)).toEqual({ cmd: 'analyze', symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: ['1d', '1h', '1m'] });
    expect(parseCommand('/analyze BTCUSDT 1h', 'WyBot', D)).toEqual({ cmd: 'analyze', symbol: 'BTCUSDT', primaryTf: '1h', contextTfs: ['4h', '1d', '1m'] });
    expect(parseCommand('/analyze@wybot ETHUSDT 4H 1D 1h runner=agy model=gpt-x', 'WyBot', D)).toEqual({
      cmd: 'analyze',
      symbol: 'ETHUSDT',
      primaryTf: '4h',
      contextTfs: ['1d', '1h'],
      runner: 'agy',
      model: 'gpt-x',
    });
  });

  it('lỗi cú pháp, lệnh cho bot khác, lệnh lạ', () => {
    expect(parseCommand('/analyze', 'WyBot', D)).toMatchObject({ cmd: 'error' });
    expect(parseCommand('/analyze BTCUSDT 7h', 'WyBot', D)).toEqual({ cmd: 'error', error: 'Khung không hỗ trợ: 7h' });
    expect(parseCommand('/analyze@OtherBot BTCUSDT', 'WyBot', D)).toBeNull();
    expect(parseCommand('/foo', 'WyBot', D)).toBeNull();
    expect(parseCommand('chào bot', 'WyBot', D)).toBeNull();
    expect(parseCommand(undefined, 'WyBot', D)).toBeNull();
    expect(parseCommand('/last', 'WyBot', D)).toEqual({ cmd: 'last' });
    expect(parseCommand('/last xauusd', 'WyBot', D)).toEqual({ cmd: 'last', symbol: 'XAUUSD' });
    expect(parseCommand('/start', 'WyBot', D)).toEqual({ cmd: 'help' });
  });
});

describe('TelegramClient (bot)', () => {
  const TOKEN = '123:SECRET';
  function fake(result: unknown = true) {
    const calls: { url: string; body: FormData }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as FormData });
      return new Response(JSON.stringify({ ok: true, result }));
    }) as unknown as typeof fetch;
    return { client: new TelegramClient({ token: TOKEN, threadId: 7, fetchImpl }), calls };
  }

  it('reply_parameters + topic theo từng lần gửi; threadId null bỏ topic mặc định', async () => {
    const { client, calls } = fake();
    await client.sendMessage('1', 'x', { replyTo: 55, threadId: 9 });
    await client.sendMessage('1', 'x', { threadId: null });
    await client.sendMessage('1', 'x');
    expect(JSON.parse(String(calls[0]!.body.get('reply_parameters')))).toEqual({ message_id: 55, allow_sending_without_reply: true });
    expect(calls.map(c => c.body.get('message_thread_id'))).toEqual(['9', null, '7']);
  });

  it('getMe không tham số → GET không body (multipart rỗng bị Telegram trả 400)', async () => {
    const inits: RequestInit[] = [];
    const client = new TelegramClient({
      token: TOKEN,
      fetchImpl: (async (_u: string, init: RequestInit) => (inits.push(init), new Response('{"ok":true,"result":{"id":1,"username":"B"}}'))) as unknown as typeof fetch,
    });
    expect(await client.getMe()).toEqual({ id: 1, username: 'B' });
    expect(inits[0]!.method).toBe('GET');
    expect(inits[0]!.body).toBeUndefined();
  });

  it('getUpdates trả result, gửi offset/timeout', async () => {
    const { client, calls } = fake([{ update_id: 3 }]);
    expect(await client.getUpdates(10, 30)).toEqual([{ update_id: 3 }]);
    expect(calls[0]!.url).toMatch(/\/getUpdates$/);
    expect(calls[0]!.body.get('offset')).toBe('10');
    expect(calls[0]!.body.get('timeout')).toBe('30');
  });
});

const result = { tfs: ['1d', '4h', '1h'], summary: 's', bias: 'BULLISH', confidence: 0.6, schematic: 'ACCUMULATION', createdAt: 1 } as unknown as AnalysisResult;
const rec = (over: Partial<AnalysisRecord> = {}): AnalysisRecord => ({
  id: 'r1',
  symbol: 'BTCUSDT',
  primaryTf: '4h',
  tfs: ['1d', '4h', '1h'],
  status: 'DONE',
  createdAt: 1,
  finishedAt: 2,
  result: { ...result, action: { type: 'WAIT', takeProfits: [] } } as AnalysisResult,
  ...over,
});

describe('TelegramNotifier route', () => {
  function make() {
    const sent: { chatId: string; text: string; send?: SendOptions; photos?: number }[] = [];
    const n = new TelegramNotifier({
      chatId: 'main',
      sender: {
        sendMessage: async (chatId, text, send) => void sent.push({ chatId, text, send }),
        sendPhotos: async (chatId, photos, text, send) => void sent.push({ chatId, text, send, photos: photos.length }),
      },
      capture: async (_id, shots) => shots.map(() => Buffer.from([1])),
      tfs: 'all',
      notifyFailed: false,
      log: () => {},
    });
    return { n, sent };
  }

  it('phân tích bot tạo → gửi về chat lệnh, reply; FAILED/CANCELED luôn báo; web → chat chính', async () => {
    const { n, sent } = make();
    const routes = new Map<string, Destination>([
      ['b1', { chatId: 'g', threadId: null, replyTo: 5, requested: true }],
      ['b2', { chatId: 'g', replyTo: 6, requested: true }],
      ['b3', { chatId: 'g', replyTo: 7, requested: true }],
    ]);
    n.setRouter(r => routes.get(r.id));
    n.enqueue(rec({ id: 'b1' }));
    n.enqueue(rec({ id: 'b2', status: 'FAILED', result: undefined, error: 'x' }));
    n.enqueue(rec({ id: 'b3', status: 'CANCELED', result: undefined }));
    n.enqueue(rec({ id: 'w1', status: 'FAILED', result: undefined }));
    n.enqueue(rec({ id: 'w2' }));
    await n.idle();
    expect(sent.map(s => [s.chatId, s.send?.replyTo, s.photos ?? 0])).toEqual([
      ['g', 5, 3],
      ['g', 6, 0],
      ['g', 7, 0],
      ['main', undefined, 3],
    ]);
    expect(sent[0]!.send).toEqual({ threadId: null, replyTo: 5 });
    expect(sent[2]!.text).toContain('Đã huỷ');
  });

  it('resend gửi lại kể cả đã gửi', async () => {
    const { n, sent } = make();
    n.enqueue(rec());
    await n.resend(rec(), { chatId: 'g', replyTo: 1 });
    expect(sent).toHaveLength(2);
  });
});

describe('TelegramBot', () => {
  const NOW = 1_800_000_000_000;
  function make(over: { maxPending?: number; startError?: string; allowedUsers?: string[] } = {}) {
    const replies: { chatId: string; text: string; send?: SendOptions }[] = [];
    const resent: Destination[] = [];
    const started: { symbol: string; primaryTf: string; contextTfs: string[] }[] = [];
    const canceled: string[] = [];
    const records = new Map<string, AnalysisRecord>([['old', rec({ id: 'old' })]]);
    const listeners: ((e: ProgressEvent) => void)[] = [];
    let router: ((r: AnalysisRecord) => Destination | undefined) | null = null;
    let seq = 0;
    const queue: string[] = [];
    const service: BotService = {
      start: input => {
        if (over.startError) throw new Error(over.startError);
        started.push(input);
        const r = rec({ id: `id-${++seq}-xxxxxxxx`, symbol: input.symbol, primaryTf: input.primaryTf as '4h', tfs: [input.primaryTf as '4h'], status: 'RUNNING', result: undefined });
        records.set(r.id, r);
        queue.push(r.id);
        return r;
      },
      cancel: id => (canceled.push(id), true),
      subscribe: l => (listeners.push(l), () => {}),
      queueSnapshot: () => ({ running: queue[0] ?? null, queued: queue.slice(1) }),
    };
    const api: BotApi = {
      // Long polling giả: chờ tới khi bot dừng.
      getUpdates: (_o, _t, signal) => new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })),
      getMe: async () => ({ id: 1, username: 'WyBot' }),
      setMyCommands: async () => {},
      sendMessage: async (chatId, text, send) => void replies.push({ chatId, text, send }),
    };
    const bot = new TelegramBot({
      api,
      service,
      repo: { get: id => records.get(id) ?? null, list: () => [...records.values()] },
      notifier: { setRouter: r => void (router = r), resend: async (_r, d) => void resent.push(d) },
      allowedChats: ['-100', '-200'],
      allowedUsers: over.allowedUsers ?? [],
      mainChatId: '-100',
      mainThreadId: 9,
      defaults: D,
      maxPendingPerChat: over.maxPending ?? 2,
      now: () => NOW,
      sleep: async () => {},
      log: () => {},
    });
    const msg = (text: string, o: Partial<TgMessage> = {}): TgMessage => ({
      message_id: 50,
      date: NOW / 1000,
      text,
      chat: { id: -100, type: 'supergroup' },
      message_thread_id: 9,
      is_topic_message: true,
      from: { id: 777 },
      ...o,
    });
    return { bot, replies, resent, started, canceled, records, listeners, msg, route: (r: AnalysisRecord) => router?.(r) };
  }

  it('/analyze chạy phân tích mặc định, trả lời trong topic, kết quả định tuyến về chat lệnh', async () => {
    const t = make();
    const stop = t.bot.start();
    await t.bot.handle(t.msg('/analyze BTCUSDT'));
    expect(t.started).toEqual([{ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: ['1d', '1h', '1m'] }]);
    expect(t.replies[0]).toMatchObject({ chatId: '-100', send: { threadId: 9, replyTo: 50 } });
    expect(t.replies[0]!.text).toContain('Đang phân tích');
    const id = t.started.length && [...t.records.keys()][1]!;
    expect(t.route(t.records.get(id)!)).toEqual({ chatId: '-100', threadId: 9, replyTo: 50, requested: true });
    expect(t.route(rec({ id: 'web' }))).toBeUndefined();
    await stop();
  });

  it('whitelist chat / topic / user, bỏ backlog cũ và tin của bot', async () => {
    const t = make({ allowedUsers: ['777'] });
    t.bot.start();
    await t.bot.handle(t.msg('/analyze BTCUSDT', { chat: { id: -999, type: 'group' } }));
    await t.bot.handle(t.msg('/analyze BTCUSDT', { message_thread_id: 3 }));
    await t.bot.handle(t.msg('/analyze BTCUSDT', { from: { id: 1 } }));
    await t.bot.handle(t.msg('/analyze BTCUSDT', { date: NOW / 1000 - 600 }));
    await t.bot.handle(t.msg('/analyze BTCUSDT', { from: { id: 777, is_bot: true } }));
    expect(t.started).toHaveLength(0);
    expect(t.replies).toHaveLength(0);
    // Chat phụ không ràng buộc topic; không có topic → threadId null.
    await t.bot.handle(t.msg('/help', { chat: { id: -200, type: 'group' }, message_thread_id: undefined, is_topic_message: undefined }));
    expect(t.replies[0]).toMatchObject({ chatId: '-200', send: { threadId: null, replyTo: 50 } });
  });

  it('giới hạn pending mỗi chat; kết quả trả về giải phóng chỗ', async () => {
    const t = make({ maxPending: 1 });
    t.bot.start();
    await t.bot.handle(t.msg('/analyze BTCUSDT'));
    await t.bot.handle(t.msg('/analyze ETHUSDT'));
    expect(t.started).toHaveLength(1);
    expect(t.replies[1]!.text).toContain('tối đa 1');
    const id = [...t.records.keys()][1]!;
    t.listeners[0]!({ kind: 'result', analysisId: id, record: { ...t.records.get(id)!, status: 'DONE' } });
    await t.bot.handle(t.msg('/analyze ETHUSDT'));
    expect(t.started).toHaveLength(2);
  });

  it('lỗi validate của service trả lời ngắn (escape HTML)', async () => {
    const t = make({ startError: 'Tối đa 4 khung <x>' });
    t.bot.start();
    await t.bot.handle(t.msg('/analyze BTCUSDT 4h 1d 1h 15m 5m'));
    expect(t.replies[0]!.text).toBe('⚠️ Tối đa 4 khung &lt;x&gt;');
  });

  it('/last gửi lại phân tích DONE gần nhất; /cancel chỉ huỷ phân tích bot tạo trong chat; /status', async () => {
    const t = make();
    t.bot.start();
    await t.bot.handle(t.msg('/last BTCUSDT'));
    expect(t.resent).toEqual([{ chatId: '-100', threadId: 9, replyTo: 50 }]);
    await t.bot.handle(t.msg('/analyze BTCUSDT'));
    await t.bot.handle(t.msg('/status'));
    expect(t.replies.at(-1)!.text).toContain('Đang chạy: BTCUSDT · 4h (bot)');
    await t.bot.handle(t.msg('/cancel', { chat: { id: -200, type: 'group' } }));
    expect(t.canceled).toEqual([]);
    await t.bot.handle(t.msg('/cancel'));
    expect(t.canceled).toHaveLength(1);
    expect(t.replies.at(-1)!.text).toContain('huỷ 1');
  });

  it('vòng polling: getMe → getUpdates, offset tăng, lỗi thì lùi rồi thử lại', async () => {
    const offsets: (number | undefined)[] = [];
    let n = 0;
    const handled: string[] = [];
    let finish!: () => void;
    const done = new Promise<void>(r => (finish = r));
    const bot = new TelegramBot({
      api: {
        getMe: async () => ({ id: 1, username: 'WyBot' }),
        setMyCommands: async () => {},
        sendMessage: async (_c, text) => void handled.push(text),
        getUpdates: async offset => {
          offsets.push(offset);
          n++;
          if (n === 1) return [{ update_id: 5, message: { message_id: 1, date: NOW / 1000, text: '/help', chat: { id: -100, type: 'group' } } }];
          if (n === 2) throw new Error('mạng');
          finish();
          return [];
        },
      },
      service: { start: () => rec(), cancel: () => false, subscribe: () => () => {}, queueSnapshot: () => ({ running: null, queued: [] }) },
      repo: { get: () => null, list: () => [] },
      notifier: { setRouter: () => {}, resend: async () => {} },
      allowedChats: ['-100'],
      allowedUsers: [],
      mainChatId: '-100',
      defaults: D,
      maxPendingPerChat: 2,
      now: () => NOW,
      sleep: async () => {},
      log: () => {},
    });
    bot.start();
    await done;
    await bot.stop();
    expect(offsets).toEqual([undefined, 6, 6]);
    expect(handled[0]).toContain('Lệnh bot Wyckoff');
  });
});
