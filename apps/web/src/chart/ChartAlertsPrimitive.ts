import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { ChartAlert } from '@wca/shared';
import { hexToRgba } from './sound.ts';

interface AlertRenderItem {
  color: string;
  opacity: number;
  y: number;
}

class AlertAxisRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly items: AlertRenderItem[]) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      for (const item of this.items) {
        if (item.y < 0 || item.y > mediaSize.height) continue;
        ctx.fillStyle = hexToRgba(item.color, Math.max(0.7, item.opacity));
        ctx.fillText('>', 2, item.y);
      }

      ctx.restore();
    });
  }
}

class AlertAxisPaneView implements IPrimitivePaneView {
  constructor(private readonly getItems: () => AlertRenderItem[]) {}

  zOrder(): 'top' {
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer | null {
    const items = this.getItems();
    if (items.length === 0) return null;
    return new AlertAxisRenderer(items);
  }
}

export class ChartAlertsPrimitive implements ISeriesPrimitive<Time> {
  private param: SeriesAttachedParameter<Time> | null = null;
  private alerts: ChartAlert[] = [];
  private paneViewsList: readonly IPrimitivePaneView[] = [];

  constructor() {
    this.paneViewsList = [
      new AlertAxisPaneView(() => this.getVisibleItems()),
    ];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.param = param;
    this.param.requestUpdate();
  }

  detached(): void {
    this.param = null;
  }

  setAlerts(alerts: ChartAlert[]): void {
    this.alerts = alerts;
    this.param?.requestUpdate();
  }

  private getVisibleItems(): AlertRenderItem[] {
    if (!this.param) return [];
    const items: AlertRenderItem[] = [];
    for (const a of this.alerts) {
      const y = this.param.series.priceToCoordinate(a.price);
      if (y !== null) {
        items.push({ color: a.color, opacity: a.opacity, y });
      }
    }
    return items;
  }

  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this.paneViewsList;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return [];
  }

  updateAllViews(): void {
    this.param?.requestUpdate();
  }
}
