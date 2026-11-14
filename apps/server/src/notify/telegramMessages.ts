import type { Db } from '../db/index.ts';

// Tin Telegram đã gửi cho một phân tích (album kết quả) → alert chạm entry trả lời vào đó.
// Cột thread_id: NULL = topic mặc định của client (threadId undefined), 0 = không gửi vào topic (threadId null).

export interface SentMessage {
  chatId: string;
  /** undefined = topic mặc định; null = không topic. */
  threadId?: number | null;
  messageId: number;
}

export class TelegramMessageStore {
  constructor(private readonly db: Db) {}

  save(analysisId: string, msg: SentMessage, nowMs = Date.now()): void {
    const thread = msg.threadId === undefined ? null : msg.threadId === null ? 0 : msg.threadId;
    this.db
      .prepare(`INSERT INTO telegram_messages (analysis_id, chat_id, thread_id, message_id, sent_at) VALUES (?, ?, ?, ?, ?)`)
      .run(analysisId, msg.chatId, thread, msg.messageId, nowMs);
  }

  /** Tin gửi đầu tiên (album kết quả gốc, đúng chat đã ra lệnh); bỏ qua các lần `/last` gửi lại sau. */
  first(analysisId: string): SentMessage | null {
    const r = this.db
      .prepare(`SELECT chat_id, thread_id, message_id FROM telegram_messages WHERE analysis_id = ? ORDER BY sent_at, rowid LIMIT 1`)
      .get(analysisId) as { chat_id: string; thread_id: number | null; message_id: number } | undefined;
    if (!r) return null;
    return { chatId: r.chat_id, ...(r.thread_id === null ? {} : { threadId: r.thread_id === 0 ? null : r.thread_id }), messageId: r.message_id };
  }
}
