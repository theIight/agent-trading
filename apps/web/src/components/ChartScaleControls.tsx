import type { RefObject } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { useChartSettingsStore } from '../store/useChartSettingsStore.ts';

interface Props {
  controllerRef: RefObject<ChartController | null>;
}

/** Cụm nút điều khiển thang giá ở góc dưới bên phải biểu đồ (kiểu TradingView: auto / log). */
export function ChartScaleControls({ controllerRef }: Props) {
  const logScale = useChartSettingsStore(s => s.settings.logScale);
  const update = useChartSettingsStore(s => s.update);

  const toggleLog = () => {
    update({ logScale: !logScale });
  };

  const resetAuto = () => {
    controllerRef.current?.resetPriceScale();
  };

  return (
    <div className="chart-scale-controls" aria-label="Điều khiển thang giá">
      <button
        type="button"
        className="scale-btn"
        title="Tự động co giãn trục giá (Auto scale)"
        onClick={resetAuto}
      >
        auto
      </button>
      <button
        type="button"
        className={`scale-btn ${logScale ? 'active' : ''}`}
        title="Bật/tắt thang đo logarit (Logarithmic scale)"
        aria-pressed={logScale}
        onClick={toggleLog}
      >
        log
      </button>
    </div>
  );
}
