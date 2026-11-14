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
import { bookHeatColor, heatScale, intensityOf, type HeatScale } from './bookHeatmapModel.ts';
import { timeToX, type TimeMapper } from './LiquidationPrimitive.ts';
import { display } from '../chart/displaySettings.ts';

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
}

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
  /** Thang màu cache theo (bản dữ liệu, ngưỡng ẩn, vùng nhìn thấy). */
  private scaleKey: { h: BookHeatmap; key: string } | null = null;
  private scale: HeatScale = { steps: [], min: 0 };
  constructor(private readonly ctx: Ctx) {}
  draw(): void {}
  drawBackground(target: CanvasRenderingTarget2D): void {
    const { data, series, chart } = this.ctx;
    const h = data.heatmap;
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
      const key = `${s.bookHeatHidePct}:${view.c0}:${view.c1}:${r(view.low)}:${r(view.high)}`;
      if (!this.scaleKey || this.scaleKey.h !== h || this.scaleKey.key !== key) {
        this.scale = heatScale(h, s.bookHeatHidePct, view);
        this.scaleKey = { h, key };
      }
      const scale = this.scale;
      const min = scale.min;
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

class View implements IPrimitivePaneView {
  constructor(private readonly renderer_: IPrimitivePaneRenderer) {}
  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom';
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
    this.ctx = { chart: param.chart, series: param.series, data: this.data };
    this.views = [new View(new Renderer(this.ctx))];
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
