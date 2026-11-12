import { LAYER_KEYS, LAYER_LABELS } from '../overlays/model.ts';
import { useAnalysisStore } from '../store/useAnalysisStore.ts';
import { useOrderflowStore } from '../store/useOrderflowStore.ts';

export function LayerToggles() {
  const { current, layers, toggleLayer } = useAnalysisStore();
  const live = useOrderflowStore(s => s.data);
  if (!current && !live) return null;
  // Chưa có phân tích: chỉ có toggle Order flow (live).
  const keys = current ? LAYER_KEYS.filter(k => k !== 'orderflow' || current.orderflow || live) : (['orderflow'] as const);
  return (
    <div className="layer-toggles" role="group" aria-label="Lớp hiển thị">
      {keys.map(k => (
        <label key={k}>
          <input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} />
          {LAYER_LABELS[k]}
        </label>
      ))}
    </div>
  );
}
