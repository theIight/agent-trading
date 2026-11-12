import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time } from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

// Dấu đột biến volume (S / P / S+P) trên đỉnh cột volume gộp: chữ nhỏ (series markers không cho chỉnh cỡ chữ).

export interface SpikeLabel {
  time: number;
  /** Giá trị đỉnh cột (thang volume). */
  value: number;
  text: string;
  color: string;
}

/** Cỡ chữ nhãn đột biến (px). */
export const SPIKE_FONT_PX = 9;
const DOT_R = 2;

class Renderer implements IPrimitivePaneRenderer {
  constructor(private readonly owner: SpikeLabelPrimitive) {}
  draw(target: CanvasRenderingTarget2D): void {
    const p = this.owner.param;
    const labels = this.owner.labels;
    if (!p || !labels.length) return;
    const ts = p.chart.timeScale();
    target.useMediaCoordinateSpace(({ context: c }) => {
      c.font = `${SPIKE_FONT_PX}px -apple-system, BlinkMacSystemFont, Roboto, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'bottom';
      for (const l of labels) {
        const x = ts.timeToCoordinate(l.time as Time);
        const y = p.series.priceToCoordinate(l.value);
        if (x === null || y === null) continue;
        c.fillStyle = l.color;
        c.beginPath();
        c.arc(x, y - DOT_R - 2, DOT_R, 0, Math.PI * 2);
        c.fill();
        c.fillText(l.text, x, y - 2 * DOT_R - 4);
      }
    });
  }
}

class View implements IPrimitivePaneView {
  constructor(private readonly r: Renderer) {}
  renderer(): IPrimitivePaneRenderer {
    return this.r;
  }
}

export class SpikeLabelPrimitive implements ISeriesPrimitive<Time> {
  param: SeriesAttachedParameter<Time> | null = null;
  labels: SpikeLabel[] = [];
  private readonly views = [new View(new Renderer(this))];

  attached(param: SeriesAttachedParameter<Time>): void {
    this.param = param;
  }

  detached(): void {
    this.param = null;
  }

  setLabels(labels: SpikeLabel[]): void {
    this.labels = labels;
    this.param?.requestUpdate();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}
