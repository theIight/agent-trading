import { LAYER_KEYS, LAYER_LABELS } from '../overlays/model.ts';
import { useAnalysisStore } from '../store/useAnalysisStore.ts';

export function LayerToggles() {
  const { current, layers, toggleLayer } = useAnalysisStore();
  if (!current) return null;
  return (
    <div className="layer-toggles" role="group" aria-label="Lớp hiển thị">
      {LAYER_KEYS.map(k => (
        <label key={k}>
          <input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} />
          {LAYER_LABELS[k]}
        </label>
      ))}
    </div>
  );
}
