import type { ISeriesPrimitive, ISeriesPrimitiveAxisView, SeriesAttachedParameter, Time } from 'lightweight-charts';

// Nhãn đếm ngược đóng nến trên trục giá, ngay dưới nhãn giá hiện tại (giống TradingView).

export interface CountdownSource {
  /** Nhãn hiện tại (null = ẩn), giá đóng nến cuối và màu nền theo nến tăng/giảm. */
  get(): { text: string; price: number; color: string } | null;
}

/** Chiều cao nhãn giá của trục (px) để đặt nhãn đếm ngay bên dưới. */
const LABEL_OFFSET = 19;

class CountdownAxisView implements ISeriesPrimitiveAxisView {
  constructor(private readonly owner: CountdownPrimitive) {}
  coordinate(): number {
    return -10_000;
  }
  fixedCoordinate(): number | undefined {
    const st = this.owner.state();
    return st ? st.y + LABEL_OFFSET : undefined;
  }
  text(): string {
    return this.owner.state()?.text ?? '';
  }
  textColor(): string {
    return '#ffffff';
  }
  backColor(): string {
    return this.owner.state()?.color ?? 'transparent';
  }
  visible(): boolean {
    return this.owner.state() !== null;
  }
  tickVisible(): boolean {
    return false;
  }
}

export class CountdownPrimitive implements ISeriesPrimitive<Time> {
  private param: SeriesAttachedParameter<Time> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly views = [new CountdownAxisView(this)];

  constructor(private readonly source: CountdownSource) {}

  attached(param: SeriesAttachedParameter<Time>): void {
    this.param = param;
    this.timer = setInterval(() => param.requestUpdate(), 1000);
  }

  detached(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.param = null;
  }

  state(): { text: string; y: number; color: string } | null {
    const s = this.source.get();
    if (!s || !this.param) return null;
    const y = this.param.series.priceToCoordinate(s.price);
    return y === null ? null : { text: s.text, y, color: s.color };
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.views;
  }
}
