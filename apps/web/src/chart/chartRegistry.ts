import type { ChartController } from './ChartController.ts';

// Tham chiếu tới chart hiện tại cho các thành phần ngoài ChartView (chụp ảnh, cuộn tới sự kiện).
let current: ChartController | null = null;

export const chartRegistry = {
  set(ctrl: ChartController | null) {
    current = ctrl;
  },
  get(): ChartController | null {
    return current;
  },
  /** Ảnh PNG (data URL) của chart đang hiển thị, kèm overlay. */
  screenshot(): string | undefined {
    return current?.chart.takeScreenshot().toDataURL('image/png');
  },
  scrollTo(time: number) {
    current?.scrollToTime(time);
  },
};
