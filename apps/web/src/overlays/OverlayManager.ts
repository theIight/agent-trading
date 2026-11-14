import { LineStyle, createSeriesMarkers, type IPriceLine, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import { tfSeconds, type AnalysisResult, type BookHeatmap, type LiveLiquidations } from '@wca/shared';
import type { ChartController } from '../chart/ChartController.ts';
import { THEMES, type ThemeName } from '../chart/theme.ts';
import { ALL_LAYERS_ON, buildOverlayModel, makeTimeMapper, webRightOffset, type LayerVisibility, type LiveOrderflowView, type OverlayModel } from './model.ts';
import { snapshotRange, toolStartIndex } from '../snapshotMode.ts';
import { OverlayPrimitive } from './OverlayPrimitive.ts';
import { LiquidationPrimitive } from './LiquidationPrimitive.ts';
import { BookHeatmapPrimitive } from './BookHeatmapPrimitive.ts';

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

/** Gắn kết quả phân tích lên chart: markers, price lines và OverlayPrimitive. */
export class OverlayManager {
  private analysis: AnalysisResult | null = null;
  private layers: LayerVisibility = { ...ALL_LAYERS_ON };
  private theme: ThemeName = 'dark';
  private readonly primitive = new OverlayPrimitive();
  private readonly liqPrimitive = new LiquidationPrimitive();
  private readonly bookHeatPrimitive = new BookHeatmapPrimitive();
  private bookHeatmap: { data: BookHeatmap; show: boolean } | null = null;
  private liquidation: LiquidationView | null = null;
  private readonly markers: ISeriesMarkersPluginApi<Time>;
  private priceLines: IPriceLine[] = [];
  private model: OverlayModel | null = null;
  private setupView: SetupView = { selectedSetup: null, showReferenceSetups: false };
  private liveOrderflow: (LiveOrderflowView & { symbol: string }) | null = null;

  /** `snapshot`: bố cục cố định cho ảnh chụp (nến 60% trái, position tool 50% phải), không tự tính rightOffset. */
  constructor(
    private readonly ctrl: ChartController,
    private readonly opts: { snapshot?: boolean } = {},
  ) {
    ctrl.candleSeries.attachPrimitive(this.bookHeatPrimitive);
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

  /** Heatmap sổ lệnh của symbol đang xem; null = không có. */
  setBookHeatmap(view: { data: BookHeatmap; show: boolean } | null): void {
    this.bookHeatmap = view;
    this.renderBookHeatmap();
  }

  private renderBookHeatmap(): void {
    const v = this.bookHeatmap?.data.symbol === this.ctrl.getSymbol() ? this.bookHeatmap : null;
    this.bookHeatPrimitive.setData({
      heatmap: v?.data ?? null,
      show: Boolean(v?.show),
      mapTime: makeTimeMapper(this.ctrl.getCandles(), this.ctrl.getTimeframe()),
    });
  }

  private renderLiquidation(): void {
    const v = this.liquidation?.data.symbol === this.ctrl.getSymbol() ? this.liquidation : null;
    this.liqPrimitive.setData({
      heatmap: v?.data.heatmap ?? null,
      events: v?.data.events ?? [],
      showHeatmap: Boolean(v?.showHeatmap),
      showBubbles: Boolean(v?.showBubbles),
      minQty: v?.data.minQty,
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
    const snap = this.opts.snapshot && candles.length ? this.snapshotLayout() : null;
    const model = buildOverlayModel(analysis, candles, tf, {
      layers: this.layers,
      ...this.setupView,
      liveOrderflow: live,
      ...(snap ? { toolStartTime: snap.toolStartTime, toolEndTime: snap.toolEndTime } : {}),
    });
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
    this.renderBookHeatmap();
    if (snap) {
      this.applySnapshotRange();
    } else {
      const range = this.ctrl.chart.timeScale().getVisibleLogicalRange();
      const visibleBars = range ? range.to - range.from : 150;
      this.ctrl.chart.timeScale().applyOptions({ rightOffset: webRightOffset(model.futureBars, visibleBars) });
    }
  }

  /** Mốc thời gian position tool trong ảnh chụp: từ mốc 50% tới mép phải khung nhìn. */
  private snapshotLayout(): { toolStartTime: number; toolEndTime: number } {
    const candles = this.ctrl.getCandles();
    const step = tfSeconds(this.ctrl.getTimeframe());
    const lastIndex = candles.length - 1;
    const last = candles[lastIndex]!;
    const range = snapshotRange(lastIndex);
    const startIdx = toolStartIndex(range);
    const toolStartTime = startIdx <= lastIndex ? candles[startIdx]!.time : last.time + (startIdx - lastIndex) * step;
    return { toolStartTime, toolEndTime: last.time + Math.ceil(range.to - lastIndex) * step };
  }

  /** Ảnh chụp: đặt khung nhìn cố định (120 nến cuối ở 60% bên trái). Gọi lại sau khi chart tự cuộn về nến cuối. */
  applySnapshotRange(): void {
    const n = this.ctrl.getCandles().length;
    if (!this.opts.snapshot || !n) return;
    this.ctrl.chart.timeScale().setVisibleLogicalRange(snapshotRange(n - 1));
  }

  destroy(): void {
    this.markers.detach();
    this.ctrl.candleSeries.detachPrimitive(this.primitive);
    this.ctrl.candleSeries.detachPrimitive(this.liqPrimitive);
    this.ctrl.candleSeries.detachPrimitive(this.bookHeatPrimitive);
  }
}
