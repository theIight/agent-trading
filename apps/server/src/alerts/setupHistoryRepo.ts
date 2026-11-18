import type { PriceAlert, SetupHitTp, SetupHistoryRecord, SetupOutcome, SetupPerformanceSummary } from '@wca/shared';
import type { Db } from '../db/index.ts';

interface HistoryRow {
  id: number;
  alert_id: number;
  analysis_id: string;
  symbol: string;
  setup_index: number;
  direction: 'LONG' | 'SHORT';
  entry_type: 'MARKET' | 'LIMIT' | 'STOP';
  tf: string;
  entry_price: number;
  entry_at: number;
  stop_loss: number;
  take_profits: string;
  hit_tps: string;
  exit_price: number | null;
  exit_at: number | null;
  status: SetupOutcome;
  realized_rr: number | null;
  pnl_pct: number | null;
  note: string | null;
}

function toHistoryRecord(r: HistoryRow): SetupHistoryRecord {
  return {
    id: r.id,
    alertId: r.alert_id,
    analysisId: r.analysis_id,
    symbol: r.symbol,
    setupIndex: r.setup_index,
    direction: r.direction,
    entryType: r.entry_type,
    tf: r.tf,
    entryPrice: r.entry_price,
    entryAt: r.entry_at,
    stopLoss: r.stop_loss,
    takeProfits: JSON.parse(r.take_profits) as number[],
    hitTps: JSON.parse(r.hit_tps) as SetupHitTp[],
    exitPrice: r.exit_price ?? undefined,
    exitAt: r.exit_at ?? undefined,
    status: r.status,
    realizedRr: r.realized_rr ?? undefined,
    pnlPct: r.pnl_pct ?? undefined,
    note: r.note ?? undefined,
  };
}

export class SetupHistoryRepo {
  constructor(private readonly db: Db) {}

  createFromAlert(alert: PriceAlert, entryPrice: number, entryAt: number): SetupHistoryRecord {
    // Tránh tạo trùng
    const existing = this.getByAlertId(alert.id);
    if (existing) return existing;

    const res = this.db
      .prepare(
        `INSERT INTO setup_history (
           alert_id, analysis_id, symbol, setup_index, direction, entry_type, tf,
           entry_price, entry_at, stop_loss, take_profits, hit_tps, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`
      )
      .run(
        alert.id,
        alert.analysisId,
        alert.symbol,
        alert.setupIndex,
        alert.direction,
        alert.entryType,
        alert.tf,
        entryPrice,
        entryAt,
        alert.stopLoss,
        JSON.stringify(alert.takeProfits),
        JSON.stringify([])
      );

    return this.getById(Number(res.lastInsertRowid))!;
  }

  getById(id: number): SetupHistoryRecord | null {
    const row = this.db.prepare('SELECT * FROM setup_history WHERE id = ?').get(id) as HistoryRow | undefined;
    return row ? toHistoryRecord(row) : null;
  }

  getByAlertId(alertId: number): SetupHistoryRecord | null {
    const row = this.db.prepare('SELECT * FROM setup_history WHERE alert_id = ?').get(alertId) as HistoryRow | undefined;
    return row ? toHistoryRecord(row) : null;
  }

  recordTpHit(alertId: number, tp: SetupHitTp, isFinal = false): SetupHistoryRecord | null {
    const curr = this.getByAlertId(alertId);
    if (!curr) return null;

    const hitTps = [...curr.hitTps.filter(h => h.index !== tp.index), tp].sort((a, b) => a.index - b.index);
    // Realized RR lấy theo mức TP cao nhất đã chạm
    const maxRr = Math.max(...hitTps.map(h => h.riskReward));
    const nextStatus: SetupOutcome = isFinal ? 'TP_FULL' : 'OPEN';

    this.db
      .prepare(
        `UPDATE setup_history
         SET hit_tps = ?, realized_rr = ?, status = ?,
             exit_price = CASE WHEN ? THEN ? ELSE exit_price END,
             exit_at = CASE WHEN ? THEN ? ELSE exit_at END
         WHERE alert_id = ?`
      )
      .run(
        JSON.stringify(hitTps),
        maxRr,
        nextStatus,
        isFinal ? 1 : 0,
        tp.price,
        isFinal ? 1 : 0,
        tp.time,
        alertId
      );

    return this.getByAlertId(alertId);
  }

  recordSlHit(alertId: number, exitPrice: number, exitAt: number, realizedRr: number, pnlPct: number): SetupHistoryRecord | null {
    const curr = this.getByAlertId(alertId);
    if (!curr) return null;

    // Nếu trước đó đã chạm ít nhất 1 TP thì là TP_PARTIAL, nếu chưa chạm TP nào thì là SL_HIT
    const status: SetupOutcome = curr.hitTps.length > 0 ? 'TP_PARTIAL' : 'SL_HIT';
    const finalRr = curr.hitTps.length > 0 ? curr.realizedRr ?? realizedRr : realizedRr;

    this.db
      .prepare(
        `UPDATE setup_history
         SET exit_price = ?, exit_at = ?, realized_rr = ?, pnl_pct = ?, status = ?
         WHERE alert_id = ?`
      )
      .run(exitPrice, exitAt, finalRr, pnlPct, status, alertId);

    return this.getByAlertId(alertId);
  }

  listAll(opts: { symbol?: string; status?: SetupOutcome; limit?: number } = {}): SetupHistoryRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (opts.symbol) {
      clauses.push('symbol = ?');
      params.push(opts.symbol.toUpperCase());
    }
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = opts.limit ? `LIMIT ${opts.limit}` : 'LIMIT 100';

    const rows = this.db.prepare(`SELECT * FROM setup_history ${where} ORDER BY id DESC ${limit}`).all(...params) as HistoryRow[];
    return rows.map(toHistoryRecord);
  }

  getSummary(symbol?: string): SetupPerformanceSummary {
    const symFilter = symbol ? 'WHERE symbol = ?' : '';
    const params = symbol ? [symbol.toUpperCase()] : [];

    const stats = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_count,
           SUM(CASE WHEN status != 'OPEN' THEN 1 ELSE 0 END) as closed_count,
           SUM(CASE WHEN status IN ('TP_FULL', 'TP_PARTIAL') THEN 1 ELSE 0 END) as win_count,
           SUM(CASE WHEN status = 'SL_HIT' THEN 1 ELSE 0 END) as loss_count,
           COALESCE(SUM(CASE WHEN status != 'OPEN' THEN realized_rr ELSE 0 END), 0) as total_rr
         FROM setup_history ${symFilter}`
      )
      .get(...params) as {
      total: number;
      open_count: number;
      closed_count: number;
      win_count: number;
      loss_count: number;
      total_rr: number;
    };

    const totalTrades = stats.total || 0;
    const closedTrades = stats.closed_count || 0;
    const winTrades = stats.win_count || 0;
    const lossTrades = stats.loss_count || 0;
    const winRate = closedTrades > 0 ? Math.round((winTrades / closedTrades) * 1000) / 10 : 0;
    const totalRealizedRr = Math.round(stats.total_rr * 100) / 100;
    const avgRealizedRr = closedTrades > 0 ? Math.round((totalRealizedRr / closedTrades) * 100) / 100 : 0;

    return {
      totalTrades,
      openTrades: stats.open_count || 0,
      closedTrades,
      winTrades,
      lossTrades,
      winRate,
      totalRealizedRr,
      avgRealizedRr,
    };
  }
}
