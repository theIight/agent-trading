// Gọi Telegram Bot API bằng fetch (không thêm thư viện). Lỗi trả ra không bao giờ chứa token / URL.

export interface TelegramClientOptions {
  token: string;
  /** Topic mặc định trong group bật chủ đề (`message_thread_id`). */
  threadId?: number;
  fetchImpl?: typeof fetch;
  /** Số lần thử lại sau lần đầu (429 / lỗi mạng / 5xx). */
  retries?: number;
  /** Chờ giữa các lần thử khi Telegram không báo `retry_after` (ms). */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Photo {
  data: Buffer;
  filename: string;
}

/** Nơi gửi một tin: topic + trả lời vào tin nhắn nào (ghi đè topic mặc định của client). */
export interface SendOptions {
  /** undefined = topic mặc định của client; null = không gửi vào topic nào. */
  threadId?: number | null;
  replyTo?: number;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

interface TgResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Phần của Update mà bot dùng. */
export interface TgMessage {
  message_id: number;
  date: number;
  text?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  chat: { id: number; type: string };
  from?: { id: number; is_bot?: boolean; username?: string };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/** `message_id` từ kết quả sendMessage / sendPhoto (một Message) hoặc sendMediaGroup (mảng Message). */
function messageIds(result: { message_id: number } | { message_id: number }[] | undefined): number[] {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return list.map(m => m?.message_id).filter((id): id is number => typeof id === 'number');
}

interface RequestOptions {
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class TelegramClient {
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: TelegramClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 5000;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  /** Trả `message_id` của tin đã gửi. */
  async sendMessage(chatId: string, text: string, send: SendOptions = {}): Promise<number[]> {
    const msg = await this.call<{ message_id: number }>(
      'sendMessage',
      () => {
        const f = new FormData();
        f.set('chat_id', chatId);
        f.set('text', text);
        f.set('parse_mode', 'HTML');
        f.set('disable_web_page_preview', 'true');
        return f;
      },
      send,
    );
    return messageIds(msg);
  }

  /** 1 ảnh → sendPhoto; 2–10 ảnh → sendMediaGroup (caption ở ảnh đầu); > 10 → nhiều album. Chỉ album đầu trả lời tin gốc.
   *  Trả `message_id` của mọi tin đã gửi theo thứ tự (phần tử đầu = ảnh đầu album, dùng để trả lời vào album). */
  async sendPhotos(chatId: string, photos: readonly Photo[], caption: string, send: SendOptions = {}): Promise<number[]> {
    if (!photos.length) return this.sendMessage(chatId, caption, send);
    if (photos.length === 1) {
      const msg = await this.call<{ message_id: number }>(
        'sendPhoto',
        () => {
          const f = new FormData();
          f.set('chat_id', chatId);
          f.set('photo', new Blob([new Uint8Array(photos[0]!.data)], { type: 'image/png' }), photos[0]!.filename);
          if (caption) {
            f.set('caption', caption);
            f.set('parse_mode', 'HTML');
          }
          return f;
        },
        send,
      );
      return messageIds(msg);
    }
    const ids: number[] = [];
    for (let start = 0; start < photos.length; start += 10) {
      const chunk = photos.slice(start, start + 10);
      const chunkSend = start === 0 ? send : { threadId: send.threadId };
      if (chunk.length === 1) {
        ids.push(...(await this.sendPhotos(chatId, chunk, '', chunkSend)));
        continue;
      }
      const msgs = await this.call<{ message_id: number }[]>(
        'sendMediaGroup',
        () => {
          const f = new FormData();
          f.set('chat_id', chatId);
          f.set(
            'media',
            JSON.stringify(
              chunk.map((_, i) => ({
                type: 'photo',
                media: `attach://p${i}`,
                ...(start === 0 && i === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
              })),
            ),
          );
          chunk.forEach((p, i) => f.set(`p${i}`, new Blob([new Uint8Array(p.data)], { type: 'image/png' }), p.filename));
          return f;
        },
        chunkSend,
      );
      ids.push(...messageIds(msgs));
    }
    return ids;
  }

  /** Long polling: chờ tối đa `timeoutSec` giây. Không tự thử lại (bot tự lùi dần). */
  getUpdates(offset: number | undefined, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    const f = new FormData();
    if (offset !== undefined) f.set('offset', String(offset));
    f.set('timeout', String(timeoutSec));
    f.set('allowed_updates', JSON.stringify(['message']));
    return this.request<TgUpdate[]>('getUpdates', f, { timeoutMs: (timeoutSec + 15) * 1000, signal }).then(r => r ?? []);
  }

  async getMe(signal?: AbortSignal): Promise<{ id: number; username?: string }> {
    const me = await this.request<{ id: number; username?: string }>('getMe', new FormData(), { signal });
    if (!me) throw new TelegramError('Telegram getMe: không có kết quả', true);
    return me;
  }

  /** Menu lệnh hiện khi gõ `/` trong chat. */
  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    const f = new FormData();
    f.set('commands', JSON.stringify(commands));
    await this.request('setMyCommands', f, { retries: 0 });
  }

  private call<T>(method: string, body: () => FormData, send: SendOptions): Promise<T | undefined> {
    return this.withRetry(method, () => {
      const f = body();
      const thread = send.threadId === undefined ? this.opts.threadId : send.threadId;
      if (thread != null) f.set('message_thread_id', String(thread));
      if (send.replyTo !== undefined) f.set('reply_parameters', JSON.stringify({ message_id: send.replyTo, allow_sending_without_reply: true }));
      return this.once<T>(method, f);
    });
  }

  private request<T>(method: string, body: FormData, opts: RequestOptions = {}): Promise<T | undefined> {
    return this.withRetry(method, () => this.once<T>(method, body, opts), opts.retries ?? 0);
  }

  private async withRetry<T>(method: string, fn: () => Promise<T>, retries = this.retries): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const e = err instanceof TelegramError ? err : new TelegramError(`Telegram ${method}: lỗi mạng`, true);
        if (!e.retryable || attempt >= retries) throw e;
        await this.sleep(e.retryAfterMs ?? this.retryDelayMs);
      }
    }
  }

  private async once<T>(method: string, body: FormData, opts: RequestOptions = {}): Promise<T | undefined> {
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
      const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
      // Telegram trả 400 với multipart rỗng (getMe) → không tham số thì gửi GET không body.
      const empty = [...body.keys()].length === 0;
      res = await this.fetchImpl(`https://api.telegram.org/bot${this.opts.token}/${method}`, empty ? { method: 'GET', signal } : { method: 'POST', body, signal });
    } catch {
      // Không đưa lỗi gốc ra: thông điệp của fetch có thể chứa URL (token).
      throw new TelegramError(`Telegram ${method}: lỗi mạng`, true);
    }
    let json: TgResponse<T> | null = null;
    try {
      json = (await res.json()) as TgResponse<T>;
    } catch {
      /* body không phải JSON */
    }
    if (res.ok && json?.ok) return json.result;
    const desc = (json?.description ?? `HTTP ${res.status}`).replaceAll(this.opts.token, '***');
    const retryAfter = json?.parameters?.retry_after;
    throw new TelegramError(
      `Telegram ${method}: ${desc}`,
      res.status === 429 || res.status >= 500,
      retryAfter !== undefined ? retryAfter * 1000 : undefined,
    );
  }
}
