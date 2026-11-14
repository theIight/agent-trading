import type { AnalysisRecord, ProgressEvent } from '@wca/shared';
import { BOT_COMMANDS, helpText, parseCommand, type BotCommand, type CommandDefaults } from './telegramCommands.ts';
import type { SendOptions, TgMessage, TgUpdate } from './telegramClient.ts';
import { escapeHtml } from './telegramFormat.ts';
import type { Destination, TelegramNotifier } from './telegramNotifier.ts';

// Bot Telegram nhận lệnh trong group (long polling): /analyze chạy phân tích qua AnalysisService, kết quả gửi về chat đã ra lệnh.

export interface BotApi {
  getUpdates(offset: number | undefined, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  getMe(signal?: AbortSignal): Promise<{ id: number; username?: string }>;
  setMyCommands(commands: { command: string; description: string }[]): Promise<void>;
  sendMessage(chatId: string, text: string, send?: SendOptions): Promise<void>;
}

/** Phần của AnalysisService bot dùng (giống web: không có đường tắt quyền). */
export interface BotService {
  start(input: { symbol: string; primaryTf: string; contextTfs: string[]; runner?: string; model?: string }): AnalysisRecord;
  cancel(id: string): boolean;
  subscribe(listener: (e: ProgressEvent) => void): () => void;
  queueSnapshot(): { running: string | null; queued: string[] };
}

export interface BotRepo {
  get(id: string): AnalysisRecord | null;
  list(symbol?: string, limit?: number): AnalysisRecord[];
}

export interface TelegramBotOptions {
  api: BotApi;
  service: BotService;
  repo: BotRepo;
  notifier: Pick<TelegramNotifier, 'setRouter' | 'resend'>;
  /** Chat được ra lệnh (TELEGRAM_CHAT_ID + TELEGRAM_ALLOWED_CHATS). */
  allowedChats: string[];
  /** Rỗng = mọi thành viên chat được phép. */
  allowedUsers: string[];
  /** Topic bắt buộc trong `mainChatId` (TELEGRAM_THREAD_ID). */
  mainChatId: string;
  mainThreadId?: number;
  defaults: CommandDefaults;
  maxPendingPerChat: number;
  /** Bỏ lệnh cũ hơn bấy nhiêu giây so với lúc bot khởi động (backlog). */
  maxBacklogSec?: number;
  pollTimeoutSec?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (msg: string) => void;
}

/** Số phân tích bot tạo giữ lại để định tuyến kết quả. */
const ROUTES_MAX = 500;

interface Origin extends Destination {
  chatId: string;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export class TelegramBot {
  private readonly routes = new Map<string, Origin>();
  private readonly pending = new Map<string, Set<string>>();
  private readonly abort = new AbortController();
  private username: string | undefined;
  private offset: number | undefined;
  private startedAt = 0;
  private unsubscribe: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly opts: TelegramBotOptions) {}

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private log(msg: string): void {
    (this.opts.log ?? console.log)(msg);
  }

  /** Bắt đầu nhận lệnh; trả hàm dừng. */
  start(): () => Promise<void> {
    this.startedAt = this.now;
    this.opts.notifier.setRouter(rec => this.routes.get(rec.id));
    this.unsubscribe = this.opts.service.subscribe(e => {
      if (e.kind === 'result' && e.record.status !== 'RUNNING') this.release(e.record.id);
    });
    this.loop = this.run();
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.unsubscribe?.();
    await this.loop?.catch(() => {});
  }

  private release(id: string): void {
    const origin = this.routes.get(id);
    if (origin) this.pending.get(origin.chatId)?.delete(id);
  }

  private async run(): Promise<void> {
    const { api } = this.opts;
    const signal = this.abort.signal;
    const sleep = this.opts.sleep ?? defaultSleep;
    let backoff = 5_000;
    while (!signal.aborted && this.username === undefined) {
      try {
        this.username = (await api.getMe(signal)).username ?? '';
        await api.setMyCommands(BOT_COMMANDS).catch(() => {});
        this.log(`[telegram] bot @${this.username} nhận lệnh trong ${this.opts.allowedChats.length} chat`);
      } catch (err) {
        if (signal.aborted) return;
        this.log(`[telegram] getMe lỗi: ${(err as Error).message}; thử lại sau ${backoff / 1000}s`);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    backoff = 5_000;
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates(this.offset, this.opts.pollTimeoutSec ?? 30, signal);
        backoff = 5_000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message) await this.handle(u.message).catch(err => this.log(`[telegram] xử lý lệnh lỗi: ${(err as Error).message}`));
        }
      } catch (err) {
        if (signal.aborted) return;
        this.log(`[telegram] getUpdates lỗi: ${(err as Error).message}; thử lại sau ${backoff / 1000}s`);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Chat / user / topic được phép ra lệnh. */
  private allowed(msg: TgMessage): boolean {
    const chatId = String(msg.chat.id);
    if (!this.opts.allowedChats.includes(chatId)) return false;
    if (this.opts.allowedUsers.length && !(msg.from && this.opts.allowedUsers.includes(String(msg.from.id)))) return false;
    if (chatId === this.opts.mainChatId && this.opts.mainThreadId !== undefined && msg.message_thread_id !== this.opts.mainThreadId) return false;
    return !msg.from?.is_bot;
  }

  /** Xử lý một tin nhắn (public để test). */
  async handle(msg: TgMessage): Promise<void> {
    if (!this.allowed(msg)) return;
    if (msg.date * 1000 < this.startedAt - (this.opts.maxBacklogSec ?? 120) * 1000) return;
    const cmd = parseCommand(msg.text, this.username, this.opts.defaults);
    if (!cmd) return;
    const origin: Origin = {
      chatId: String(msg.chat.id),
      threadId: msg.is_topic_message && msg.message_thread_id !== undefined ? msg.message_thread_id : null,
      replyTo: msg.message_id,
    };
    await this.execute(cmd, origin);
  }

  private reply(origin: Origin, text: string): Promise<void> {
    return this.opts.api.sendMessage(origin.chatId, text, { threadId: origin.threadId, replyTo: origin.replyTo });
  }

  private async execute(cmd: BotCommand, origin: Origin): Promise<void> {
    switch (cmd.cmd) {
      case 'error':
        return this.reply(origin, `⚠️ ${escapeHtml(cmd.error)}`);
      case 'help':
        return this.reply(origin, helpText(this.opts.defaults));
      case 'analyze':
        return this.analyze(cmd, origin);
      case 'last':
        return this.last(cmd.symbol, origin);
      case 'status':
        return this.status(origin);
      case 'cancel':
        return this.cancel(origin);
    }
  }

  private async analyze(cmd: Extract<BotCommand, { cmd: 'analyze' }>, origin: Origin): Promise<void> {
    const mine = this.pending.get(origin.chatId) ?? new Set<string>();
    if (mine.size >= this.opts.maxPendingPerChat) {
      return this.reply(origin, `⚠️ Chat này đã có ${mine.size} phân tích đang chờ/chạy (tối đa ${this.opts.maxPendingPerChat}). Đợi xong hoặc /cancel.`);
    }
    let rec: AnalysisRecord;
    try {
      rec = this.opts.service.start({
        symbol: cmd.symbol,
        primaryTf: cmd.primaryTf,
        contextTfs: cmd.contextTfs,
        ...(cmd.runner ? { runner: cmd.runner } : {}),
        ...(cmd.model ? { model: cmd.model } : {}),
      });
    } catch (err) {
      return this.reply(origin, `⚠️ ${escapeHtml((err as Error).message)}`);
    }
    // Kết quả đến qua sự kiện (bất đồng bộ) → route đăng ký ở đây luôn kịp; chỉ đếm pending khi còn RUNNING.
    this.routes.set(rec.id, { ...origin, requested: true });
    if (this.routes.size > ROUTES_MAX) this.routes.delete(this.routes.keys().next().value!);
    if (this.opts.repo.get(rec.id)?.status === 'RUNNING') {
      mine.add(rec.id);
      this.pending.set(origin.chatId, mine);
    }
    const q = this.opts.service.queueSnapshot();
    const pos = q.queued.indexOf(rec.id);
    const wait = pos >= 0 ? ` · xếp hàng thứ ${pos + 1}` : '';
    await this.reply(
      origin,
      `⏳ Đang phân tích <b>${escapeHtml(rec.symbol)} · ${escapeHtml(rec.primaryTf)}</b> (${rec.tfs.map(escapeHtml).join(' → ')})${wait} · #${rec.id.slice(0, 8)}`,
    );
  }

  private async last(symbol: string | undefined, origin: Origin): Promise<void> {
    const rec = this.opts.repo.list(symbol, 50).find(r => r.status === 'DONE' && r.result);
    if (!rec) return this.reply(origin, `Chưa có phân tích hoàn tất${symbol ? ` cho ${escapeHtml(symbol)}` : ''}.`);
    await this.opts.notifier.resend(rec, origin);
  }

  private describe(id: string): string {
    const r = this.opts.repo.get(id);
    if (!r) return `#${id.slice(0, 8)}`;
    const mine = this.routes.has(id) ? ' (bot)' : '';
    return `${escapeHtml(r.symbol)} · ${escapeHtml(r.primaryTf)}${mine} #${id.slice(0, 8)}`;
  }

  private status(origin: Origin): Promise<void> {
    const q = this.opts.service.queueSnapshot();
    if (!q.running && !q.queued.length) return this.reply(origin, 'Không có phân tích nào đang chạy.');
    const lines = [];
    if (q.running) lines.push(`▶️ Đang chạy: ${this.describe(q.running)}`);
    q.queued.forEach((id, i) => lines.push(`${i + 1}. Chờ: ${this.describe(id)}`));
    return this.reply(origin, lines.join('\n'));
  }

  private cancel(origin: Origin): Promise<void> {
    const mine = [...(this.pending.get(origin.chatId) ?? [])];
    const n = mine.filter(id => this.opts.service.cancel(id)).length;
    return this.reply(origin, n ? `Đã gửi lệnh huỷ ${n} phân tích.` : 'Không có phân tích nào do bot tạo trong chat này đang chạy.');
  }
}
