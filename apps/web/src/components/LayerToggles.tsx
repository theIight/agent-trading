import { LAYER_KEYS, LAYER_LABELS } from '../overlays/model.ts';
import { useAnalysisStore } from '../store/useAnalysisStore.ts';
import { useLiquidationStore } from '../store/useLiquidationStore.ts';
import { useOrderflowStore } from '../store/useOrderflowStore.ts';
import { useAppStore } from '../store/useAppStore.ts';
import { useVolumeAggStore } from '../store/useVolumeAggStore.ts';

export function LayerToggles() {
  const { current, layers, toggleLayer } = useAnalysisStore();
  const live = useOrderflowStore(s => s.data);
  const { data: liq, showBubbles, showHeatmap, toggleBubbles, toggleHeatmap } = useLiquidationStore();
  const symbol = useAppStore(s => s.symbol);
  const volAggSupported = useAnalysisStore(s => s.volumeAggSymbols.includes(symbol));
  const { enabled: volAggOn, toggle: toggleVolAgg } = useVolumeAggStore();
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
      {volAggSupported && (
        <label title="Nến đã đóng: cột volume = perp Binance Futures + OKX + Bybit, phần cam phía trên = Binance spot. Dấu S/P/S+P = đột biến spot / perp / cả hai (> 3× trung vị 20 nến)">
          <input type="checkbox" checked={volAggOn} onChange={toggleVolAgg} />
          Volume gộp
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
