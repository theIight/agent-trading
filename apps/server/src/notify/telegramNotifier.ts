import type { AnalysisRecord, ProgressEvent } from '@wca/shared';
import type { CaptureFn } from './chartSnapshot.ts';
import type { Photo, SendOptions } from './telegramClient.ts';
import type { SentMessage } from './telegramMessages.ts';
import { escapeHtml, formatCaption, formatFailure, snapshotShots, type FormatOptions } from './telegramFormat.ts';

// Nghe sự kiện `result` của AnalysisService, gửi ảnh chart + tóm tắt vào Telegram. Lỗi chỉ log, không ảnh hưởng phân tích.

/** Hàm gửi trả `message_id` các tin đã gửi (fake trong test có thể không trả). */
export interface TelegramSender {
  sendMessage(chatId: string, text: string, send?: SendOptions): Promise<number[] | void>;
  sendPhotos(chatId: string, photos: readonly Photo[], caption: string, send?: SendOptions): Promise<number[] | void>;
}

/** Nơi gửi kết quả. `requested` = phân tích do lệnh bot tạo (luôn báo FAILED / CANCELED). */
export interface Destination extends SendOptions {
  chatId: string;
  requested?: boolean;
}

export interface TelegramNotifierOptions {
  chatId: string;
  sender: TelegramSender;
  capture: CaptureFn;
  tfs: 'all' | 'primary';
  notifyFailed: boolean;
  format?: FormatOptions;
  /** Lưu `message_id` tin kết quả (DONE) để alert chạm entry trả lời vào album. */
  messages?: { save(analysisId: string, msg: SentMessage): void };
  log?: (msg: string) => void;
}

/** Số id đã gửi giữ lại để chống trùng. */
const SEEN_MAX = 500;

export class TelegramNotifier {
  private readonly seen = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private router: ((rec: AnalysisRecord) => Destination | undefined) | null = null;

  constructor(private readonly opts: TelegramNotifierOptions) {}

  /** Đăng ký vào bus sự kiện; trả hàm huỷ. */
  start(subscribe: (listener: (e: ProgressEvent) => void) => () => void): () => void {
    return subscribe(e => {
      if (e.kind === 'result') this.enqueue(e.record);
    });
  }

  /** Bot đặt hàm định tuyến: phân tích do lệnh tạo → gửi về chat đã ra lệnh; undefined → `chatId` mặc định. */
  setRouter(router: (rec: AnalysisRecord) => Destination | undefined): void {
    this.router = router;
  }

  /** Chờ mọi lần gửi đang xếp hàng xong (test / tắt server). */
  idle(): Promise<void> {
    return this.chain;
  }

  enqueue(rec: AnalysisRecord): void {
    if (rec.status === 'RUNNING') return;
    const dest = this.router?.(rec) ?? { chatId: this.opts.chatId };
    if (rec.status === 'CANCELED' && !dest.requested) return;
    if (rec.status === 'FAILED' && !this.opts.notifyFailed && !dest.requested) return;
    if (rec.status === 'DONE' && !rec.result) return;
    if (this.seen.has(rec.id)) return;
    this.seen.add(rec.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
    this.push(rec, dest);
  }

  /** Gửi lại một phân tích DONE (lệnh `/last`), không qua chống trùng. */
  resend(rec: AnalysisRecord, dest: Destination): Promise<void> {
    return this.push(rec, dest);
  }

  private push(rec: AnalysisRecord, dest: Destination): Promise<void> {
    const job = this.chain.then(() => this.send(rec, dest));
    this.chain = job.catch(err => this.log(`[telegram] ${rec.id}: ${(err as Error).message}`));
    return this.chain;
  }

  private log(msg: string): void {
    (this.opts.log ?? console.log)(msg);
  }

  private remember(rec: AnalysisRecord, dest: Destination, ids: number[] | void): void {
    const messageId = ids?.[0];
    if (messageId === undefined || !this.opts.messages) return;
    try {
      this.opts.messages.save(rec.id, { chatId: dest.chatId, ...(dest.threadId !== undefined ? { threadId: dest.threadId } : {}), messageId });
    } catch (err) {
      this.log(`[telegram] ${rec.id}: không lưu được message_id: ${(err as Error).message}`);
    }
  }

  private async send(rec: AnalysisRecord, dest: Destination): Promise<void> {
    const { sender } = this.opts;
    const { chatId } = dest;
    const send: SendOptions = {};
    if (dest.threadId !== undefined) send.threadId = dest.threadId;
    if (dest.replyTo !== undefined) send.replyTo = dest.replyTo;
    if (rec.status === 'CANCELED') {
      await sender.sendMessage(chatId, `⏹ Đã huỷ phân tích <b>${escapeHtml(rec.symbol)} · ${escapeHtml(rec.primaryTf)}</b>`, send);
      return;
    }
    if (rec.status === 'FAILED') {
      await sender.sendMessage(chatId, formatFailure(rec, this.opts.format), send);
      return;
    }
    const caption = formatCaption(rec, this.opts.format);
    const shots = snapshotShots(rec, this.opts.tfs);
    let photos: Photo[];
    try {
      const images = await this.opts.capture(rec.id, shots);
      photos = images.map((data, i) => ({ data, filename: `${rec.symbol}-${shots[i]!.tf}.png` }));
    } catch (err) {
      this.log(`[telegram] ${rec.id}: chụp chart lỗi, chỉ gửi chữ: ${(err as Error).message}`);
      this.remember(rec, dest, await sender.sendMessage(chatId, `${caption}\n\n<i>(Không chụp được chart)</i>`, send));
      return;
    }
    this.remember(rec, dest, await sender.sendPhotos(chatId, photos, caption, send));
    this.log(`[telegram] đã gửi ${rec.symbol} ${rec.primaryTf} (${photos.length} ảnh)`);
  }
}
