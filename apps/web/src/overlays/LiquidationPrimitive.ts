import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { LiquidationEvent, LiquidationHeatmap } from '@wca/shared';
import { bubbleColor, bubbleRadius, heatColor } from './liquidationModel.ts';

// Lớp thanh lý: heatmap mức thanh lý ước tính (sau nến) + bong bóng thanh lý thật (trên nến).

type TimeMapper = (time: number) => number | null;

interface LiqData {
  heatmap: LiquidationHeatmap | null;
  events: LiquidationEvent[];
  showHeatmap: boolean;
  showBubbles: boolean;
  mapTime: TimeMapper;
}

interface Ctx {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  data: LiqData;
  /** Màu theo cường độ 0–255 (tính sẵn). */
  palette: string[];
}

function xOf(ctx: Ctx, time: number): number | null {
  const logical = ctx.data.mapTime(time);
  if (logical === null) return null;
  const ts = ctx.chart.timeScale();
  const lo = Math.floor(logical);
  const xLo = ts.logicalToCoordinate(lo as Logical);
  if (xLo === null || logical === lo) return xLo;
  const xHi = ts.logicalToCoordinate((lo + 1) as Logical);
  return xHi === null ? xLo : xLo + (xHi - xLo) * (logical - lo);
}

class HeatmapRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly ctx: Ctx) {}
  draw(): void {}
  drawBackground(target: CanvasRenderingTarget2D): void {
    const { data, series, palette } = this.ctx;
    const h = data.heatmap;
    if (!data.showHeatmap || !h || !h.cols.length) return;
    target.useMediaCoordinateSpace(({ context: c, mediaSize }) => {
      // y theo chỉ số giá: tính một lần cho mọi cột.
      const yCache = new Map<number, number | null>();
      const yAt = (ix: number) => {
        let y = yCache.get(ix);
        if (y === undefined) {
          y = series.priceToCoordinate(h.priceMin + ix * h.bucket);
          yCache.set(ix, y);
        }
        return y;
      };
      for (let ci = 0; ci < h.cols.length; ci++) {
        const x1 = xOf(this.ctx, h.cols[ci]!);
        const x2 = xOf(this.ctx, h.cols[ci]! + h.colSec);
        if (x1 === null || x2 === null || x2 < 0 || x1 > mediaSize.width) continue;
        const w = Math.max(1, x2 - x1);
        const flat = h.data[ci] ?? [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const ix = flat[i]!;
          const yLow = yAt(ix);
          const yHigh = yAt(ix + 1);
          if (yLow === null || yHigh === null || yLow < 0 || yHigh > mediaSize.height) continue;
          c.fillStyle = palette[flat[i + 1]!]!;
          c.fillRect(x1, yHigh, w, Math.max(1, yLow - yHigh));
        }
      }
    });
  }
}

class BubbleRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly ctx: Ctx) {}
  draw(target: CanvasRenderingTarget2D): void {
    const { data, series } = this.ctx;
    if (!data.showBubbles || !data.events.length) return;
    const maxQty = Math.max(...data.events.map(e => e.qty));
    target.useMediaCoordinateSpace(({ context: c }) => {
      for (const e of data.events) {
        const x = xOf(this.ctx, e.t);
        const y = series.priceToCoordinate(e.price);
        if (x === null || y === null) continue;
        const r = bubbleRadius(e.qty, maxQty);
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fillStyle = bubbleColor(e.side, 0.45);
        c.fill();
        c.lineWidth = 1;
        c.strokeStyle = bubbleColor(e.side, 0.9);
        c.stroke();
      }
    });
  }
}

class View implements IPrimitivePaneView {
  constructor(
    private readonly renderer_: IPrimitivePaneRenderer,
    private readonly z: PrimitivePaneViewZOrder,
  ) {}
  zOrder(): PrimitivePaneViewZOrder {
    return this.z;
  }
  renderer(): IPrimitivePaneRenderer {
    return this.renderer_;
  }
}

const PALETTE = Array.from({ length: 256 }, (_, i) => heatColor(i));

export class LiquidationPrimitive implements ISeriesPrimitive<Time> {
  private ctx: Ctx | null = null;
  private data: LiqData = { heatmap: null, events: [], showHeatmap: false, showBubbles: false, mapTime: () => null };
  private requestUpdate: (() => void) | null = null;
  private views: IPrimitivePaneView[] = [];

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
    this.ctx = { chart: param.chart, series: param.series, data: this.data, palette: PALETTE };
    this.views = [new View(new HeatmapRenderer(this.ctx), 'bottom'), new View(new BubbleRenderer(this.ctx), 'top')];
  }

  detached(): void {
    this.ctx = null;
    this.views = [];
    this.requestUpdate = null;
  }

  setData(data: LiqData): void {
    this.data = data;
    if (this.ctx) this.ctx.data = data;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}
