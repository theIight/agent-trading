import { EventEmitter } from 'node:events';
import type { AnalysisRecord, Candle, PriceAlert, ProgressEvent, SetupHitTp } from '@wca/shared';
import type { GetKlinesOptions } from '../market/klineService.ts';
import type { SendOptions } from '../notify/telegramClient.ts';
import {
  alertsFromRecord,
  evaluateCandles,
  evaluatePositionCandles,
  evaluatePositionPrice,
  evaluatePrice,
  floorMinute,
  formatAlert,
  formatSlHit,
  formatTpHit,
  NOTE_IN_ZONE,
  type Evaluation,
} from './alertLogic.ts';
import type { AlertRepo } from './alertRepo.ts';
import type { PriceFeed } from './priceFeed.ts';
import type { SetupHistoryRepo } from './setupHistoryRepo.ts';

// Canh giá chạm vùng entry & TP/SL: nghe `result` → đặt alert; mỗi phút (đóng nến + 3s) kiểm nến 1m đã đóng; đường nhanh qua PriceFeed.
// Trạng thái ở SQLite, đổi ARMED → TRIGGERED → TP_HIT / SL_HIT / CLOSED trong transaction trước khi gửi → báo đúng một lần, kể cả sau restart.

export interface AlertSender {
  sendMessage(chatId: string, text: string, send?: SendOptions): Promise<unknown>;
}

export interface AlertDestination {
  chatId: string;
  /** undefined = topic mặc định; null = không topic. */
  threadId?: number | null;
  replyTo?: number;
}

export interface AlertWatcherOptions {
  repo: AlertRepo;
  historyRepo?: SetupHistoryRepo;
  klines: { getKlines(opts: GetKlinesOptions): Promise<{ candles: Candle[] }> };
  /** Chỉ crypto (nguồn binance-futures). */
  isCrypto: (symbol: string) => boolean;
  getRecord: (id: string) => AnalysisRecord | null;
  maxAgeH: number;
  /** Kiểm tra bù tối đa bấy nhiêu giờ nến 1m sau restart (mặc định 6). */
  catchUpH?: number;
  /** Thiếu → chỉ cập nhật trạng thái (web), không báo Telegram. */
  sender?: AlertSender | null;
  destinationOf?: (analysisId: string) => AlertDestination | undefined;
  /** Chờ trước khi gửi (vd album kết quả đang gửi → lấy được message_id để trả lời vào). */
  beforeSend?: () => Promise<void>;
  priceFeed?: PriceFeed;
  timeZone?: string;
  /** Trễ sau khi đóng nến 1m (ms). */
  checkDelayMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

type Hit = Extract<Evaluation, { status: 'TRIGGERED' }>;

export class AlertWatcher {
  private readonly bus = new EventEmitter();
  private chain: Promise<void> = Promise.resolve();
  private sendChain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  /** Alert ARMED theo symbol cho đường nhanh. */
  private armedBySymbol = new Map<string, PriceAlert[]>();
  /** Alert in-trade (TRIGGERED/TP_HIT) theo symbol cho đường nhanh. */
  private inTradeBySymbol = new Map<string, PriceAlert[]>();
  private feeds = new Map<string, () => void>();
  /** Đường nhanh đã thấy giá vượt SL → không báo chạm entry qua đường nhanh nữa (để nến 1m phân xử). */
  private stopSeen = new Set<number>();

  constructor(private readonly opts: AlertWatcherOptions) {
    this.bus.setMaxListeners(100);
  }

  private get nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  private log(msg: string): void {
    (this.opts.log ?? console.log)(msg);
  }

  /** Nghe kết quả phân tích, kiểm tra bù ngay, rồi kiểm mỗi phút. Trả hàm dừng. */
  start(subscribe: (listener: (e: ProgressEvent) => void) => () => void): () => void {
    this.stopped = false;
    const unsubscribe = subscribe(e => {
      if (e.kind === 'result' && e.record.status === 'DONE') void this.onResult(e.record);
    });
    this.refreshFeeds();
    void this.check();
    this.schedule();
    return () => {
      this.stopped = true;
      unsubscribe();
      if (this.timer) clearTimeout(this.timer);
      for (const off of this.feeds.values()) off();
      this.feeds.clear();
    };
  }

  /** Sự kiện đổi trạng thái alert (SSE). */
  subscribe(listener: (e: ProgressEvent) => void): () => void {
    this.bus.on('event', listener);
    return () => this.bus.off('event', listener);
  }

  /** Chờ mọi việc đang xếp hàng (đặt / kiểm / gửi) xong. */
  async idle(): Promise<void> {
    await this.chain;
    await this.sendChain;
  }

  private enqueue(job: () => Promise<void> | void): Promise<void> {
    const next = this.chain.then(job);
    this.chain = next.catch(err => this.log(`[alert] lỗi: ${(err as Error).message}`));
    return this.chain;
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = this.opts.checkDelayMs ?? 3000;
    const now = this.nowMs;
    const next = Math.floor((now - delay) / 60_000) * 60_000 + 60_000 + delay;
    this.timer = setTimeout(() => {
      void this.check();
      this.schedule();
    }, next - now);
    this.timer.unref?.();
  }

  private emit(alert: PriceAlert): void {
    this.bus.emit('event', { kind: 'alert', analysisId: alert.analysisId, alert } satisfies ProgressEvent);
  }

  /** Phân tích DONE: thay alert cũ của symbol, đặt alert mới; giá đang trong vùng → báo ngay. */
  onResult(rec: AnalysisRecord): Promise<void> {
    return this.enqueue(async () => {
      if (rec.status !== 'DONE' || !this.opts.isCrypto(rec.symbol)) return;
      const nowSec = Math.floor(this.nowMs / 1000);
      const candidates = alertsFromRecord(rec, nowSec, this.opts.maxAgeH);
      const price = candidates.length ? await this.currentPrice(rec.symbol) : undefined;
      const fresh = price !== undefined ? candidates.map(a => ({ ...a, armPrice: price })) : candidates;
      const { replaced, inserted } = this.opts.repo.replaceAndInsert(rec.symbol, rec.id, fresh, nowSec);
      for (const a of [...replaced, ...inserted]) this.emit(a);
      if (inserted.length) {
        this.log(`[alert] ${rec.symbol}: canh ${inserted.length} setup (#${rec.id.slice(0, 8)})${replaced.length ? `, thay ${replaced.length} alert cũ` : ''}`);
        if (price !== undefined) {
          for (const a of inserted) {
            const ev = evaluatePrice(a, price, nowSec, NOTE_IN_ZONE);
            if (ev.status === 'TRIGGERED') this.apply(a, ev);
          }
        }
      }
      this.refreshFeeds();
    });
  }

  /** Giá hiện tại = close nến 1m mới nhất (kể cả nến đang chạy). */
  private async currentPrice(symbol: string): Promise<number | undefined> {
    try {
      const { candles } = await this.opts.klines.getKlines({ symbol, tf: '1m', limit: 1 });
      return candles.at(-1)?.close;
    } catch (err) {
      this.log(`[alert] ${symbol}: không lấy được giá hiện tại: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Kiểm nến 1m đã đóng cho mọi alert ARMED và IN_TRADE (gom theo symbol); bù tối đa `catchUpH` giờ. */
  check(): Promise<void> {
    return this.enqueue(async () => {
      const nowSec = Math.floor(this.nowMs / 1000);
      const bySymbol = new Map<string, PriceAlert[]>();
      for (const a of this.opts.repo.armed()) bySymbol.set(a.symbol, [...(bySymbol.get(a.symbol) ?? []), a]);

      const inTradeBySymbol = new Map<string, PriceAlert[]>();
      for (const a of this.opts.repo.listInTrade()) inTradeBySymbol.set(a.symbol, [...(inTradeBySymbol.get(a.symbol) ?? []), a]);

      const allSymbols = new Set([...bySymbol.keys(), ...inTradeBySymbol.keys()]);
      const lastClosed = floorMinute(nowSec) - 60;

      for (const symbol of allSymbols) {
        const armedAlerts = bySymbol.get(symbol) ?? [];
        const inTradeAlerts = inTradeBySymbol.get(symbol) ?? [];

        const earliestArmed = armedAlerts.length ? Math.min(...armedAlerts.map(a => (a.checkedUntil !== undefined ? a.checkedUntil + 60 : floorMinute(a.armedAt)))) : Infinity;
        const earliestInTrade = inTradeAlerts.length ? Math.min(...inTradeAlerts.map(a => a.entryAt ?? a.statusAt)) : Infinity;
        const earliest = Math.min(earliestArmed, earliestInTrade);
        const from = Math.max(earliest, floorMinute(nowSec) - (this.opts.catchUpH ?? 6) * 3600);

        let candles: Candle[] = [];
        if (from <= lastClosed) {
          try {
            const limit = Math.min((lastClosed - from) / 60 + 1, 1500);
            candles = (await this.opts.klines.getKlines({ symbol, tf: '1m', limit, closedOnly: true })).candles;
          } catch (err) {
            this.log(`[alert] ${symbol}: lấy nến 1m lỗi: ${(err as Error).message}`);
          }
        }

        for (const a of armedAlerts) this.apply(a, evaluateCandles(a, candles, nowSec));
        for (const a of inTradeAlerts) this.checkInTradeAlert(a, candles, nowSec);
      }
      this.refreshFeeds();
    });
  }

  private checkInTradeAlert(alert: PriceAlert, candles: readonly Candle[], _nowSec: number): void {
    if (alert.entryPrice === undefined) return;
    const hitIndices = new Set(alert.hitTps?.map(h => h.index) ?? []);
    const since = alert.entryAt ?? alert.statusAt;
    const evalRes = evaluatePositionCandles(
      { direction: alert.direction, stopLoss: alert.stopLoss, takeProfits: alert.takeProfits, entryPrice: alert.entryPrice },
      candles,
      hitIndices,
      since,
    );

    for (const tpHit of evalRes.hitTps) {
      this.applyTpHit(alert, tpHit);
    }

    if (evalRes.slHit) {
      this.applySlHit(alert, evalRes.slHit);
    }
  }

  private applyTpHit(alert: PriceAlert, tpHit: { index: number; price: number; time: number; rr: number; pnlPct: number }): void {
    const isFinal = tpHit.index === alert.takeProfits.length - 1;
    const hitTp: SetupHitTp = {
      index: tpHit.index,
      price: tpHit.price,
      time: tpHit.time,
      riskReward: tpHit.rr,
      pnlPct: tpHit.pnlPct,
    };
    const next = this.opts.repo.updateTpHit(alert.id, hitTp, isFinal);
    if (!next) return;
    this.opts.historyRepo?.recordTpHit(alert.id, hitTp, isFinal);
    this.emit(next);
    this.bus.emit('event', {
      kind: 'setup_tp',
      analysisId: alert.analysisId,
      alertId: alert.id,
      symbol: alert.symbol,
      setupIndex: alert.setupIndex,
      tpIndex: tpHit.index,
      price: tpHit.price,
      riskReward: tpHit.rr,
      hitTps: next.hitTps ?? [hitTp],
      at: tpHit.time,
      isFinal,
    } satisfies ProgressEvent);

    this.log(`[alert] ${alert.symbol} setup ${alert.setupIndex + 1}: TP${tpHit.index + 1} hit (+${tpHit.rr}R)`);
    const text = formatTpHit(
      alert.symbol,
      alert.direction,
      alert.setupIndex,
      tpHit.index,
      alert.takeProfits.length,
      tpHit.price,
      tpHit.rr,
      tpHit.pnlPct,
    );
    this.notifyCustom(alert, text);
  }

  private applySlHit(alert: PriceAlert, slHit: { price: number; time: number; rr: number; pnlPct: number }): void {
    const next = this.opts.repo.updateSlHit(alert.id, slHit.price, slHit.time, slHit.rr);
    if (!next) return;
    this.opts.historyRepo?.recordSlHit(alert.id, slHit.price, slHit.time, slHit.rr, slHit.pnlPct);
    this.emit(next);
    this.bus.emit('event', {
      kind: 'setup_sl',
      analysisId: alert.analysisId,
      alertId: alert.id,
      symbol: alert.symbol,
      setupIndex: alert.setupIndex,
      price: slHit.price,
      at: slHit.time,
      riskReward: slHit.rr,
    } satisfies ProgressEvent);

    this.log(`[alert] ${alert.symbol} setup ${alert.setupIndex + 1}: SL hit (${slHit.rr}R)`);
    const hadTps = (alert.hitTps?.length ?? 0) > 0;
    const text = formatSlHit(
      alert.symbol,
      alert.direction,
      alert.setupIndex,
      slHit.price,
      slHit.rr,
      slHit.pnlPct,
      hadTps,
    );
    this.notifyCustom(alert, text);
  }

  private notifyCustom(alert: PriceAlert, text: string): void {
    const { sender } = this.opts;
    if (!sender) return;
    const job = this.sendChain.then(async () => {
      await this.opts.beforeSend?.();
      const dest = this.opts.destinationOf?.(alert.analysisId);
      if (!dest) return;
      const send: SendOptions = {};
      if (dest.threadId !== undefined) send.threadId = dest.threadId;
      if (dest.replyTo !== undefined) send.replyTo = dest.replyTo;
      await sender.sendMessage(dest.chatId, text, send);
    });
    this.sendChain = job.catch(err => this.log(`[alert] gửi Telegram lỗi (${alert.symbol}): ${(err as Error).message}`));
  }

  /** Alert đang canh (lệnh bot `/alerts`). */
  listArmed(): PriceAlert[] {
    return this.opts.repo.armed();
  }

  /** Tắt alert đang canh của symbol (lệnh bot `/alerts off`). Trả số alert đã tắt. */
  async cancelSymbol(symbol: string): Promise<number> {
    let n = 0;
    await this.enqueue(() => {
      const list = this.opts.repo.cancelSymbol(symbol, Math.floor(this.nowMs / 1000));
      for (const a of list) this.emit(a);
      n = list.length;
      this.refreshFeeds();
    });
    return n;
  }

  private apply(alert: PriceAlert, ev: Evaluation): void {
    if (ev.status === 'ARMED') {
      if (ev.checkedUntil !== undefined) this.opts.repo.setCheckedUntil(alert.id, ev.checkedUntil);
      return;
    }
    const extra = ev.status === 'EXPIRED' ? { note: ev.note } : { price: ev.price, ...(ev.note ? { note: ev.note } : {}) };
    const next = this.opts.repo.transition(alert.id, ev.status, ev.at, extra);
    if (!next) return; // đã đổi trạng thái ở nơi khác (đường nhanh / lần kiểm trước) → không báo lại
    this.stopSeen.delete(alert.id);
    this.emit(next);
    this.log(`[alert] ${next.symbol} setup ${next.setupIndex + 1}: ${next.status}${next.note ? ` (${next.note})` : ''}`);
    if (ev.status === 'TRIGGERED') {
      if (this.opts.historyRepo && next.entryPrice !== undefined && next.entryAt !== undefined) {
        this.opts.historyRepo.createFromAlert(next, next.entryPrice, next.entryAt);
      }
      this.notify(next, ev);
    }
  }

  private notify(alert: PriceAlert, hit: Hit): void {
    const { sender } = this.opts;
    if (!sender) return;
    const job = this.sendChain.then(async () => {
      await this.opts.beforeSend?.();
      const dest = this.opts.destinationOf?.(alert.analysisId);
      if (!dest) return;
      const text = formatAlert(alert, hit, this.opts.getRecord(alert.analysisId)?.createdAt, this.opts.timeZone);
      const send: SendOptions = {};
      if (dest.threadId !== undefined) send.threadId = dest.threadId;
      if (dest.replyTo !== undefined) send.replyTo = dest.replyTo;
      await sender.sendMessage(dest.chatId, text, send);
    });
    // Gửi lỗi → chỉ log; trạng thái đã TRIGGERED nên không báo lại.
    this.sendChain = job.catch(err => this.log(`[alert] gửi Telegram lỗi (${alert.symbol}): ${(err as Error).message}`));
  }

  // ---------- Đường nhanh ----------

  private refreshFeeds(): void {
    const feed = this.opts.priceFeed;
    if (!feed || this.stopped) return;
    const armed = this.opts.repo.armed();
    const inTrade = this.opts.repo.listInTrade();

    const byArmed = new Map<string, PriceAlert[]>();
    for (const a of armed) if (feed.has(a.symbol)) byArmed.set(a.symbol, [...(byArmed.get(a.symbol) ?? []), a]);
    this.armedBySymbol = byArmed;

    const byInTrade = new Map<string, PriceAlert[]>();
    for (const a of inTrade) if (feed.has(a.symbol)) byInTrade.set(a.symbol, [...(byInTrade.get(a.symbol) ?? []), a]);
    this.inTradeBySymbol = byInTrade;

    const activeSymbols = new Set([...byArmed.keys(), ...byInTrade.keys()]);
    for (const [symbol, off] of this.feeds) {
      if (!activeSymbols.has(symbol)) {
        off();
        this.feeds.delete(symbol);
      }
    }
    for (const symbol of activeSymbols) {
      if (!this.feeds.has(symbol)) this.feeds.set(symbol, feed.subscribe(symbol, (price, timeMs) => this.onTick(symbol, price, timeMs)));
    }
  }

  /** Một giá khớp (đã quy về giá chart). */
  onTick(symbol: string, price: number, timeMs: number): void {
    const atSec = Math.floor(timeMs / 1000);

    // 1. Kiểm tra ARMED alerts (chạm entry)
    const list = this.armedBySymbol.get(symbol);
    if (list?.length) {
      for (const a of [...list]) {
        if (atSec < a.armedAt) continue;
        const ev = evaluatePrice(a, price, atSec);
        if (ev.status === 'INVALIDATED') this.stopSeen.add(a.id);
        if (ev.status !== 'TRIGGERED' || this.stopSeen.has(a.id)) continue;
        // Bỏ khỏi danh sách ngay để các tick sau không xếp hàng trùng; transaction trong repo vẫn chặn báo lặp.
        this.armedBySymbol.set(symbol, (this.armedBySymbol.get(symbol) ?? []).filter(x => x.id !== a.id));
        void this.enqueue(() => {
          this.apply(a, ev);
          this.refreshFeeds();
        });
      }
    }

    // 2. Kiểm tra IN_TRADE alerts (chạm TP / SL)
    const inTradeList = this.inTradeBySymbol.get(symbol);
    if (inTradeList?.length) {
      for (const a of [...inTradeList]) {
        if (a.entryPrice === undefined) continue;
        const hitSet = new Set(a.hitTps?.map(h => h.index) ?? []);
        const ev = evaluatePositionPrice(
          { direction: a.direction, stopLoss: a.stopLoss, takeProfits: a.takeProfits, entryPrice: a.entryPrice },
          price,
          atSec,
          hitSet,
        );

        if (ev.hitTps.length > 0) {
          for (const tp of ev.hitTps) {
            hitSet.add(tp.index);
            void this.enqueue(() => {
              this.applyTpHit(a, tp);
              this.refreshFeeds();
            });
          }
        }

        if (ev.slHit) {
          this.inTradeBySymbol.set(symbol, (this.inTradeBySymbol.get(symbol) ?? []).filter(x => x.id !== a.id));
          void this.enqueue(() => {
            this.applySlHit(a, ev.slHit!);
            this.refreshFeeds();
          });
        }
      }
    }
  }
}
