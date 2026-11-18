import type { AnalysisRecord, Candle, PriceAlert } from '@wca/shared';
import { escapeHtml, fmtPrice, fmtTime } from '../notify/telegramFormat.ts';

// Luật alert chạm vùng entry. Pure, không gọi mạng / DB. Thời gian: unix giây.

/** Alert mới trước khi lưu (chưa có id / trạng thái). */
export type NewPriceAlert = Omit<PriceAlert, 'id' | 'status' | 'statusAt' | 'checkedUntil' | 'triggerPrice' | 'note'>;

export const NOTE_IN_ZONE = 'đang ở trong vùng entry';
export const NOTE_SL_SAME_CANDLE = 'đã chạm cả SL trong cùng nến';

const MINUTE = 60;
export const floorMinute = (sec: number) => Math.floor(sec / MINUTE) * MINUTE;

/**
 * Setup cần canh của một phân tích DONE (luật 1): bỏ STAND_ASIDE (tham khảo), bỏ MARKET khi ENTER (đã vào ở giá hiện tại),
 * bỏ bản ghi cũ không có `tradePlan`. Toạ độ lấy từ kết quả đã qua validateSubmission.
 */
export function alertsFromRecord(rec: AnalysisRecord, nowSec: number, maxAgeH: number): NewPriceAlert[] {
  const plan = rec.status === 'DONE' ? rec.result?.tradePlan : undefined;
  if (!plan || plan.decision === 'STAND_ASIDE') return [];
  const out: NewPriceAlert[] = [];
  plan.setups.forEach((s, i) => {
    if (s.entryType === 'MARKET' && plan.decision === 'ENTER') return;
    const validUntil = s.validUntil ?? nowSec + maxAgeH * 3600;
    if (validUntil <= nowSec) return;
    out.push({
      analysisId: rec.id,
      symbol: rec.symbol,
      setupIndex: i,
      direction: s.direction,
      entryType: s.entryType,
      tf: s.tf,
      entryLow: Math.min(s.entryLow, s.entryHigh),
      entryHigh: Math.max(s.entryLow, s.entryHigh),
      stopLoss: s.stopLoss,
      takeProfits: [...s.takeProfits],
      ...(s.riskReward !== undefined ? { riskReward: s.riskReward } : {}),
      validUntil,
      armedAt: nowSec,
    });
  });
  return out;
}

type Zone = Pick<PriceAlert, 'entryLow' | 'entryHigh'>;
type Stop = Pick<PriceAlert, 'direction' | 'stopLoss'>;

/** Khoảng giá [low, high] giao vùng entry. */
export const touchesZone = (a: Zone, low: number, high: number) => low <= a.entryHigh && high >= a.entryLow;
export const inZone = (a: Zone, price: number) => touchesZone(a, price, price);
/** Khoảng giá [low, high] chạm SL (LONG: low ≤ SL; SHORT: high ≥ SL). */
export const hitsStop = (a: Stop, low: number, high: number) => (a.direction === 'LONG' ? low <= a.stopLoss : high >= a.stopLoss);
/**
 * Luật "chạm SL trước entry" chỉ áp dụng khi giá lúc đặt nằm phía entry của SL. Setup STOP có SL nằm giữa giá và entry
 * (vd SHORT STOP 612.5, SL 615, giá 617) → giá đi qua SL trước khi tới entry là bình thường, không huỷ.
 */
export const stopActive = (a: Stop & Pick<PriceAlert, 'armPrice'>) =>
  a.armPrice === undefined || (a.direction === 'LONG' ? a.armPrice > a.stopLoss : a.armPrice < a.stopLoss);

/** Giá vào vùng ước lượng: giá mở nến kẹp vào vùng (giá đi từ open vào vùng, điểm gặp đầu tiên là mép gần open). */
const entryPrice = (a: Zone, c: Candle) => Math.min(Math.max(c.open, a.entryLow), a.entryHigh);

export type Evaluation =
  | { status: 'ARMED'; checkedUntil?: number }
  | { status: 'TRIGGERED'; price: number; at: number; note?: string }
  | { status: 'INVALIDATED'; price: number; at: number; note: string }
  | { status: 'EXPIRED'; at: number; note: string };

/** Quá hạn này mà vẫn chưa có nến phủ tới `validUntil` (sàn lỗi) → vẫn hết hạn. */
const EXPIRE_GRACE_SEC = 10 * MINUTE;

/**
 * Đánh giá alert ARMED với nến 1m ĐÃ ĐÓNG (tăng dần theo time), luật 2–3:
 * chỉ xét nến `time ≥ floor(armedAt)` và chưa kiểm (`time > checkedUntil`); chạm vùng theo high/low;
 * chạm SL ở nến chưa chạm entry → INVALIDATED; cùng nến chạm cả hai → TRIGGERED kèm ghi chú; quá `validUntil` → EXPIRED.
 */
export function evaluateCandles(alert: PriceAlert, candles: readonly Candle[], nowSec: number): Evaluation {
  if (alert.status !== 'ARMED') return { status: 'ARMED' };
  const start = floorMinute(alert.armedAt);
  let checked = alert.checkedUntil;
  for (const c of candles) {
    if (c.time < start || (checked !== undefined && c.time <= checked)) continue;
    if (c.time >= alert.validUntil) break;
    const stop = stopActive(alert) && hitsStop(alert, c.low, c.high);
    if (touchesZone(alert, c.low, c.high)) {
      return { status: 'TRIGGERED', price: entryPrice(alert, c), at: c.time, ...(stop ? { note: NOTE_SL_SAME_CANDLE } : {}) };
    }
    if (stop) return { status: 'INVALIDATED', price: alert.stopLoss, at: c.time, note: 'giá chạm SL trước khi chạm entry' };
    checked = c.time;
  }
  const coveredUntil = checked !== undefined ? checked + MINUTE : start;
  if (nowSec >= alert.validUntil && (coveredUntil >= alert.validUntil || nowSec >= alert.validUntil + EXPIRE_GRACE_SEC)) {
    return { status: 'EXPIRED', at: alert.validUntil, note: 'hết hạn setup' };
  }
  return checked !== alert.checkedUntil && checked !== undefined ? { status: 'ARMED', checkedUntil: checked } : { status: 'ARMED' };
}

/** Một giá tức thời (đường nhanh / giá lúc đặt): chạm vùng → TRIGGERED, vượt SL → INVALIDATED. */
export function evaluatePrice(alert: PriceAlert, price: number, atSec: number, note?: string): Evaluation {
  if (alert.status !== 'ARMED' || atSec >= alert.validUntil) return { status: 'ARMED' };
  if (inZone(alert, price)) return { status: 'TRIGGERED', price, at: atSec, ...(note ? { note } : {}) };
  if (stopActive(alert) && hitsStop(alert, price, price)) return { status: 'INVALIDATED', price, at: atSec, note: 'giá chạm SL trước khi chạm entry' };
  return { status: 'ARMED' };
}

const SETUP_MARKS = ['①', '②', '③'];

/** `🔔 BTCUSDT chạm entry ① SHORT LIMIT 1m · vùng 67,400–67,500 · giá 67,452 · SL 67,900 · TP 66,600 / 66,050 · R:R 4.11 · phân tích 12:34 14/11` (HTML). */
export function formatAlert(
  alert: PriceAlert,
  hit: { price: number; note?: string },
  analysisCreatedAtMs: number | undefined,
  timeZone?: string,
): string {
  const zone = alert.entryLow === alert.entryHigh ? fmtPrice(alert.entryLow) : `${fmtPrice(alert.entryLow)}–${fmtPrice(alert.entryHigh)}`;
  const parts = [
    `🔔 <b>${escapeHtml(alert.symbol)}</b> chạm entry ${SETUP_MARKS[alert.setupIndex] ?? `${alert.setupIndex + 1}.`} <b>${alert.direction}</b> ${alert.entryType} ${escapeHtml(alert.tf)}`,
    `vùng ${zone}`,
    `giá ${fmtPrice(hit.price)}`,
    `SL ${fmtPrice(alert.stopLoss)}`,
    `TP ${alert.takeProfits.map(fmtPrice).join(' / ')}`,
  ];
  if (alert.riskReward !== undefined) parts.push(`R:R ${alert.riskReward.toFixed(2)}`);
  if (analysisCreatedAtMs !== undefined) parts.push(`phân tích ${fmtTime(analysisCreatedAtMs, timeZone)}`);
  const text = parts.join(' · ');
  return hit.note ? `${text}\n<i>${escapeHtml(hit.note)}</i>` : text;
}

// ---------- Logic theo dõi Take Profit & Stop Loss khi đã vào lệnh ----------

export function calculateRiskReward(
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  stopLoss: number,
  targetPrice: number,
): number {
  const risk = Math.abs(entryPrice - stopLoss);
  if (risk === 0) return 0;
  const reward = direction === 'LONG' ? targetPrice - entryPrice : entryPrice - targetPrice;
  return Math.round((reward / risk) * 100) / 100;
}

export function calculatePnlPct(
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  targetPrice: number,
): number {
  if (entryPrice === 0) return 0;
  const pct = direction === 'LONG' ? ((targetPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - targetPrice) / entryPrice) * 100;
  return Math.round(pct * 100) / 100;
}

export interface PositionEvaluation {
  hitTps: { index: number; price: number; time: number; rr: number; pnlPct: number }[];
  slHit?: { price: number; time: number; rr: number; pnlPct: number };
}

/**
 * Đánh giá vị thế đang chạy với nến 1m đã đóng.
 */
export function evaluatePositionCandles(
  alert: Pick<PriceAlert, 'direction' | 'stopLoss' | 'takeProfits'> & { entryPrice: number },
  candles: readonly Candle[],
  alreadyHitIndices: ReadonlySet<number>,
  sinceSec: number,
): PositionEvaluation {
  const hitTps: PositionEvaluation['hitTps'] = [];
  const hitSet = new Set(alreadyHitIndices);
  let slHit: PositionEvaluation['slHit'];

  const entry = alert.entryPrice;
  const sl = alert.stopLoss;

  for (const c of candles) {
    if (c.time < sinceSec) continue;

    // 1. Kiểm tra các TP chưa chạm
    for (let i = 0; i < alert.takeProfits.length; i++) {
      if (hitSet.has(i)) continue;
      const tp = alert.takeProfits[i]!;
      const hit = alert.direction === 'LONG' ? c.high >= tp : c.low <= tp;
      if (hit) {
        hitSet.add(i);
        const rr = calculateRiskReward(alert.direction, entry, sl, tp);
        const pnlPct = calculatePnlPct(alert.direction, entry, tp);
        hitTps.push({ index: i, price: tp, time: c.time, rr, pnlPct });
      }
    }

    // 2. Kiểm tra SL
    const hitSl = alert.direction === 'LONG' ? c.low <= sl : c.high >= sl;
    if (hitSl) {
      const rr = calculateRiskReward(alert.direction, entry, sl, sl);
      const pnlPct = calculatePnlPct(alert.direction, entry, sl);
      slHit = { price: sl, time: c.time, rr, pnlPct };
      break; // Khi chạm SL thì dừng vị thế
    }
  }

  return { hitTps, slHit };
}

/**
 * Đánh giá vị thế tức thời theo tick giá.
 */
export function evaluatePositionPrice(
  alert: Pick<PriceAlert, 'direction' | 'stopLoss' | 'takeProfits'> & { entryPrice: number },
  price: number,
  timeSec: number,
  alreadyHitIndices: ReadonlySet<number>,
): PositionEvaluation {
  const hitTps: PositionEvaluation['hitTps'] = [];
  const entry = alert.entryPrice;
  const sl = alert.stopLoss;

  for (let i = 0; i < alert.takeProfits.length; i++) {
    if (alreadyHitIndices.has(i)) continue;
    const tp = alert.takeProfits[i]!;
    const hit = alert.direction === 'LONG' ? price >= tp : price <= tp;
    if (hit) {
      const rr = calculateRiskReward(alert.direction, entry, sl, tp);
      const pnlPct = calculatePnlPct(alert.direction, entry, tp);
      hitTps.push({ index: i, price: tp, time: timeSec, rr, pnlPct });
    }
  }

  const hitSl = alert.direction === 'LONG' ? price <= sl : price >= sl;
  const slHit = hitSl
    ? {
        price,
        time: timeSec,
        rr: calculateRiskReward(alert.direction, entry, sl, sl),
        pnlPct: calculatePnlPct(alert.direction, entry, sl),
      }
    : undefined;

  return { hitTps, slHit };
}

export function formatTpHit(
  symbol: string,
  direction: string,
  setupIndex: number,
  tpIndex: number,
  tpCount: number,
  price: number,
  rr: number,
  pnlPct: number,
): string {
  const mark = SETUP_MARKS[setupIndex] ?? `${setupIndex + 1}.`;
  const isFinal = tpIndex === tpCount - 1;
  const emoji = isFinal ? '🏆' : '🎯';
  return (
    `${emoji} <b>${escapeHtml(symbol)}</b> chạm <b>TP${tpIndex + 1}</b> ${mark} ${direction} · ` +
    `giá ${fmtPrice(price)} · +${rr.toFixed(2)}R (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)` +
    (isFinal ? ' · <i>đạt mục tiêu cuối!</i>' : '')
  );
}

export function formatSlHit(
  symbol: string,
  direction: string,
  setupIndex: number,
  price: number,
  rr: number,
  pnlPct: number,
  alreadyHadTps: boolean,
): string {
  const mark = SETUP_MARKS[setupIndex] ?? `${setupIndex + 1}.`;
  return (
    `🛑 <b>${escapeHtml(symbol)}</b> chạm <b>Stop Loss</b> ${mark} ${direction} · ` +
    `giá ${fmtPrice(price)} · ${rr.toFixed(2)}R (${pnlPct.toFixed(2)}%)` +
    (alreadyHadTps ? ' · <i>(đã chốt một phần TP trước đó)</i>' : '')
  );
}
