import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { BookHeatmap } from '@wca/shared';
import {
  bookHeatColor,
  heatBands,
  heatScale,
  heatStats,
  intensityOf,
  pickHeatLabels,
  type HeatBand,
  type HeatScale,
  type HeatView,
} from './bookHeatmapModel.ts';
import { timeToX, type TimeMapper } from './LiquidationPrimitive.ts';
import { isLightText } from './OverlayPrimitive.ts';
import { fmtSize } from './model.ts';
import { bookHeatMinQtyOf, display, font } from '../chart/displaySettings.ts';
import { useBookHeatmapStore } from '../store/useBookHeatmapStore.ts';

// Heatmap sổ lệnh: khối lượng lệnh chờ trung bình theo bucket × cột, vẽ sau nến.

interface BookHeatData {
  heatmap: BookHeatmap | null;
  show: boolean;
  mapTime: TimeMapper;
}

interface Ctx {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  data: BookHeatData;
  /** Kết quả lần vẽ nền gần nhất, lớp nhãn (trên nến) dùng lại. */
  frame: Frame | null;
}

interface Frame {
  h: BookHeatmap;
  xs: (readonly [number | null, number | null])[];
  view: HeatView;
  scale: HeatScale;
  /** Khoá thang màu (đổi khi đổi ngưỡng / vùng nhìn). */
  key: string;
}

/** Nhãn chữ không lấy màu tối hơn mức này của thang (xanh đậm khó đọc trên nền tối). */
const LABEL_MIN_INTENSITY = 110;
/** Dải ngắn hơn 5 phút không ghi nhãn. */
const BAND_MIN_SEC = 300;

const palettes = new Map<number, string[]>();
function palette(opacity: number): string[] {
  let p = palettes.get(opacity);
  if (!p) {
    p = Array.from({ length: 256 }, (_, i) => bookHeatColor(i, opacity));
    palettes.set(opacity, p);
  }
  return p;
}

class Renderer implements IPrimitivePaneRenderer {
  /** Thang màu cache theo (bản dữ liệu, ngưỡng ẩn, ngưỡng khối lượng, vùng nhìn thấy). */
  private scaleKey: { h: BookHeatmap; key: string } | null = null;
  /** Thống kê gợi ý cache theo (bản dữ liệu, vùng nhìn thấy) — không phụ thuộc ngưỡng. */
  private statsKey: { h: BookHeatmap; key: string } | null = null;
  private scale: HeatScale = { steps: [], min: 0 };
  constructor(private readonly ctx: Ctx) {}
  draw(): void {}
  drawBackground(target: CanvasRenderingTarget2D): void {
    const { data, series, chart } = this.ctx;
    const h = data.heatmap;
    this.ctx.frame = null;
    if (!data.show || !h || !h.cols.length) return;
    const s = display();
    const colors = palette(s.bookHeatOpacity);
    target.useMediaCoordinateSpace(({ context: c, mediaSize }) => {
      const xs = h.cols.map(t => [timeToX(chart, data.mapTime, t), timeToX(chart, data.mapTime, t + h.colSec)] as const);
      const vis = xs.map(([a, b], i) => (a !== null && b !== null && b >= 0 && a <= mediaSize.width ? i : -1)).filter(i => i >= 0);
      const top = series.coordinateToPrice(0);
      const bottom = series.coordinateToPrice(mediaSize.height);
      if (!vis.length || top === null || bottom === null) return;
      const view = { c0: vis[0]!, c1: vis.at(-1)!, low: Math.min(top, bottom), high: Math.max(top, bottom) };
      // Thang theo vùng nhìn thấy; key làm tròn để kéo/zoom nhẹ không tính lại liên tục.
      const span = view.high - view.low;
      const r = (x: number) => Math.round(x / (span / 20 || 1));
      const viewKey = `${view.c0}:${view.c1}:${r(view.low)}:${r(view.high)}`;
      const minQty = bookHeatMinQtyOf(s, h.symbol);
      const key = `${s.bookHeatHidePct}:${minQty}:${viewKey}`;
      if (!this.scaleKey || this.scaleKey.h !== h || this.scaleKey.key !== key) {
        this.scale = heatScale(h, s.bookHeatHidePct, view, minQty);
        this.scaleKey = { h, key };
      }
      if (!this.statsKey || this.statsKey.h !== h || this.statsKey.key !== viewKey) {
        this.statsKey = { h, key: viewKey };
        const st = heatStats(h, view);
        // Ngoài vòng vẽ: cập nhật store làm React render lại bảng ⚙.
        queueMicrotask(() => useBookHeatmapStore.getState().setViewStats(st && { ...st, symbol: h.symbol }));
      }
      const scale = this.scale;
      const min = scale.min;
      this.ctx.frame = { h, xs, view, scale, key };
      for (const ci of vis) {
        const [x1, x2] = xs[ci] as [number, number];
        const w = Math.max(1, x2 - x1);
        const shift = h.shift[ci] ?? 0;
        const flat = h.data[ci] ?? [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const q = flat[i + 1]!;
          if (q < min) continue;
          const low = flat[i]! * h.bucket - shift;
          const yLow = series.priceToCoordinate(low);
          const yHigh = series.priceToCoordinate(low + h.bucket);
          if (yLow === null || yHigh === null || yLow < 0 || yHigh > mediaSize.height) continue;
          c.fillStyle = colors[intensityOf(q, scale)]!;
          c.fillRect(x1, yHigh, w, Math.max(1, yLow - yHigh));
        }
      }
    });
  }
}

/** Nhãn khối lượng đỉnh tại điểm bắt đầu mỗi dải thanh khoản (cỡ chữ = nhãn order flow), vẽ trên nến. */
class LabelRenderer implements IPrimitivePaneRenderer {
  private bandsKey: { h: BookHeatmap; key: string } | null = null;
  private bands: HeatBand[] = [];
  constructor(private readonly ctx: Ctx) {}
  draw(target: CanvasRenderingTarget2D): void {
    const { frame, series, chart } = this.ctx;
    const s = display();
    const n = s.bookHeatLabels;
    if (!frame || n <= 0) return;
    const { h, xs, view, scale, key } = frame;
    if (!this.bandsKey || this.bandsKey.h !== h || this.bandsKey.key !== key) {
      this.bands = heatBands(h, view, scale.min, Math.max(1, Math.ceil(BAND_MIN_SEC / h.colSec)));
      this.bandsKey = { h, key };
    }
    if (!this.bands.length) return;
    const textColor = chart.options().layout.textColor;
    const dark = isLightText(textColor);
    const colors = palette(100);
    target.useMediaCoordinateSpace(({ context: c, mediaSize }) => {
      c.font = font(s.ofFontPx);
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      const items: { x: number; y: number; w: number; h: number; text: string; band: HeatBand }[] = [];
      // Giới hạn số dải đo chữ (đã sắp theo đỉnh giảm dần).
      for (const band of this.bands.slice(0, n * 6)) {
        const col = Math.max(band.start, view.c0);
        const x0 = xs[col]?.[0];
        const y = series.priceToCoordinate(band.price);
        if (x0 == null || y === null || y < 0 || y > mediaSize.height) continue;
        const x = Math.max(4, x0 + 3);
        if (x > mediaSize.width) continue;
        const text = fmtSize(band.peak);
        items.push({ x, y, w: c.measureText(text).width, h: s.ofFontPx + 1, text, band });
      }
      c.lineJoin = 'round';
      c.lineWidth = 3;
      c.strokeStyle = dark ? 'rgba(10,12,18,0.85)' : 'rgba(255,255,255,0.85)';
      for (const i of pickHeatLabels(items, n)) {
        const it = items[i]!;
        c.strokeText(it.text, it.x, it.y);
        c.fillStyle = dark ? colors[Math.max(LABEL_MIN_INTENSITY, intensityOf(it.band.peak, scale))]! : textColor;
        c.fillText(it.text, it.x, it.y);
      }
    });
  }
}

class View implements IPrimitivePaneView {
  constructor(
    private readonly renderer_: IPrimitivePaneRenderer,
    private readonly z: PrimitivePaneViewZOrder = 'bottom',
  ) {}
  zOrder(): PrimitivePaneViewZOrder {
    return this.z;
  }
  renderer(): IPrimitivePaneRenderer {
    return this.renderer_;
  }
}

export class BookHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private ctx: Ctx | null = null;
  private data: BookHeatData = { heatmap: null, show: false, mapTime: () => null };
  private requestUpdate: (() => void) | null = null;
  private views: IPrimitivePaneView[] = [];

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
    this.ctx = { chart: param.chart, series: param.series, data: this.data, frame: null };
    this.views = [new View(new Renderer(this.ctx)), new View(new LabelRenderer(this.ctx), 'top')];
  }

  detached(): void {
    this.ctx = null;
    this.views = [];
    this.requestUpdate = null;
  }

  setData(data: BookHeatData): void {
    this.data = data;
    if (this.ctx) this.ctx.data = data;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}
