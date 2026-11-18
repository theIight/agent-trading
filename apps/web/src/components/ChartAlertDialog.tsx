import { useEffect, useRef, useState } from 'react';
import { useChartAlertsStore } from '../store/useChartAlertsStore.ts';
import { hexToRgba } from '../chart/sound.ts';

const PRESET_COLORS = [
  { name: 'Vàng', hex: '#f59e0b' },
  { name: 'Xanh dương', hex: '#3b82f6' },
  { name: 'Xanh lục', hex: '#10b981' },
  { name: 'Đỏ', hex: '#ef4444' },
  { name: 'Tím', hex: '#a855f7' },
  { name: 'Trắng', hex: '#f8fafc' },
];

interface Props {
  symbol: string;
}

export function ChartAlertDialog({ symbol }: Props) {
  const { dialogPrice, closeDialog, addAlert, setToast } = useChartAlertsStore();
  const [priceStr, setPriceStr] = useState('');
  const [type, setType] = useState<'once' | 'every'>('once');
  const [color, setColor] = useState('#f59e0b');
  const [opacity, setOpacity] = useState(0.8);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialogPrice !== null) {
      setPriceStr(String(dialogPrice));
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [dialogPrice]);

  if (dialogPrice === null) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseFloat(priceStr);
    if (!Number.isFinite(p) || p <= 0) {
      setToast({ text: 'Mức giá không hợp lệ', error: true });
      return;
    }

    setSubmitting(true);
    try {
      await addAlert({
        symbol,
        price: p,
        type,
        color,
        opacity,
      });
      setToast({ text: `Đã đặt alert giá ${p} cho ${symbol}` });
      closeDialog();
    } catch (err) {
      setToast({ text: `Lỗi đặt alert: ${(err as Error).message}`, error: true });
    } finally {
      setSubmitting(false);
    }
  };

  const previewRgba = hexToRgba(color, opacity);

  return (
    <div className="chart-alert-backdrop" onClick={closeDialog}>
      <div className="chart-alert-modal" onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="chart-alert-title">
        <div className="chart-alert-header">
          <h3 id="chart-alert-title">🔔 Đặt alert giá · {symbol}</h3>
          <button type="button" className="close-btn" onClick={closeDialog} aria-label="Đóng">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="alert-price">Mức giá:</label>
            <input
              ref={inputRef}
              id="alert-price"
              type="text"
              className="chart-alert-input"
              value={priceStr}
              onChange={e => setPriceStr(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label>Tần suất kích hoạt:</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="alert-type"
                  value="once"
                  checked={type === 'once'}
                  onChange={() => setType('once')}
                />
                <span>Chỉ 1 lần (Only once)</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="alert-type"
                  value="every"
                  checked={type === 'every'}
                  onChange={() => setType('every')}
                />
                <span>Mỗi lần (Every time)</span>
              </label>
            </div>
          </div>

          <div className="form-group">
            <label>Màu sắc:</label>
            <div className="color-palette">
              {PRESET_COLORS.map(c => (
                <button
                  key={c.hex}
                  type="button"
                  className={`color-btn ${color === c.hex ? 'active' : ''}`}
                  style={{ backgroundColor: c.hex }}
                  onClick={() => setColor(c.hex)}
                  title={c.name}
                />
              ))}
            </div>
          </div>

          <div className="form-group">
            <div className="slider-header">
              <label htmlFor="alert-opacity">Độ đậm nhạt (Opacity):</label>
              <span className="opacity-val">{Math.round(opacity * 100)}%</span>
            </div>
            <input
              id="alert-opacity"
              type="range"
              min="0.2"
              max="1"
              step="0.05"
              className="chart-alert-slider"
              value={opacity}
              onChange={e => setOpacity(parseFloat(e.target.value))}
            />
          </div>

          <div className="form-group preview-box">
            <span className="preview-label">Xem trước đường nét đứt:</span>
            <div
              className="line-preview"
              style={{
                borderBottom: `2px dashed ${previewRgba}`,
              }}
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-cancel" onClick={closeDialog}>
              Hủy
            </button>
            <button type="submit" className="btn-submit" disabled={submitting}>
              {submitting ? 'Đang tạo...' : 'Tạo alert'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
