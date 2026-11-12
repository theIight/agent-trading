import { LineStyle, createSeriesMarkers, type IPriceLine, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { AnalysisResult, LiveLiquidations } from '@wca/shared';
import type { ChartController } from '../chart/ChartController.ts';
import { THEMES, type ThemeName } from '../chart/theme.ts';
import { ALL_LAYERS_ON, buildOverlayModel, makeTimeMapper, type LayerVisibility, type LiveOrderflowView, type OverlayModel } from './model.ts';
import { OverlayPrimitive } from './OverlayPrimitive.ts';
import { LiquidationPrimitive } from './LiquidationPrimitive.ts';

export interface LiquidationView {
  data: LiveLiquidations;
  showHeatmap: boolean;
  showBubbles: boolean;
}

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
  private readonly liqPrimitive = new LiquidationPrimitive();
  private liquidation: LiquidationView | null = null;
  private readonly markers: ISeriesMarkersPluginApi<Time>;
  private priceLines: IPriceLine[] = [];
  private model: OverlayModel | null = null;
  private setupView: SetupView = { selectedSetup: null, showReferenceSetups: false };
  private liveOrderflow: (LiveOrderflowView & { symbol: string }) | null = null;

  constructor(private readonly ctrl: ChartController) {
    ctrl.candleSeries.attachPrimitive(this.liqPrimitive);
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

  /** Order flow hiện tại (live) theo symbol; null = không có. */
  setLiveOrderflow(live: (LiveOrderflowView & { symbol: string }) | null): void {
    this.liveOrderflow = live;
    this.render();
  }

  /** Thanh lý (bong bóng + heatmap) của symbol đang xem; null = không có. */
  setLiquidation(view: LiquidationView | null): void {
    this.liquidation = view;
    this.renderLiquidation();
  }

  private renderLiquidation(): void {
    const v = this.liquidation?.data.symbol === this.ctrl.getSymbol() ? this.liquidation : null;
    this.liqPrimitive.setData({
      heatmap: v?.data.heatmap ?? null,
      events: v?.data.events ?? [],
      showHeatmap: Boolean(v?.showHeatmap),
      showBubbles: Boolean(v?.showBubbles),
      mapTime: makeTimeMapper(this.ctrl.getCandles(), this.ctrl.getTimeframe()),
    });
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
    const live = this.liveOrderflow?.symbol === this.ctrl.getSymbol() ? this.liveOrderflow : null;
    const model = buildOverlayModel(analysis, candles, tf, { layers: this.layers, ...this.setupView, liveOrderflow: live });
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
        lineWidth: 1,
        lineStyle: LINE_STYLE[pl.style],
        axisLabelVisible: true,
        title: pl.title,
      }),
    );

    this.primitive.setData(model, makeTimeMapper(candles, tf), THEMES[this.theme].text);
    this.renderLiquidation();
    this.ctrl.chart.timeScale().applyOptions({ rightOffset: Math.max(BASE_RIGHT_OFFSET, model.futureBars + 6) });
  }

  destroy(): void {
    this.markers.detach();
    this.ctrl.candleSeries.detachPrimitive(this.primitive);
    this.ctrl.candleSeries.detachPrimitive(this.liqPrimitive);
  }
}
