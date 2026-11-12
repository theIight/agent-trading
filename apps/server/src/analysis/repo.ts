import { ORDERFLOW_SOURCES, type AnalysisRecord, type AnalysisResult, type AnalysisStatus, type OrderflowSource } from '@wca/shared';
import type { Db } from '../db/index.ts';

interface Row {
  id: string;
  symbol: string;
  primary_tf: string;
  tfs: string;
  status: AnalysisStatus;
  created_at: number;
  finished_at: number | null;
  result: string | null;
  error: string | null;
  runner: string | null;
  model: string | null;
  bookmap: number | null;
  orderflow_source: string | null;
}

function toRecord(row: Row, withResult = true): AnalysisRecord {
  return {
    id: row.id,
    symbol: row.symbol,
    primaryTf: row.primary_tf,
    tfs: JSON.parse(row.tfs) as string[],
    status: row.status,
    runner: row.runner ?? 'claude-code',
    model: row.model ?? undefined,
    ...(row.bookmap ? { bookmap: true } : {}),
    ...((ORDERFLOW_SOURCES as readonly string[]).includes(row.orderflow_source ?? '')
      ? { orderflowSource: row.orderflow_source as OrderflowSource }
      : row.bookmap
        ? { orderflowSource: 'bookmap-image' as const }
        : {}),
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
    result: withResult && row.result ? (JSON.parse(row.result) as AnalysisResult) : undefined,
    error: row.error ?? undefined,
  };
}

export class AnalysisRepo {
  constructor(private readonly db: Db) {}

  create(rec: Pick<AnalysisRecord, 'id' | 'symbol' | 'primaryTf' | 'tfs' | 'status' | 'createdAt' | 'runner' | 'model' | 'bookmap' | 'orderflowSource'>): void {
    this.db
      .prepare(
        `INSERT INTO analyses (id, symbol, primary_tf, tfs, status, created_at, runner, model, bookmap, orderflow_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.symbol,
        rec.primaryTf,
        JSON.stringify(rec.tfs),
        rec.status,
        rec.createdAt,
        rec.runner ?? null,
        rec.model ?? null,
        rec.bookmap ? 1 : null,
        rec.orderflowSource ?? null,
      );
  }

  get(id: string): AnalysisRecord | null {
    const row = this.db.prepare(`SELECT * FROM analyses WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  list(symbol?: string, limit = 50): AnalysisRecord[] {
    const rows = (symbol
      ? this.db.prepare(`SELECT * FROM analyses WHERE symbol = ? ORDER BY created_at DESC LIMIT ?`).all(symbol, limit)
      : this.db.prepare(`SELECT * FROM analyses ORDER BY created_at DESC LIMIT ?`).all(limit)) as Row[];
    // Danh sách gọn: chỉ kèm tóm tắt, không kèm toàn bộ result.
    return rows.map(r => {
      const rec = toRecord(r, false);
      if (r.result) {
        const res = JSON.parse(r.result) as AnalysisResult;
        rec.result = { ...res, events: [], ranges: [], phases: [], levels: [], scenarios: [] };
      }
      return rec;
    });
  }

  finish(id: string, status: Exclude<AnalysisStatus, 'RUNNING'>, payload: { result?: AnalysisResult; error?: string }): void {
    this.db
      .prepare(`UPDATE analyses SET status = ?, finished_at = ?, result = COALESCE(?, result), error = ? WHERE id = ?`)
      .run(status, Date.now(), payload.result ? JSON.stringify(payload.result) : null, payload.error ?? null, id);
  }

  /** Khi server khởi động lại, các bản ghi RUNNING cũ không còn process chạy. */
  failStaleRunning(): number {
    return this.db
      .prepare(`UPDATE analyses SET status = 'FAILED', finished_at = ?, error = 'Server khởi động lại khi đang phân tích' WHERE status = 'RUNNING'`)
      .run(Date.now()).changes;
  }
}
