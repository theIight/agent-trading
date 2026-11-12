import type {
  AutoscaleInfo,
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
import { EMPTY_MODEL, layoutLabels, type LabelBox, type OverlayModel } from './model.ts';

type TimeMapper = (time: number) => number | null;

interface Ctx {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  model: OverlayModel;
  mapTime: TimeMapper;
  textColor: string;
}

function xOf(ctx: Ctx, time: number): number | null {
  const logical = ctx.mapTime(time);
  if (logical === null) return null;
  // lightweight-charts (5.2) trả 0 cho logical không nguyên → nội suy giữa 2 chỉ số nguyên liền kề.
  const ts = ctx.chart.timeScale();
  const lo = Math.floor(logical);
  const xLo = ts.logicalToCoordinate(lo as Logical);
  if (xLo === null || logical === lo) return xLo;
  const xHi = ts.logicalToCoordinate((lo + 1) as Logical);
  return xHi === null ? xLo : xLo + (xHi - xLo) * (logical - lo);
}

function yOf(ctx: Ctx, price: number): number | null {
  return ctx.series.priceToCoordinate(price);
}

const FONT = '11px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
const OF_FONT = '10px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
/** Khoảng cách dọc tối thiểu giữa 2 nhãn order flow (px). */
const OF_LABEL_GAP = 11;

function drawLabel(c: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, align: CanvasTextAlign = 'left') {
  c.font = FONT;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillStyle = color;
  c.fillText(text, x, y);
}

class BackgroundRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly ctx: Ctx) {}
  draw(): void {}
  drawBackground(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: c, mediaSize }) => {
      for (const b of this.ctx.model.bands) {
        const x1 = xOf(this.ctx, b.t1);
        const x2 = xOf(this.ctx, b.t2);
        if (x1 === null || x2 === null) continue;
        c.fillStyle = b.fill;
        c.fillRect(x1, 0, x2 - x1, mediaSize.height);
        c.strokeStyle = 'rgba(128,128,128,0.25)';
        c.setLineDash([2, 3]);
        c.beginPath();
        c.moveTo(x1, 0);
        c.lineTo(x1, mediaSize.height);
        c.stroke();
        c.setLineDash([]);
        // Đặt nhãn ngay trên vùng volume (volume chiếm ~18% dưới cùng).
        if (x2 - x1 > 40) drawLabel(c, b.label, (x1 + x2) / 2, mediaSize.height * 0.8 - 8, this.ctx.textColor, 'center');
      }
      // Order flow: dải mờ sau nến (dày theo khối lượng), nhãn số nhỏ sát mép phải, không có nhãn trên trục giá.
      c.font = OF_FONT;
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      const ofLabels: { y: number; text: string; color: string }[] = [];
      for (const of of this.ctx.model.orderflowLines) {
        const y = yOf(this.ctx, of.price);
        if (y === null) continue;
        if (of.dashed) {
          const py = Math.round(y) + 0.5;
          c.setLineDash([2, 3]);
          c.lineWidth = 1;
          c.strokeStyle = of.color;
          c.beginPath();
          c.moveTo(0, py);
          c.lineTo(mediaSize.width, py);
          c.stroke();
          c.setLineDash([]);
          ofLabels.push({ y: py, text: of.label, color: of.textColor });
        } else {
          // Tường: dải liền dày theo khối lượng, tâm tại mức giá.
          c.fillStyle = of.color;
          c.fillRect(0, y - of.width / 2, mediaSize.width, of.width);
          ofLabels.push({ y, text: of.label, color: of.textColor });
        }
      }
      // Vạch sát nhau → giãn nhãn dọc để không đè (nhãn dưới cùng giữ giữa vạch).
      ofLabels.sort((p, q) => q.y - p.y);
      for (let i = 1; i < ofLabels.length; i++) ofLabels[i]!.y = Math.min(ofLabels[i]!.y, ofLabels[i - 1]!.y - OF_LABEL_GAP);
      for (const l of ofLabels) {
        c.fillStyle = l.color;
        c.fillText(l.text, mediaSize.width - 4, l.y);
      }
    });
  }
}

class ForegroundRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly ctx: Ctx) {}
  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: c, mediaSize }) => {
      // Nhãn vẽ sau cùng, đã giãn để không đè nhau.
      c.font = FONT;
      const labels: (LabelBox & { text: string; color: string })[] = [];
      const addLabel = (text: string, x: number, y: number, color: string, align: 'left' | 'right') => {
        const width = c.measureText(text).width;
        // Giữ nhãn trong vùng nhìn thấy (hộp kéo dài ra ngoài mép phải).
        const maxX = align === 'left' ? mediaSize.width - width - 4 : mediaSize.width - 4;
        labels.push({ text, x: Math.min(x, Math.max(maxX, align === 'left' ? 4 : width + 4)), y, color, align, width });
      };
      for (const r of this.ctx.model.rects) {
        const x1 = xOf(this.ctx, r.t1);
        const x2 = xOf(this.ctx, r.t2);
        const yTop = yOf(this.ctx, r.top);
        const yBot = yOf(this.ctx, r.bottom);
        if (x1 === null || x2 === null || yTop === null || yBot === null) continue;
        c.fillStyle = r.fill;
        c.fillRect(x1, yTop, x2 - x1, yBot - yTop);
        if (r.stroke) {
          c.strokeStyle = r.stroke;
          c.lineWidth = 1;
          c.setLineDash(r.dashed ? [5, 4] : []);
          c.strokeRect(x1 + 0.5, yTop + 0.5, x2 - x1, yBot - yTop);
          c.setLineDash([]);
        }
        if (r.label) {
          const at = r.labelAt ?? 'top-left';
          const lx = at.endsWith('left') ? Math.max(x1, 0) + 6 : Math.min(x2, mediaSize.width) - 6;
          const ly = at.startsWith('top') ? yTop + 9 : yBot - 9;
          addLabel(r.label, lx, ly, r.labelColor ?? this.ctx.textColor, at.endsWith('left') ? 'left' : 'right');
        }
      }

      for (const line of this.ctx.model.lines) {
        const pts = line.points
          .map(p => ({ x: xOf(this.ctx, p.time), y: yOf(this.ctx, p.price) }))
          .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
        if (pts.length < 2) continue;
        c.strokeStyle = line.color;
        c.lineWidth = line.width;
        c.setLineDash(line.dashed ? [6, 4] : []);
        c.beginPath();
        pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
        c.stroke();
        c.setLineDash([]);
        const end = pts[pts.length - 1]!;
        if (line.points.length > 2) {
          c.fillStyle = line.color;
          for (const p of pts.slice(1)) {
            c.beginPath();
            c.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
            c.fill();
          }
        }
        if (line.label) {
          c.font = FONT;
          const w = c.measureText(line.label).width;
          // Gần mép phải → đặt nhãn phía trên, căn phải tại điểm cuối để không bị cắt.
          if (end.x + 6 + w > mediaSize.width) addLabel(line.label, Math.min(end.x, mediaSize.width) - 4, end.y - 9, line.color, 'right');
          else addLabel(line.label, end.x + 6, end.y, line.color, 'left');
        }
      }

      const ys = layoutLabels(labels);
      labels.forEach((l, i) => drawLabel(c, l.text, l.x, ys[i]!, l.color, l.align));
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

/**
 * Primitive vẽ các overlay không có sẵn trong lightweight-charts: phase band,
 * trading range, công cụ Long/Short, đường kịch bản dự đoán.
 */
export class OverlayPrimitive implements ISeriesPrimitive<Time> {
  private ctx: Ctx | null = null;
  private model: OverlayModel = EMPTY_MODEL;
  private mapTime: TimeMapper = () => null;
  private textColor = '#d1d4dc';
  private requestUpdate: (() => void) | null = null;
  private views: IPrimitivePaneView[] = [];

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
    this.ctx = { chart: param.chart, series: param.series, model: this.model, mapTime: this.mapTime, textColor: this.textColor };
    this.views = [new View(new BackgroundRenderer(this.ctx), 'bottom'), new View(new ForegroundRenderer(this.ctx), 'normal')];
  }

  detached(): void {
    this.ctx = null;
    this.views = [];
    this.requestUpdate = null;
  }

  setData(model: OverlayModel, mapTime: TimeMapper, textColor: string): void {
    this.model = model;
    this.mapTime = mapTime;
    this.textColor = textColor;
    if (this.ctx) Object.assign(this.ctx, { model, mapTime, textColor });
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Mở rộng thang giá để thấy TP/SL và đường dự đoán nằm trong vùng đang xem. */
  autoscaleInfo(start: Logical, end: Logical): AutoscaleInfo | null {
    let min = Infinity;
    let max = -Infinity;
    const inView = (t: number) => {
      const l = this.mapTime(t);
      return l !== null && l >= start - 1 && l <= end + 1;
    };
    for (const r of this.model.rects) {
      if (r.noAutoscale) continue; // trading range không ép thang giá
      if (inView(r.t1) || inView(r.t2)) {
        min = Math.min(min, r.bottom);
        max = Math.max(max, r.top);
      }
    }
    for (const line of this.model.lines) {
      for (const p of line.points) {
        if (inView(p.time)) {
          min = Math.min(min, p.price);
          max = Math.max(max, p.price);
        }
      }
    }
    return Number.isFinite(min) ? { priceRange: { minValue: min, maxValue: max } } : null;
  }
}
