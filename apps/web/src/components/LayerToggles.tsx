import { isVolumeSource, VOLUME_SOURCE_LABELS, VOLUME_SOURCES } from '@wca/shared';
import { LAYER_KEYS, LAYER_LABELS } from '../overlays/model.ts';
import { useAnalysisStore } from '../store/useAnalysisStore.ts';
import { useLiquidationStore } from '../store/useLiquidationStore.ts';
import { useOrderflowStore } from '../store/useOrderflowStore.ts';
import { useBookHeatmapStore } from '../store/useBookHeatmapStore.ts';
import { useAppStore } from '../store/useAppStore.ts';
import { useVolumeAggStore } from '../store/useVolumeAggStore.ts';

export function LayerToggles() {
  const { current, layers, toggleLayer } = useAnalysisStore();
  const live = useOrderflowStore(s => s.data);
  const { data: liq, showBubbles, showHeatmap, toggleBubbles, toggleHeatmap } = useLiquidationStore();
  const symbol = useAppStore(s => s.symbol);
  const volAggSupported = useAnalysisStore(s => s.volumeAggSymbols.includes(symbol));
  const { source: volSource, setSource: setVolSource } = useVolumeAggStore();
  const { show: showBookHeat, toggle: toggleBookHeat } = useBookHeatmapStore();
  if (!current && !live && !liq && !volAggSupported) return null;
  // Chưa có phân tích: chỉ có toggle Order flow (live) và thanh lý.
  const keys = current ? LAYER_KEYS.filter(k => k !== 'orderflow' || current.orderflow || live) : live ? (['orderflow'] as const) : [];
  return (
    <div className="layer-toggles" role="group" aria-label="Lớp hiển thị">
      {keys.map(k => (
        <label key={k}>
          <input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} />
          {LAYER_LABELS[k]}
        </label>
      ))}
      {live && (
        <label title="Khối lượng lệnh chờ trung bình theo bucket giá × nến (Binance, 24 giờ gần nhất). Sáng = thanh khoản dày. Vàng: sổ lệnh futures chỉ phủ dải hẹp quanh giá">
          <input type="checkbox" checked={showBookHeat} onChange={toggleBookHeat} />
          Heatmap sổ lệnh
        </label>
      )}
      {volAggSupported && (
        <label
          className="vol-source"
          title="Nguồn cột volume (nến đã đóng). Gộp perp + spot: cột perp 3 sàn + phần cam = Binance spot, dấu S/P/S+P. Nguồn đơn lẻ / tổng: cột volume của nguồn đó, dấu đột biến theo chính nguồn (ngưỡng trong ⚙)"
        >
          Volume
          <select value={volSource} onChange={e => isVolumeSource(e.target.value) && setVolSource(e.target.value)}>
            {VOLUME_SOURCES.map(s => (
              <option key={s} value={s}>
                {VOLUME_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      )}
      {liq && (
        <>
          <label title="Thanh lý đã xảy ra (Binance + OKX; Binance chỉ đẩy 1 lệnh/giây nên đếm thiếu). Đỏ = long bị thanh lý, xanh = short bị thanh lý">
            <input type="checkbox" checked={showBubbles} onChange={toggleBubbles} />
            Thanh lý
          </label>
          <label title="Mức thanh lý ƯỚC TÍNH từ open interest Binance (mô hình, đòn bẩy giả định) — không phải dữ liệu thật">
            <input type="checkbox" checked={showHeatmap} onChange={toggleHeatmap} />
            Heatmap thanh lý <span className="muted">(ước tính)</span>
          </label>
        </>
      )}
    </div>
  );
}
