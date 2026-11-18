import { EventEmitter } from 'node:events';
import type { ChartAlert, ProgressEvent } from '@wca/shared';
import type { ChartAlertRepo } from './chartAlertRepo.ts';
import type { PriceFeed } from './priceFeed.ts';
import type { SendOptions } from '../notify/telegramClient.ts';

export interface ChartAlertSender {
  sendMessage(chatId: string, text: string, send?: SendOptions): Promise<unknown>;
}

export interface ChartAlertWatcherOptions {
  repo: ChartAlertRepo;
  priceFeed?: PriceFeed;
  sender?: ChartAlertSender | null;
  telegramChatId?: string;
  telegramThreadId?: number;
  cooldownSec?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export class ChartAlertWatcher {
  private readonly bus = new EventEmitter();
  private stopped = true;
  private feeds = new Map<string, () => void>();
  private lastPrices = new Map<string, number>();
  private cooldownSec: number;

  constructor(private readonly opts: ChartAlertWatcherOptions) {
    this.bus.setMaxListeners(100);
    this.cooldownSec = opts.cooldownSec ?? 60;
  }

  private get nowSec(): number {
    return (this.opts.now ?? (() => Math.floor(Date.now() / 1000)))();
  }

  start(): () => void {
    if (!this.stopped) return () => {};
    this.stopped = false;
    this.refreshFeeds();
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.feeds.values()) off();
    this.feeds.clear();
    this.lastPrices.clear();
  }

  subscribe(listener: (e: ProgressEvent) => void): () => void {
    this.bus.on('event', listener);
    return () => this.bus.off('event', listener);
  }

  /** Làm mới feed giá realtime cho các symbol có alert ACTIVE. */
  refreshFeeds(): void {
    if (this.stopped || !this.opts.priceFeed) return;
    const activeAlerts = this.opts.repo.listActive();
    const neededSymbols = new Set(activeAlerts.map(a => a.symbol));

    // Huỷ symbol không còn alert
    for (const [sym, off] of this.feeds.entries()) {
      if (!neededSymbols.has(sym)) {
        off();
        this.feeds.delete(sym);
        this.lastPrices.delete(sym);
      }
    }

    // Đăng ký symbol mới
    for (const sym of neededSymbols) {
      if (!this.feeds.has(sym) && this.opts.priceFeed.has(sym)) {
        const off = this.opts.priceFeed.subscribe(sym, (price: number) => {
          this.onPriceTick(sym, price);
        });
        this.feeds.set(sym, off);
      }
    }
  }

  /**
   * Xử lý tick giá realtime (từ WebSocket order flow hoặc poll nến).
   */
  onPriceTick(symbol: string, currentPrice: number): void {
    if (this.stopped) return;
    const prevPrice = this.lastPrices.get(symbol);
    this.lastPrices.set(symbol, currentPrice);

    const alerts = this.opts.repo.listActive(symbol);
    if (!alerts.length) return;

    const now = this.nowSec;

    for (const alert of alerts) {
      const hit = isPriceHit(alert.price, currentPrice, prevPrice);
      if (!hit) continue;

      // Kiểm tra cooldown cho loại 'every'
      if (alert.type === 'every' && alert.triggeredAt && now - alert.triggeredAt < this.cooldownSec) {
        continue;
      }

      const isOnce = alert.type === 'once';
      const updated = this.opts.repo.markTriggered(alert.id, now, isOnce, `chạm giá ${currentPrice}`);
      if (!updated) continue;

      this.opts.log?.(`[chart-alert] ${symbol} chạm alert giá ${alert.price} (giá hiện tại: ${currentPrice}, loại: ${alert.type})`);

      // Bắn sự kiện SSE
      this.bus.emit('event', {
        kind: 'chart_alert',
        alert: updated,
        triggerPrice: currentPrice,
      } satisfies ProgressEvent);

      // Gửi Telegram nếu có
      this.notifyTelegram(updated, currentPrice);

      // Nếu là loại 'once', làm mới lại feed nếu cần
      if (isOnce) {
        this.refreshFeeds();
      }
    }
  }

  /**
   * Kiểm tra qua nến 1m đã đóng.
   */
  onCandle(symbol: string, low: number, high: number, close: number): void {
    if (this.stopped) return;
    const alerts = this.opts.repo.listActive(symbol);
    if (!alerts.length) return;

    const now = this.nowSec;

    for (const alert of alerts) {
      const hit = low <= alert.price && alert.price <= high;
      if (!hit) continue;

      if (alert.type === 'every' && alert.triggeredAt && now - alert.triggeredAt < this.cooldownSec) {
        continue;
      }

      const isOnce = alert.type === 'once';
      const updated = this.opts.repo.markTriggered(alert.id, now, isOnce, `nến chạm [${low}, ${high}]`);
      if (!updated) continue;

      this.opts.log?.(`[chart-alert] ${symbol} nến chạm alert giá ${alert.price} (loại: ${alert.type})`);

      this.bus.emit('event', {
        kind: 'chart_alert',
        alert: updated,
        triggerPrice: close,
      } satisfies ProgressEvent);

      this.notifyTelegram(updated, close);

      if (isOnce) {
        this.refreshFeeds();
      }
    }
  }

  private notifyTelegram(alert: ChartAlert, triggerPrice: number): void {
    const { sender, telegramChatId, telegramThreadId } = this.opts;
    if (!sender || !telegramChatId) return;

    const typeStr = alert.type === 'once' ? 'Chỉ 1 lần' : 'Mỗi lần';
    const text = `🔔 <b>${alert.symbol}</b>: Giá đã chạm alert <b>${alert.price}</b> (giá: ${triggerPrice}, loại: ${typeStr})`;

    sender
      .sendMessage(telegramChatId, text, {
        ...(telegramThreadId ? { threadId: telegramThreadId } : {}),
      })
      .catch(err => {
        this.opts.log?.(`[chart-alert] lỗi gửi Telegram: ${(err as Error).message}`);
      });
  }
}

/**
 * Kiểm tra giá có cắt qua hoặc chạm mức alert không.
 */
export function isPriceHit(targetPrice: number, currentPrice: number, prevPrice?: number): boolean {
  if (currentPrice === targetPrice) return true;
  if (prevPrice !== undefined) {
    const min = Math.min(prevPrice, currentPrice);
    const max = Math.max(prevPrice, currentPrice);
    return min <= targetPrice && targetPrice <= max;
  }
  // Nếu không có giá trước đó, kiểm tra độ lệch tương đối rất nhỏ (< 0.05%)
  return Math.abs(currentPrice - targetPrice) / targetPrice < 0.0005;
}
