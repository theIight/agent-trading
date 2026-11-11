import { LineStyle, createSeriesMarkers, type IPriceLine, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { AnalysisResult } from '@wca/shared';
import type { ChartController } from '../chart/ChartController.ts';
import { THEMES, type ThemeName } from '../chart/theme.ts';
import { ALL_LAYERS_ON, buildOverlayModel, makeTimeMapper, type LayerVisibility, type OverlayModel } from './model.ts';
import { OverlayPrimitive } from './OverlayPrimitive.ts';

export interface SetupView {
  selectedSetup: number | null;
  showReferenceSetups: boolean;
}

const LINE_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const;
const BASE_RIGHT_OFFSET = 12;

/** Gắn kết quả phân tích lên chart: markers, price lines và OverlayPrimitive. */
export class OverlayManager {
  private analysis: AnalysisResult | null = null;
  private layers: LayerVisibility = { ...ALL_LAYERS_ON };
  private theme: ThemeName = 'dark';
  private readonly primitive = new OverlayPrimitive();
  private readonly markers: ISeriesMarkersPluginApi<Time>;
  private priceLines: IPriceLine[] = [];
  private model: OverlayModel | null = null;
  private setupView: SetupView = { selectedSetup: null, showReferenceSetups: false };

  constructor(private readonly ctrl: ChartController) {
    ctrl.candleSeries.attachPrimitive(this.primitive);
    this.markers = createSeriesMarkers(ctrl.candleSeries, []);
  }

  getModel(): OverlayModel | null {
    return this.model;
  }

  setAnalysis(analysis: AnalysisResult | null): void {
    this.analysis = analysis;
    this.render();
  }

  setLayers(layers: LayerVisibility): void {
    this.layers = layers;
    this.render();
  }

  setSetupView(view: SetupView): void {
    this.setupView = view;
    this.render();
  }

  setTheme(theme: ThemeName): void {
    this.theme = theme;
    this.render();
  }

  /** Gọi khi dữ liệu nến hoặc khung thay đổi. */
  render(): void {
    const candles = this.ctrl.getCandles();
    const tf = this.ctrl.getTimeframe();
    // Chỉ vẽ phân tích của đúng symbol đang xem: hình vẽ của symbol cũ (vd BTC 70k)
    // vừa sai ngữ cảnh vừa kéo thang giá khiến không thấy nến symbol mới (vd NEAR 3.5).
    const analysis = this.analysis && this.analysis.symbol === this.ctrl.getSymbol() ? this.analysis : null;
    const model = buildOverlayModel(analysis, candles, tf, { layers: this.layers, ...this.setupView });
    this.model = model;

    this.markers.setMarkers(
      model.markers.map(m => ({
        time: m.time as UTCTimestamp,
        position: m.position,
        shape: m.shape,
        color: m.color,
        text: m.text,
        id: String(m.eventIndex),
      })),
    );

    for (const pl of this.priceLines) this.ctrl.candleSeries.removePriceLine(pl);
    this.priceLines = model.priceLines.map(pl =>
      this.ctrl.candleSeries.createPriceLine({
        price: pl.price,
        color: pl.color,
        lineWidth: pl.width ?? 1,
        lineStyle: LINE_STYLE[pl.style],
        axisLabelVisible: true,
        title: pl.title,
      }),
    );

    this.primitive.setData(model, makeTimeMapper(candles, tf), THEMES[this.theme].text);
    this.ctrl.chart.timeScale().applyOptions({ rightOffset: Math.max(BASE_RIGHT_OFFSET, model.futureBars + 6) });
  }

  destroy(): void {
    this.markers.detach();
    this.ctrl.candleSeries.detachPrimitive(this.primitive);
  }
}
