import { useEffect, useRef, useState } from 'react';
import { DISPLAY_RANGES, type DisplaySettings } from '../chart/displaySettings.ts';
import { useChartSettingsStore } from '../store/useChartSettingsStore.ts';

// Nút ⚙: bảng cài đặt hiển thị chart (cỡ chữ, ngưỡng đột biến, độ đậm heatmap, bong bóng thanh lý, đếm ngược).

type NumKey = keyof typeof DISPLAY_RANGES;
const KEYS = Object.keys(DISPLAY_RANGES) as NumKey[];

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const { settings, update, reset } = useChartSettingsStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="settings" ref={ref}>
      <button type="button" className="icon-btn" aria-label="Cài đặt hiển thị" title="Cài đặt hiển thị" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        ⚙
      </button>
      {open && (
        <div className="settings-panel" role="dialog" aria-label="Cài đặt hiển thị">
          <div className="settings-title">Cài đặt hiển thị</div>
          {KEYS.map(k => {
            const r = DISPLAY_RANGES[k];
            const v = settings[k];
            return (
              <label key={k} className="settings-row">
                <span>{r.label}</span>
                <span className="settings-ctrl">
                  <input
                    type="range"
                    min={r.min}
                    max={r.max}
                    step={r.step}
                    value={v}
                    onChange={e => update({ [k]: Number(e.target.value) } as Partial<DisplaySettings>)}
                  />
                  <b>
                    {v}
                    {r.unit === 'px' ? 'px' : r.unit === '×' ? '×' : `× ngưỡng`}
                  </b>
                </span>
              </label>
            );
          })}
          <label className="settings-row check">
            <span>Hiện đếm ngược đóng nến</span>
            <input type="checkbox" checked={settings.showCountdown} onChange={e => update({ showCountdown: e.target.checked })} />
          </label>
          <div className="settings-foot">
            <span className="muted">Ngưỡng đột biến chỉ đổi phần vẽ trên chart (agent dùng ngưỡng server).</span>
            <button type="button" className="chip ghost" onClick={reset}>
              Mặc định
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
