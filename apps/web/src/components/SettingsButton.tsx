import { Fragment, useEffect, useRef, useState } from 'react';
import {
  DISPLAY_RANGES,
  HEAT_STOP_LABELS,
  OF_COLOR_MODES,
  bookHeatMinQtyOf,
  withBookHeatMinQty,
  type DisplaySettings,
  type HeatStops,
  type OfColorMode,
} from '../chart/displaySettings.ts';
import { defaultHeatStops } from '../overlays/orderflowStyle.ts';
import { useAppStore } from '../store/useAppStore.ts';
import { useBookHeatmapStore } from '../store/useBookHeatmapStore.ts';
import { useChartSettingsStore } from '../store/useChartSettingsStore.ts';

// Nút ⚙: bảng cài đặt hiển thị chart (cỡ chữ, ngưỡng đột biến, độ đậm heatmap, bong bóng thanh lý, đếm ngược).

type NumKey = keyof typeof DISPLAY_RANGES;
const KEYS = Object.keys(DISPLAY_RANGES) as NumKey[];

/** Đơn vị hiển thị sau giá trị thanh trượt (px, ×, % viết liền; còn lại cách một khoảng). */
const unitSuffix = (unit: string) => (unit === 'px' || unit === '×' || unit === '%' ? unit : ` ${unit}`);

/** Số khối lượng gọn cho gợi ý / ô nhập (giữ 2 chữ số có nghĩa với số nhỏ). */
function fmtQty(n: number): string {
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return String(Math.round(n * 10) / 10);
  return String(Number(n.toPrecision(2)));
}

/** Đơn vị base của symbol khi chưa có dữ liệu heatmap (BTCUSDT → BTC). */
const baseUnit = (symbol: string) => (symbol.endsWith('USDT') ? symbol.slice(0, -4) : '');

/** Heatmap sổ lệnh: ngưỡng khối lượng tuyệt đối của symbol đang xem + gợi ý phân vị trong vùng đang nhìn. */
function BookHeatMinQtyRow() {
  const { settings, update } = useChartSettingsStore();
  const symbol = useBookHeatmapStore(s => s.symbol);
  const unit = useBookHeatmapStore(s => (s.data && s.data.symbol === s.symbol ? s.data.unit : null));
  const stats = useBookHeatmapStore(s => (s.viewStats && s.viewStats.symbol === s.symbol ? s.viewStats : null));
  const saved = symbol ? bookHeatMinQtyOf(settings, symbol) : 0;
  // Bản nháp chuỗi để gõ được "0." / xoá trống; đổi symbol hoặc giá trị lưu khác bản nháp → đồng bộ lại.
  const [draft, setDraft] = useState(saved ? String(saved) : '');
  useEffect(() => setDraft(d => (Number(d || 0) === saved ? d : saved ? String(saved) : '')), [symbol, saved]);
  if (!symbol) return null;
  const u = unit ?? baseUnit(symbol);
  const commit = (qty: number) => update({ bookHeatMinQty: withBookHeatMinQty(settings.bookHeatMinQty, symbol, qty) });
  return (
    <div className="settings-row">
      <span>
        Heatmap sổ lệnh: chỉ hiện ô ≥ <small className="muted">({symbol})</small>
      </span>
      <span className="settings-ctrl">
        <input
          className="min-qty"
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          placeholder="tắt"
          aria-label={`Ngưỡng khối lượng heatmap sổ lệnh ${symbol}`}
          value={draft}
          onChange={e => {
            setDraft(e.target.value);
            const v = e.target.value.trim() === '' ? 0 : Number(e.target.value);
            if (Number.isFinite(v) && v >= 0) commit(v);
          }}
        />
        <span>{u}</span>
        {saved > 0 && (
          <button type="button" className="chip ghost" onClick={() => commit(0)}>
            Tắt
          </button>
        )}
      </span>
      <small className="muted min-qty-hint">
        {stats ? (
          <>
            Vùng đang nhìn:{' '}
            {(
              [
                ['trung vị', stats.p50],
                ['p90', stats.p90],
                ['p99', stats.p99],
              ] as const
            ).map(([label, q], i) => (
              <Fragment key={label}>
                {i > 0 && ' · '}
                <button type="button" className="link-btn" title="Dùng làm ngưỡng" onClick={() => commit(Number(fmtQty(q)))}>
                  {label} {fmtQty(q)}
                </button>
              </Fragment>
            ))}{' '}
            {u}
          </>
        ) : (
          'Bật lớp heatmap sổ lệnh để xem gợi ý theo vùng đang nhìn.'
        )}
      </small>
    </div>
  );
}

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
              <Fragment key={k}>
                <label className="settings-row">
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
                      {unitSuffix(r.unit)}
                    </b>
                  </span>
                </label>
                {k === 'bookHeatHidePct' && <BookHeatMinQtyRow />}
              </Fragment>
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
