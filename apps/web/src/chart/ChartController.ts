import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, Timeframe, VolumeAggBar, VolumeSpike } from '@wca/shared';
import type { InstrumentInfo } from '@wca/shared';
import { fetchInstrument, fetchKlines } from '../api/client.ts';
import { subscribeLiveKlines, subscribeServerLive } from './liveFeed.ts';
import { countdownLabel, updateSkew } from './countdown.ts';
import { CountdownPrimitive } from './CountdownPrimitive.ts';
import { THEMES, type ThemeName } from './theme.ts';

const INITIAL_BARS = 800;
const PAGE_BARS = 800;
const LOAD_MORE_THRESHOLD = 30;

export interface LegendData {
  candle: Candle | null;
  change: number | null;
  /** Volume gộp của nến (chỉ nến đã đóng, khi bật "Volume gộp"). */
  volAgg?: VolumeAggBar;
}

/** Màu phần spot trong cột volume gộp. */
export const SPOT_VOLUME_COLOR = 'rgba(255,152,0,0.8)';
const SPIKE_COLORS: Record<VolumeSpike['kind'], string> = { BOTH: '#ff6d00', SPOT: '#ff9800', PERP: '#9598a1' };
const SPIKE_TEXT: Record<VolumeSpike['kind'], string> = { BOTH: 'S+P', SPOT: 'S', PERP: 'P' };

export interface ChartListeners {
  onLegend?: (data: LegendData) => void;
  onStatus?: (status: string) => void;
  /** Thông tin nguồn dữ liệu của symbol đang xem (legend). */
  onInstrument?: (info: InstrumentInfo | null) => void;
  onError?: (message: string | null) => void;
  /** Gọi sau mỗi lần dữ liệu thay đổi (để overlay vẽ lại). */
  onDataChange?: (candles: readonly Candle[]) => void;
}

const pad = (n: number) => String(n).padStart(2, '0');

function formatTick(time: Time, type: TickMarkType): string {
  const d = new Date((time as number) * 1000);
  switch (type) {
    case TickMarkType.Year:
      return String(d.getFullYear());
    case TickMarkType.Month:
      return `Th${d.getMonth() + 1}`;
    case TickMarkType.DayOfMonth:
      return String(d.getDate());
    default:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

function formatCrosshairTime(time: Time): string {
  const d = new Date((time as number) * 1000);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Quản lý chart lightweight-charts: nến + volume, tải lịch sử khi kéo sang trái,
 * nến realtime qua WebSocket. Overlay (M2) gắn vào `chart` và `candleSeries`.
 */
export class ChartController {
  readonly chart: IChartApi;
  readonly candleSeries: ISeriesApi<'Candlestick'>;
  readonly volumeSeries: ISeriesApi<'Histogram'>;
  /** Volume gộp: cột perp + spot (vẽ sau cột perp), chỉ nến đã đóng. */
  private readonly spotVolumeSeries: ISeriesApi<'Histogram'>;
  private readonly spikeMarkers: ISeriesMarkersPluginApi<Time>;
  private volAgg: Map<number, VolumeAggBar> | null = null;
  private volSpikes: VolumeSpike[] = [];
  private candles: Candle[] = [];
  private symbol = '';
  private tf: Timeframe = '4h';
  private theme: ThemeName = 'dark';
  private unsubscribeLive: (() => void) | null = null;
  private loadingMore = false;
  private noMoreHistory = false;
  private loadToken = 0;
  /** Giờ sàn − giờ máy (ms), từ giờ sự kiện của WebSocket Binance. */
  private clockSkewMs = 0;

  constructor(container: HTMLElement, private readonly listeners: ChartListeners = {}) {
    this.chart = createChart(container, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 12, tickMarkFormatter: formatTick },
      localization: { locale: 'vi-VN', timeFormatter: formatCrosshairTime },
      rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.22 } },
    });
    this.candleSeries = this.chart.addSeries(CandlestickSeries, { borderVisible: false });
    // Thêm trước cột perp để nằm phía sau (cột spot = perp + spot, phần nhô lên là spot).
    this.spotVolumeSeries = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
      color: SPOT_VOLUME_COLOR,
    });
    this.spikeMarkers = createSeriesMarkers(this.spotVolumeSeries, []);
    this.volumeSeries = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    // Đếm ngược đóng nến dưới nhãn giá hiện tại.
    this.candleSeries.attachPrimitive(
      new CountdownPrimitive({
        get: () => {
          const last = this.candles.at(-1);
          if (!last) return null;
          const text = countdownLabel(last.time, this.tf, (Date.now() + this.clockSkewMs) / 1000);
          if (text === null) return null;
          const t = THEMES[this.theme];
          return { text, price: last.close, color: last.close >= last.open ? t.up : t.down };
        },
      }),
    );
    this.applyTheme('dark');

    this.chart.subscribeCrosshairMove(this.handleCrosshair);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range && range.from < LOAD_MORE_THRESHOLD) void this.loadMore();
    });
  }

  getCandles(): readonly Candle[] {
    return this.candles;
  }

  getSymbol(): string {
    return this.symbol;
  }

  getTimeframe(): Timeframe {
    return this.tf;
  }

  applyTheme(name: ThemeName): void {
    this.theme = name;
    const t = THEMES[name];
    this.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: t.background }, textColor: t.text, fontSize: 12 },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
      crosshair: {
        vertLine: { color: t.crosshair, labelBackgroundColor: t.border },
        horzLine: { color: t.crosshair, labelBackgroundColor: t.border },
      },
    });
    this.candleSeries.applyOptions({
      upColor: t.up,
      downColor: t.down,
      wickUpColor: t.up,
      wickDownColor: t.down,
    });
    if (this.candles.length) this.refreshVolume();
  }

  /** Volume gộp (nến đã đóng) + đột biến; null = về volume Binance Futures như cũ. */
  setVolumeAggregate(data: { bars: readonly VolumeAggBar[]; spikes: readonly VolumeSpike[] } | null): void {
    this.volAgg = data ? new Map(data.bars.map(b => [b.time, b])) : null;
    this.volSpikes = data ? [...data.spikes] : [];
    this.refreshVolume();
  }

  private refreshVolume(): void {
    this.volumeSeries.setData(this.candles.map(c => this.toVolume(c)));
    const agg = this.volAgg;
    if (!agg) {
      this.spotVolumeSeries.setData([]);
      this.spikeMarkers.setMarkers([]);
      return;
    }
    const spotData: HistogramData[] = [];
    for (const c of this.candles) {
      const a = agg.get(c.time);
      if (a && a.spot !== null) spotData.push({ time: c.time as UTCTimestamp, value: a.perp + a.spot });
    }
    this.spotVolumeSeries.setData(spotData);
    const have = new Set(spotData.map(d => d.time as number));
    this.spikeMarkers.setMarkers(
      this.volSpikes
        .filter(sp => have.has(sp.time))
        .map(sp => ({
          time: sp.time as UTCTimestamp,
          position: 'aboveBar' as const,
          shape: 'circle' as const,
          size: sp.kind === 'BOTH' ? 1 : 0.6,
          color: SPIKE_COLORS[sp.kind],
          text: SPIKE_TEXT[sp.kind],
        })),
    );
  }

  /** Tải dữ liệu cho symbol/khung mới và kết nối realtime. */
  async load(symbol: string, tf: Timeframe): Promise<void> {
    const token = ++this.loadToken;
    const symbolChanged = symbol !== this.symbol;
    // Volume gộp thuộc symbol/khung cũ (mốc thời gian có thể trùng, vd 1h và 4h) → bỏ, chờ bản mới.
    this.volAgg = null;
    this.volSpikes = [];
    this.symbol = symbol;
    this.tf = tf;
    this.noMoreHistory = false;
    this.unsubscribeLive?.();
    this.unsubscribeLive = null;
    this.listeners.onError?.(null);
    this.listeners.onInstrument?.(null);
    this.listeners.onStatus?.('Đang tải…');
    const infoP = fetchInstrument(symbol).catch(() => null);
    try {
      const res = await fetchKlines(symbol, tf, INITIAL_BARS);
      const info = await infoP;
      if (token !== this.loadToken) return;
      this.listeners.onInstrument?.(info);
      this.fixedPrecision = info && info.assetClass !== 'crypto' ? 2 : null;
      this.candles = res.candles;
      this.setAllData();
      // Đổi symbol: bật lại auto-scale trục giá (người dùng kéo trục giá sẽ tắt nó),
      // nếu không màn hình vẫn đứng ở vùng giá của symbol cũ (vd 70k khi mở NEAR ~3.5).
      if (symbolChanged) this.resetPriceScale();
      this.chart.timeScale().scrollToRealTime();
      this.emitLegend(this.candles.at(-1) ?? null);
      const onStatus = (s: 'connecting' | 'open' | 'closed') =>
        this.listeners.onStatus?.(s === 'open' ? 'Live' : s === 'connecting' ? 'Đang kết nối…' : 'Mất kết nối');
      this.unsubscribeLive =
        info?.live === 'server-sse'
          ? subscribeServerLive(symbol, tf, c => this.onLiveCandle(c), onStatus, msg => this.listeners.onError?.(msg))
          : subscribeLiveKlines(
              symbol,
              tf,
              (c, _closed, eventMs) => {
                if (eventMs) this.clockSkewMs = updateSkew(this.clockSkewMs, eventMs, Date.now());
                this.onLiveCandle(c);
              },
              onStatus,
            );
    } catch (err) {
      if (token !== this.loadToken) return;
      // Không để lại nến của symbol cũ khi symbol mới tải lỗi (dễ hiểu nhầm).
      this.candles = [];
      this.setAllData();
      this.emitLegend(null);
      const info = await infoP;
      if (token !== this.loadToken) return;
      this.listeners.onInstrument?.(info);
      this.listeners.onError?.((err as Error).message);
      this.listeners.onStatus?.('Lỗi');
    }
  }

  destroy(): void {
    this.unsubscribeLive?.();
    this.chart.remove();
  }

  /** Cuộn chart tới một thời điểm (giây), giữ nguyên độ zoom. */
  scrollToTime(time: number): void {
    const idx = this.indexAtOrBefore(time);
    if (idx < 0) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const width = range ? range.to - range.from : 120;
    this.chart.timeScale().setVisibleLogicalRange({ from: idx - width / 2, to: idx + width / 2 });
  }

  indexAtOrBefore(time: number): number {
    let lo = 0;
    let hi = this.candles.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.candles[mid]!.time <= time) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  private onLiveCandle(c: Candle): void {
    const last = this.candles.at(-1);
    if (last && c.time < last.time) return;
    if (last && c.time === last.time) this.candles[this.candles.length - 1] = c;
    else this.candles.push(c);
    this.candleSeries.update(this.toCandle(c));
    this.volumeSeries.update(this.toVolume(c));
    if (!this.crosshairActive) this.emitLegend(c);
    if (!last || c.time !== last.time) this.listeners.onDataChange?.(this.candles);
  }

  private async loadMore(): Promise<void> {
    if (this.loadingMore || this.noMoreHistory || !this.candles.length) return;
    this.loadingMore = true;
    const token = this.loadToken;
    try {
      const first = this.candles[0]!;
      const res = await fetchKlines(this.symbol, this.tf, PAGE_BARS, first.time - 1);
      if (token !== this.loadToken) return;
      const older = res.candles.filter(c => c.time < first.time);
      if (!older.length) {
        this.noMoreHistory = true;
        return;
      }
      const range = this.chart.timeScale().getVisibleLogicalRange();
      this.candles = [...older, ...this.candles];
      this.setAllData();
      if (range) {
        this.chart.timeScale().setVisibleLogicalRange({ from: range.from + older.length, to: range.to + older.length });
      }
    } catch (err) {
      this.listeners.onError?.((err as Error).message);
    } finally {
      this.loadingMore = false;
    }
  }

  /** Số chữ số thập phân theo độ lớn giá (BTC ≈ 0.1, altcoin nhỏ hơn). */
  /** Số lẻ cố định theo instrument (vàng/forex: 2), null = tự tính theo độ lớn giá. */
  private fixedPrecision: number | null = null;

  private applyPriceFormat(): void {
    const ref = this.candles.at(-1)?.close ?? 0;
    const precision = this.fixedPrecision ?? (ref >= 1000 ? 1 : ref >= 10 ? 2 : ref >= 1 ? 4 : ref >= 0.01 ? 5 : 7);
    this.candleSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
  }

  private resetPriceScale(): void {
    this.candleSeries.priceScale().applyOptions({ autoScale: true });
    this.chart.priceScale('volume').applyOptions({ autoScale: true });
  }

  private setAllData(): void {
    this.applyPriceFormat();
    this.candleSeries.setData(this.candles.map(c => this.toCandle(c)));
    this.refreshVolume();
    this.listeners.onDataChange?.(this.candles);
  }

  private crosshairActive = false;

  private handleCrosshair = (param: MouseEventParams): void => {
    if (!param.time || !param.point) {
      this.crosshairActive = false;
      this.emitLegend(this.candles.at(-1) ?? null);
      return;
    }
    this.crosshairActive = true;
    const idx = this.indexAtOrBefore(param.time as number);
    this.emitLegend(this.candles[idx] ?? null, idx);
  };

  private emitLegend(candle: Candle | null, idx = this.candles.length - 1): void {
    const prev = idx > 0 ? this.candles[idx - 1] : undefined;
    const change = candle && prev ? ((candle.close - prev.close) / prev.close) * 100 : null;
    const volAgg = candle ? this.volAgg?.get(candle.time) : undefined;
    this.listeners.onLegend?.({ candle, change, ...(volAgg ? { volAgg } : {}) });
  }

  private toCandle(c: Candle): CandlestickData {
    return { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
  }

  private toVolume(c: Candle): HistogramData {
    const t = THEMES[this.theme];
    // Bật volume gộp: nến đã đóng dùng tổng perp 3 sàn; nến đang chạy giữ volume Binance Futures.
    const agg = this.volAgg?.get(c.time);
    const up = c.close >= c.open;
    if (agg) return { time: c.time as UTCTimestamp, value: agg.perp, color: up ? t.upVolumeSolid : t.downVolumeSolid };
    return { time: c.time as UTCTimestamp, value: c.volume, color: up ? t.upVolume : t.downVolume };
  }
}
