import type { PriceAlert, PriceAlertStatus } from '@wca/shared';
import type { Db } from '../db/index.ts';
import type { NewPriceAlert } from './alertLogic.ts';

// Lưu alert chạm entry (bảng `price_alerts`). Mọi đổi trạng thái chỉ áp dụng khi alert còn ARMED → không báo trùng.

interface Row {
  id: number;
  analysis_id: string;
  symbol: string;
  setup_index: number;
  direction: 'LONG' | 'SHORT';
  entry_type: 'MARKET' | 'LIMIT' | 'STOP';
  tf: string;
  entry_low: number;
  entry_high: number;
  stop_loss: number;
  take_profits: string;
  risk_reward: number | null;
  valid_until: number;
  armed_at: number;
  checked_until: number | null;
  arm_price: number | null;
  status: PriceAlertStatus;
  status_at: number;
  trigger_price: number | null;
  note: string | null;
}

function toAlert(r: Row): PriceAlert {
  return {
    id: r.id,
    analysisId: r.analysis_id,
    symbol: r.symbol,
    setupIndex: r.setup_index,
    direction: r.direction,
    entryType: r.entry_type,
    tf: r.tf,
    entryLow: r.entry_low,
    entryHigh: r.entry_high,
    stopLoss: r.stop_loss,
    takeProfits: JSON.parse(r.take_profits) as number[],
    ...(r.risk_reward !== null ? { riskReward: r.risk_reward } : {}),
    validUntil: r.valid_until,
    armedAt: r.armed_at,
    ...(r.arm_price !== null ? { armPrice: r.arm_price } : {}),
    ...(r.checked_until !== null ? { checkedUntil: r.checked_until } : {}),
    status: r.status,
    statusAt: r.status_at,
    ...(r.trigger_price !== null ? { triggerPrice: r.trigger_price } : {}),
    ...(r.note !== null ? { note: r.note } : {}),
  };
}

export class AlertRepo {
  constructor(private readonly db: Db) {}

  get(id: number): PriceAlert | null {
    const row = this.db.prepare(`SELECT * FROM price_alerts WHERE id = ?`).get(id) as Row | undefined;
    return row ? toAlert(row) : null;
  }

  byAnalysis(analysisId: string): PriceAlert[] {
    return (this.db.prepare(`SELECT * FROM price_alerts WHERE analysis_id = ? ORDER BY setup_index`).all(analysisId) as Row[]).map(toAlert);
  }

  armed(symbol?: string): PriceAlert[] {
    const rows = symbol
      ? this.db.prepare(`SELECT * FROM price_alerts WHERE status = 'ARMED' AND symbol = ? ORDER BY id`).all(symbol)
      : this.db.prepare(`SELECT * FROM price_alerts WHERE status = 'ARMED' ORDER BY id`).all();
    return (rows as Row[]).map(toAlert);
  }

  /**
   * Phân tích DONE mới của symbol: alert ARMED cũ (của phân tích khác) → REPLACED, rồi thêm alert mới. Một transaction.
   * Trả alert bị thay + alert mới.
   */
  replaceAndInsert(symbol: string, analysisId: string, fresh: readonly NewPriceAlert[], nowSec: number): { replaced: PriceAlert[]; inserted: PriceAlert[] } {
    return this.db.transaction(() => {
      // Cùng phân tích phát `result` lại → không đặt trùng, không thay alert của phân tích khác.
      if (this.db.prepare(`SELECT 1 FROM price_alerts WHERE analysis_id = ? LIMIT 1`).get(analysisId)) return { replaced: [], inserted: [] };
      const old = (
        this.db.prepare(`SELECT * FROM price_alerts WHERE status = 'ARMED' AND symbol = ? AND analysis_id != ?`).all(symbol, analysisId) as Row[]
      ).map(r => r.id);
      const upd = this.db.prepare(`UPDATE price_alerts SET status = 'REPLACED', status_at = ?, note = 'có phân tích mới' WHERE id = ? AND status = 'ARMED'`);
      for (const id of old) upd.run(nowSec, id);
      const ins = this.db.prepare(
        `INSERT INTO price_alerts (analysis_id, symbol, setup_index, direction, entry_type, tf, entry_low, entry_high, stop_loss, take_profits,
           risk_reward, valid_until, armed_at, arm_price, status, status_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ARMED', ?)`,
      );
      const ids: number[] = [];
      for (const a of fresh) {
        const r = ins.run(
          a.analysisId,
          a.symbol,
          a.setupIndex,
          a.direction,
          a.entryType,
          a.tf,
          a.entryLow,
          a.entryHigh,
          a.stopLoss,
          JSON.stringify(a.takeProfits),
          a.riskReward ?? null,
          a.validUntil,
          a.armedAt,
          a.armPrice ?? null,
          a.armedAt,
        );
        ids.push(Number(r.lastInsertRowid));
      }
      return { replaced: old.map(id => this.get(id)!), inserted: ids.map(id => this.get(id)!) };
    })();
  }

  /** ARMED → `status` (TRIGGERED / INVALIDATED / EXPIRED / CANCELED). Trả alert mới nếu đổi được, null nếu không còn ARMED. */
  transition(id: number, status: Exclude<PriceAlertStatus, 'ARMED'>, atSec: number, extra: { price?: number; note?: string; checkedUntil?: number } = {}): PriceAlert | null {
    return this.db.transaction(() => {
      const r = this.db
        .prepare(
          `UPDATE price_alerts SET status = ?, status_at = ?, trigger_price = COALESCE(?, trigger_price), note = COALESCE(?, note),
             checked_until = COALESCE(?, checked_until)
           WHERE id = ? AND status = 'ARMED'`,
        )
        .run(status, atSec, extra.price ?? null, extra.note ?? null, extra.checkedUntil ?? null, id);
      return r.changes ? this.get(id) : null;
    })();
  }

  setCheckedUntil(id: number, checkedUntil: number): void {
    this.db.prepare(`UPDATE price_alerts SET checked_until = ? WHERE id = ? AND status = 'ARMED' AND (checked_until IS NULL OR checked_until < ?)`).run(checkedUntil, id, checkedUntil);
  }

  /** Tắt alert ARMED của symbol (lệnh bot). */
  cancelSymbol(symbol: string, nowSec: number): PriceAlert[] {
    return this.db.transaction(() => {
      const ids = (this.db.prepare(`SELECT id FROM price_alerts WHERE status = 'ARMED' AND symbol = ?`).all(symbol) as { id: number }[]).map(r => r.id);
      return ids.map(id => this.transition(id, 'CANCELED', nowSec, { note: 'tắt bằng lệnh bot' })).filter((a): a is PriceAlert => a !== null);
    })();
  }
}
