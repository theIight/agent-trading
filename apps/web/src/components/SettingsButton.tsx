import { useEffect, useRef, useState } from 'react';
import { DISPLAY_RANGES, HEAT_STOP_LABELS, OF_COLOR_MODES, type DisplaySettings, type HeatStops, type OfColorMode } from '../chart/displaySettings.ts';
import { defaultHeatStops } from '../overlays/orderflowStyle.ts';
import { useAppStore } from '../store/useAppStore.ts';
import { useChartSettingsStore } from '../store/useChartSettingsStore.ts';

// Nút ⚙: bảng cài đặt hiển thị chart (cỡ chữ, ngưỡng đột biến, độ đậm heatmap, bong bóng thanh lý, đếm ngược).

type NumKey = keyof typeof DISPLAY_RANGES;
const KEYS = Object.keys(DISPLAY_RANGES) as NumKey[];

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const { settings, update, reset } = useChartSettingsStore();
  const theme = useAppStore(s => s.theme);
  // Chưa tự chọn → ô màu hiện thang mặc định của theme đang dùng.
  const heatStops = settings.ofHeatStops ?? defaultHeatStops(theme === 'light');
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
            <span>Màu order flow</span>
            <select value={settings.ofColorMode} onChange={e => update({ ofColorMode: e.target.value as OfColorMode })}>
              {OF_COLOR_MODES.map(m => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {settings.ofColorMode === 'bookmap' && (
            <div className="settings-row">
              <span>Thang màu tường (nhỏ → lớn)</span>
              <span className="settings-ctrl heat-stops">
                {heatStops.map((c, i) => (
                  <label key={HEAT_STOP_LABELS[i]} className="heat-stop" title={`Tường ${HEAT_STOP_LABELS[i]} so với tường lớn nhất`}>
                    <input
                      type="color"
                      value={c}
                      onChange={e => update({ ofHeatStops: heatStops.map((h, j) => (j === i ? e.target.value : h)) as HeatStops })}
                    />
                    <small>{HEAT_STOP_LABELS[i]}</small>
                  </label>
                ))}
                <button type="button" className="chip ghost" disabled={!settings.ofHeatStops} onClick={() => update({ ofHeatStops: null })}>
                  Màu mặc định
                </button>
              </span>
            </div>
          )}
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
