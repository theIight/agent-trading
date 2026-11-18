import { useEffect, useState } from 'react';
import type { SetupHistoryRecord, SetupOutcome, SetupPerformanceSummary } from '@wca/shared';
import { fetchSetupHistory, fetchSetupPerformance } from '../api/client.ts';

const fmtPrice = (p?: number) => (p === undefined ? '—' : p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 1 : 6 }));
const fmtDateTime = (sec?: number) =>
  sec ? new Date(sec * 1000).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const OUTCOME_LABEL: Record<SetupOutcome, { label: string; cls: string }> = {
  OPEN: { label: 'Đang chạy', cls: 'running' },
  TP_FULL: { label: 'Full TP 🏆', cls: 'win' },
  TP_PARTIAL: { label: 'TP 1 phần 🎯', cls: 'partial' },
  SL_HIT: { label: 'Chạm SL 🛑', cls: 'loss' },
};

interface SetupHistoryModalProps {
  currentSymbol?: string;
  onClose: () => void;
}

export function SetupHistoryModal({ currentSymbol, onClose }: SetupHistoryModalProps) {
  const [filterSymbol, setFilterSymbol] = useState<string | undefined>(currentSymbol);
  const [summary, setSummary] = useState<SetupPerformanceSummary | null>(null);
  const [history, setHistory] = useState<SetupHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      fetchSetupPerformance(filterSymbol),
      fetchSetupHistory({ symbol: filterSymbol, limit: 100 }),
    ])
      .then(([s, h]) => {
        if (!alive) return;
        setSummary(s);
        setHistory(h);
      })
      .catch(err => console.error('Lỗi tải lịch sử setup:', err))
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [filterSymbol]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog setup-history-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-group">
            <h3>📊 Đánh giá hiệu quả Trade Setup</h3>
            <div className="symbol-filter-tabs">
              <button
                type="button"
                className={`tab-btn ${filterSymbol ? 'active' : ''}`}
                onClick={() => setFilterSymbol(currentSymbol)}
              >
                {currentSymbol ?? 'Cặp hiện tại'}
              </button>
              <button
                type="button"
                className={`tab-btn ${!filterSymbol ? 'active' : ''}`}
                onClick={() => setFilterSymbol(undefined)}
              >
                Tất cả cặp
              </button>
            </div>
          </div>
          <button type="button" className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {summary && (
          <div className="setup-perf-grid">
            <div className="perf-card">
              <div className="perf-label">Tỉ lệ thắng (Win Rate)</div>
              <div className={`perf-value ${summary.winRate >= 50 ? 'up' : 'down'}`}>
                {summary.winRate}%
              </div>
              <div className="perf-sub muted">
                {summary.winTrades} thắng / {summary.lossTrades} thua ({summary.closedTrades} lệnh đã đóng)
              </div>
            </div>

            <div className="perf-card">
              <div className="perf-label">Tổng R:R tích luỹ</div>
              <div className={`perf-value ${summary.totalRealizedRr >= 0 ? 'up' : 'down'}`}>
                {summary.totalRealizedRr >= 0 ? `+${summary.totalRealizedRr}` : summary.totalRealizedRr}R
              </div>
              <div className="perf-sub muted">
                Trung bình: {summary.avgRealizedRr >= 0 ? `+${summary.avgRealizedRr}` : summary.avgRealizedRr}R / lệnh
              </div>
            </div>

            <div className="perf-card">
              <div className="perf-label">Lệnh đang chạy</div>
              <div className="perf-value">{summary.openTrades}</div>
              <div className="perf-sub muted">Tổng cộng {summary.totalTrades} setup khớp entry</div>
            </div>
          </div>
        )}

        <div className="history-table-container">
          {loading ? (
            <div className="loading-state muted">Đang tải lịch sử setup...</div>
          ) : history.length === 0 ? (
            <div className="empty-state muted">
              Chưa có lịch sử giao dịch nào được ghi nhận. Khi có setup khớp entry và chạm TP/SL, hệ thống sẽ tự động tổng hợp tại đây.
            </div>
          ) : (
            <table className="setup-history-table">
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Cặp & Chiều</th>
                  <th>Entry</th>
                  <th>SL / TP</th>
                  <th>Kết quả</th>
                  <th>Thực tế R:R</th>
                  <th>Thời gian thoát</th>
                </tr>
              </thead>
              <tbody>
                {history.map(rec => {
                  const out = OUTCOME_LABEL[rec.status];
                  return (
                    <tr key={rec.id}>
                      <td className="time-col">{fmtDateTime(rec.entryAt)}</td>
                      <td>
                        <b>{rec.symbol}</b> <span className={rec.direction === 'LONG' ? 'up' : 'down'}>{rec.direction}</span> ({rec.tf})
                      </td>
                      <td><b>{fmtPrice(rec.entryPrice)}</b></td>
                      <td className="levels-col">
                        <span className="down">SL: {fmtPrice(rec.stopLoss)}</span>
                        <br />
                        <span className="up">
                          TP: {rec.takeProfits.map(fmtPrice).join(' / ')}
                        </span>
                      </td>
                      <td>
                        <span className={`outcome-badge ${out.cls}`}>{out.label}</span>
                        {rec.hitTps.length > 0 && (
                          <div className="hit-tps-note muted">
                            (chạm {rec.hitTps.map(h => `TP${h.index + 1}`).join(', ')})
                          </div>
                        )}
                      </td>
                      <td>
                        {rec.realizedRr !== undefined ? (
                          <b className={rec.realizedRr >= 0 ? 'up' : 'down'}>
                            {rec.realizedRr >= 0 ? `+${rec.realizedRr.toFixed(2)}` : rec.realizedRr.toFixed(2)}R
                            {rec.pnlPct !== undefined && <span className="muted"> ({rec.pnlPct >= 0 ? `+${rec.pnlPct}%` : `${rec.pnlPct}%`})</span>}
                          </b>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="time-col">{fmtDateTime(rec.exitAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
