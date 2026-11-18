import { useState, useRef, useEffect } from 'react';
import { useChartAlertsStore } from '../store/useChartAlertsStore.ts';
import { hexToRgba } from '../chart/sound.ts';

interface Props {
  symbol: string;
}

export function ChartAlertsBadge({ symbol }: Props) {
  const { alerts, removeAlert, setToast } = useChartAlertsStore();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Lọc alert theo symbol hiện tại
  const currentAlerts = alerts.filter(a => a.symbol === symbol.toUpperCase() && a.status === 'ACTIVE');

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open]);

  if (currentAlerts.length === 0) return null;

  const handleDelete = async (id: string, price: number) => {
    try {
      await removeAlert(id);
      setToast({ text: `Đã xoá alert giá ${price}` });
    } catch (err) {
      setToast({ text: `Lỗi xoá alert: ${(err as Error).message}`, error: true });
    }
  };

  return (
    <div className="chart-alerts-badge-wrap" ref={popoverRef}>
      <button
        type="button"
        className="chart-alerts-badge-btn"
        onClick={() => setOpen(prev => !prev)}
        title={`Có ${currentAlerts.length} alert giá đang canh trên ${symbol}`}
      >
        🔔 {currentAlerts.length}
      </button>

      {open && (
        <div className="chart-alerts-popover">
          <div className="popover-header">
            <span>Alerts giá {symbol}</span>
            <button type="button" className="close-btn" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          <ul className="popover-list">
            {currentAlerts.map(a => (
              <li key={a.id} className="popover-item">
                <span
                  className="dot"
                  style={{ backgroundColor: hexToRgba(a.color, a.opacity) }}
                  title={`Độ đậm: ${Math.round(a.opacity * 100)}%`}
                />
                <span className="price">{a.price}</span>
                <span className="type-tag">{a.type === 'once' ? '1 lần' : 'Mỗi lần'}</span>
                <button
                  type="button"
                  className="del-btn"
                  onClick={() => void handleDelete(a.id, a.price)}
                  title="Xoá alert này"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
