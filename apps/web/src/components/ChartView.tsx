import { useEffect, useRef, useState } from 'react';
import { tfLabel, type InstrumentInfo } from '@wca/shared';
import { ChartController, type LegendData } from '../chart/ChartController.ts';
import { OverlayManager } from '../overlays/OverlayManager.ts';
import { buildDemoAnalysis, type DemoVariant } from '../overlays/demoAnalysis.ts';
import { useAnalysisStore } from '../store/useAnalysisStore.ts';
import { useAppStore } from '../store/useAppStore.ts';
import { useOrderflowStore } from '../store/useOrderflowStore.ts';
import { useLiquidationStore } from '../store/useLiquidationStore.ts';
import { useVolumeAggStore } from '../store/useVolumeAggStore.ts';
import { LayerToggles } from './LayerToggles.tsx';

function fmt(n: number): string {
  const digits = n >= 1000 ? 1 : n >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtVol(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

const DEMO_PARAM = new URLSearchParams(window.location.search).get('demo');
const DEMO_MODE = DEMO_PARAM !== null;
const DEMO_VARIANT: DemoVariant = DEMO_PARAM === 'enter' || DEMO_PARAM === 'aside' ? DEMO_PARAM : 'wait';

interface Props {
  onStatus: (s: string) => void;
  onReady?: (controller: ChartController | null) => void;
}

export function ChartView({ onStatus, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ChartController | null>(null);
  const overlayRef = useRef<OverlayManager | null>(null);
  const [legend, setLegend] = useState<LegendData>({ candle: null, change: null });
  const [error, setError] = useState<string | null>(null);
  const [instrument, setInstrument] = useState<InstrumentInfo | null>(null);
  const { symbol, tf, theme } = useAppStore();
  const { current, layers, setCurrent, selectedSetup, showReferenceSetups, orderflowSymbols, liquidationSymbols } = useAnalysisStore();
  const { data: liq, error: liqError, showBubbles, showHeatmap, watch: watchLiquidation } = useLiquidationStore();
  const liqSymbol = liquidationSymbols.includes(symbol) ? symbol : null;
  const volumeAggSymbols = useAnalysisStore(s => s.volumeAggSymbols);
  const { enabled: volAggOn, data: volAgg, error: volAggError, sync: syncVolAgg } = useVolumeAggStore();
  const volAggSymbol = volumeAggSymbols.includes(symbol) ? symbol : null;
  /** Số nến + mốc nến cuối trên chart: đổi khi có nến mới / tải thêm lịch sử → tải lại volume gộp. */
  const [bars, setBars] = useState<{ count: number; lastTime: number | null }>({ count: 0, lastTime: null });
  const { data: liveOf, error: liveOfError, watch: watchOrderflow } = useOrderflowStore();
  const liveOfSymbol = orderflowSymbols.includes(symbol) ? symbol : null;

  useEffect(() => {
    if (!containerRef.current) return;
    let demoKey = '';
    const ctrl = new ChartController(containerRef.current, {
      onLegend: setLegend,
      onStatus,
      onError: setError,
      onInstrument: setInstrument,
      onDataChange: candles => {
        setBars(prev =>
          prev.count === candles.length && prev.lastTime === (candles.at(-1)?.time ?? null)
            ? prev
            : { count: candles.length, lastTime: candles.at(-1)?.time ?? null },
        );
        if (DEMO_MODE) {
          const key = `${ctrl.getSymbol()}:${ctrl.getTimeframe()}`;
          if (key !== demoKey && candles.length) {
            demoKey = key;
            setCurrent(buildDemoAnalysis(candles, ctrl.getTimeframe(), useAppStore.getState().symbol, DEMO_VARIANT));
            return;
          }
        }
        overlayRef.current?.render();
      },
    });
    controllerRef.current = ctrl;
    overlayRef.current = new OverlayManager(ctrl);
    onReady?.(ctrl);
    return () => {
      onReady?.(null);
      overlayRef.current?.destroy();
      overlayRef.current = null;
      ctrl.destroy();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.applyTheme(theme);
    overlayRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    void controllerRef.current?.load(symbol, tf);
  }, [symbol, tf]);

  useEffect(() => {
    overlayRef.current?.setAnalysis(current);
  }, [current]);

  useEffect(() => {
    overlayRef.current?.setLayers(layers);
  }, [layers]);

  // Order flow live (BTC): poll theo symbol đang xem.
  useEffect(() => {
    watchOrderflow(liveOfSymbol);
    return () => watchOrderflow(null);
  }, [liveOfSymbol, watchOrderflow]);

  useEffect(() => {
    overlayRef.current?.setLiveOrderflow(liveOf ? { symbol: liveOf.symbol, levels: liveOf.levels, wallSegments: liveOf.wallSegments } : null);
  }, [liveOf]);

  // Volume gộp (BTC, nến đã đóng): tải khi bật toggle, khi đổi symbol/khung và khi có nến mới đóng.
  useEffect(() => {
    syncVolAgg(volAggSymbol, tf, Math.min(bars.count, 1000), bars.lastTime);
  }, [volAggSymbol, tf, bars, volAggOn, syncVolAgg]);

  useEffect(() => {
    const ok = volAggOn && volAgg && volAgg.symbol === symbol && volAgg.tf === tf;
    controllerRef.current?.setVolumeAggregate(ok ? volAgg : null);
  }, [volAggOn, volAgg, symbol, tf]);

  // Thanh lý (BTC): poll theo symbol + khung đang xem.
  useEffect(() => {
    watchLiquidation(liqSymbol, tf);
    return () => watchLiquidation(null, tf);
  }, [liqSymbol, tf, watchLiquidation]);

  useEffect(() => {
    overlayRef.current?.setLiquidation(liq ? { data: liq, showBubbles, showHeatmap } : null);
  }, [liq, showBubbles, showHeatmap]);

  useEffect(() => {
    overlayRef.current?.setSetupView({ selectedSetup, showReferenceSetups });
  }, [selectedSetup, showReferenceSetups]);

  const c = legend.candle;
  const up = c ? c.close >= c.open : true;

  return (
    <div className="chart-wrap">
      <div ref={containerRef} className="chart" />
      <div className="legend">
        <span className="legend-title">
          {instrument?.displayName ?? symbol} · {tfLabel(tf)} · {instrument?.sourceLabel ?? 'Binance Futures'}
        </span>
        {c && (
          <span className={up ? 'up' : 'down'}>
            O <b>{fmt(c.open)}</b> H <b>{fmt(c.high)}</b> L <b>{fmt(c.low)}</b> C <b>{fmt(c.close)}</b>
            {legend.change !== null && (
              <b>
                {' '}
                {legend.change >= 0 ? '+' : ''}
                {legend.change.toFixed(2)}%
              </b>
            )}{' '}
            Vol <b>{fmtVol(c.volume)}</b>
            {legend.volAgg && (
              <span className="vol-agg-legend">
                {' '}
                · Perp 3 sàn <b>{fmtVol(legend.volAgg.perp)}</b>
                {!legend.volAgg.perpComplete && <span className="muted"> (thiếu sàn)</span>} · <span className="vol-spot">Spot</span>{' '}
                <b>{legend.volAgg.spot === null ? '—' : fmtVol(legend.volAgg.spot)}</b>
              </span>
            )}
          </span>
        )}
      </div>
      <LayerToggles />
      {liveOfSymbol && layers.orderflow && (liveOfError || (liveOf && (!liveOf.connected || liveOf.historyMin < 30))) && (
        <div className={`of-chart-status ${liveOfError || !liveOf?.connected ? 'down' : 'muted'}`}>
          Order flow:{' '}
          {liveOfError
            ? `lỗi tải (${liveOfError})`
            : !liveOf!.connected
              ? 'mất kết nối Binance — đang giữ vạch cũ'
              : `lịch sử ${Math.round(liveOf!.historyMin)} phút (cần ≥ 30 phút để tin tường)`}
        </div>
      )}
      {liqSymbol && (showBubbles || showHeatmap) && (liqError || (liq && liq.notes.length > 0)) && (
        <div className={`of-chart-status liq-chart-status ${liqError ? 'down' : 'muted'}`}>
          Thanh lý: {liqError ? `lỗi tải (${liqError})` : liq!.notes.join(' · ')}
        </div>
      )}
      {volAggSymbol && volAggOn && (volAggError || (volAgg && volAgg.notes.length > 0)) && (
        <div className={`of-chart-status volagg-chart-status ${volAggError ? 'down' : 'muted'}`}>
          Volume gộp: {volAggError ? `lỗi tải (${volAggError})` : volAgg!.notes.join(' · ')}
        </div>
      )}
      {error && <div className="chart-error">Lỗi tải dữ liệu: {error}</div>}
    </div>
  );
}
