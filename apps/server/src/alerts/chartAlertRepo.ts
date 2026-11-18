import crypto from 'node:crypto';
import type { ChartAlert, ChartAlertStatus, ChartAlertType } from '@wca/shared';
import type { Db } from '../db/index.ts';

interface Row {
  id: string;
  symbol: string;
  price: number;
  type: ChartAlertType;
  color: string;
  opacity: number;
  status: ChartAlertStatus;
  created_at: number;
  triggered_at: number | null;
  note: string | null;
}

function toChartAlert(r: Row): ChartAlert {
  return {
    id: r.id,
    symbol: r.symbol,
    price: r.price,
    type: r.type,
    color: r.color,
    opacity: r.opacity,
    status: r.status,
    createdAt: r.created_at,
    triggeredAt: r.triggered_at,
    note: r.note,
  };
}

export interface NewChartAlertData {
  id?: string;
  symbol: string;
  price: number;
  type: ChartAlertType;
  color: string;
  opacity: number;
  note?: string | null;
}

export class ChartAlertRepo {
  constructor(private readonly db: Db) {}

  get(id: string): ChartAlert | null {
    const row = this.db.prepare(`SELECT * FROM chart_alerts WHERE id = ?`).get(id) as Row | undefined;
    return row ? toChartAlert(row) : null;
  }

  listActive(symbol?: string): ChartAlert[] {
    const rows = (
      symbol
        ? this.db.prepare(`SELECT * FROM chart_alerts WHERE status = 'ACTIVE' AND symbol = ? ORDER BY created_at DESC`).all(symbol)
        : this.db.prepare(`SELECT * FROM chart_alerts WHERE status = 'ACTIVE' ORDER BY created_at DESC`).all()
    ) as Row[];
    return rows.map(toChartAlert);
  }

  listAll(symbol?: string): ChartAlert[] {
    const rows = (
      symbol
        ? this.db.prepare(`SELECT * FROM chart_alerts WHERE symbol = ? ORDER BY created_at DESC`).all(symbol)
        : this.db.prepare(`SELECT * FROM chart_alerts ORDER BY created_at DESC`).all()
    ) as Row[];
    return rows.map(toChartAlert);
  }

  create(data: NewChartAlertData, nowSec = Math.floor(Date.now() / 1000)): ChartAlert {
    const id = data.id || crypto.randomUUID();
    const opacity = Math.min(1, Math.max(0.1, Number(data.opacity) || 1));
    this.db
      .prepare(
        `INSERT INTO chart_alerts (id, symbol, price, type, color, opacity, status, created_at, triggered_at, note)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, ?)`
      )
      .run(id, data.symbol.toUpperCase(), data.price, data.type, data.color, opacity, nowSec, data.note ?? null);
    return this.get(id)!;
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM chart_alerts WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  /**
   * Đánh dấu khi giá chạm mức alert.
   * - Nếu type === 'once': chuyển status sang 'TRIGGERED' (hoàn thành).
   * - Nếu type === 'every': giữ 'ACTIVE', cập nhật `triggered_at` để cooldown.
   */
  markTriggered(id: string, triggeredAt: number, isOnce: boolean, note?: string | null): ChartAlert | null {
    if (isOnce) {
      const res = this.db
        .prepare(`UPDATE chart_alerts SET status = 'TRIGGERED', triggered_at = ?, note = COALESCE(?, note) WHERE id = ? AND status = 'ACTIVE'`)
        .run(triggeredAt, note ?? 'đã chạm giá', id);
      return res.changes > 0 ? this.get(id) : null;
    }
    const res = this.db
      .prepare(`UPDATE chart_alerts SET triggered_at = ?, note = COALESCE(?, note) WHERE id = ? AND status = 'ACTIVE'`)
      .run(triggeredAt, note ?? 'đã chạm giá', id);
    return res.changes > 0 ? this.get(id) : null;
  }
}
