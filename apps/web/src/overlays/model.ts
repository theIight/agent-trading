import {
  BEARISH_EVENTS,
  BULLISH_EVENTS,
  bookmapSizeUnit,
  ORDERFLOW_KIND_LABELS,
  tfLabel,
  tfSeconds,
  type AnalysisResult,
  type Candle,
  type Timeframe,
} from '@wca/shared';

// Chuyển AnalysisResult → mô hình vẽ (toạ độ thời gian/giá), độc lập với canvas để test được.

export type LayerKey = 'events' | 'ranges' | 'phases' | 'levels' | 'forecast' | 'action' | 'orderflow';
export const LAYER_KEYS: LayerKey[] = ['events', 'ranges', 'phases', 'levels', 'forecast', 'action', 'orderflow'];
export const LAYER_LABELS: Record<LayerKey, string> = {
  events: 'Sự kiện',
  ranges: 'Trading Range',
  phases: 'Phase',
  levels: 'Mức giá',
  forecast: 'Dự đoán',
  action: 'Setup',
  orderflow: 'Order flow',
};
export type LayerVisibility = Record<LayerKey, boolean>;
export const ALL_LAYERS_ON: LayerVisibility = {
  events: true, ranges: true, phases: true, levels: true, forecast: true, action: true, orderflow: true,
};

export const COLORS = {
  bull: '#26a69a',
  bear: '#ef5350',
  neutral: '#b2b5be',
  range: 'rgba(41,98,255,0.10)',
  rangeStroke: 'rgba(41,98,255,0.75)',
  creek: '#42a5f5',
  ice: '#ffa726',
  tpFill: 'rgba(38,166,154,0.18)',
  slFill: 'rgba(239,83,80,0.18)',
  tpFillPending: 'rgba(38,166,154,0.08)',
  slFillPending: 'rgba(239,83,80,0.08)',
  entryZone: 'rgba(255,193,7,0.16)',
  entryZoneStroke: 'rgba(255,193,7,0.8)',
  entry: '#b2b5be',
  orderflow: '#ab47bc',
  phaseFills: ['rgba(255,193,7,0.06)', 'rgba(156,39,176,0.06)', 'rgba(0,188,212,0.06)', 'rgba(76,175,80,0.06)', 'rgba(255,87,34,0.06)'],
};

const LEVEL_LABELS: Record<string, string> = {
  SUPPORT: 'Hỗ trợ',
  RESISTANCE: 'Kháng cự',
  CREEK: 'Creek',
  ICE: 'Ice',
  INVALIDATION: 'Vô hiệu',
  TARGET: 'Mục tiêu',
};

export interface MarkerItem {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown';
  color: string;
  text: string;
  eventIndex: number;
}

export interface RectItem {
  t1: number;
  t2: number;
  top: number;
  bottom: number;
  fill: string;
  stroke?: string;
  label?: string;
  labelColor?: string;
  labelAt?: 'top-left' | 'bottom-left' | 'top-right' | 'bottom-right';
  /** Viền nét đứt (setup đang chờ). */
  dashed?: boolean;
  /** Không tính vào autoscale thang giá (trading range). */
  noAutoscale?: boolean;
}

export interface BandItem {
  t1: number;
  t2: number;
  fill: string;
  label: string;
}

export interface LineItem {
  points: { time: number; price: number }[];
  color: string;
  width: number;
  dashed: boolean;
  label?: string;
}

export interface PriceLineItem {
  price: number;
  color: string;
  title: string;
  style: 'solid' | 'dashed' | 'dotted';
  /** Độ dày nét (mặc định 1). */
  width?: 1 | 2 | 3;
}

export interface OverlayModel {
  markers: MarkerItem[];
  rects: RectItem[];
  bands: BandItem[];
  lines: LineItem[];
  priceLines: PriceLineItem[];
  /** Số nến (khung hiện tại) mà overlay kéo dài sang tương lai — để mở rộng rightOffset. */
  futureBars: number;
}

export const EMPTY_MODEL: OverlayModel = { markers: [], rects: [], bands: [], lines: [], priceLines: [], futureBars: 0 };

/** Ánh xạ thời gian (giây) → chỉ số logic (có phần lẻ) trên khung hiện tại; ngoại suy trước/sau dữ liệu. */
export function makeTimeMapper(candles: readonly Candle[], tf: Timeframe): (time: number) => number | null {
  const step = tfSeconds(tf);
  return (time: number) => {
    const n = candles.length;
    if (!n) return null;
    const first = candles[0]!;
    const last = candles[n - 1]!;
    if (time < first.time) return (time - first.time) / step;
    if (time >= last.time) return n - 1 + (time - last.time) / step;
    const idx = indexAtOrBefore(candles, time);
    const bar = candles[idx]!;
    return idx + Math.min((time - bar.time) / step, 0.999);
  };
}

export function indexAtOrBefore(candles: readonly Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.time <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Thời gian nến của khung hiện tại chứa thời điểm `time`; null nếu ngoài cửa sổ dữ liệu. */
export function snapToBar(candles: readonly Candle[], tf: Timeframe, time: number): number | null {
  const idx = indexAtOrBefore(candles, time);
  if (idx < 0) return null;
  const bar = candles[idx]!;
  if (idx === candles.length - 1 && time >= bar.time + tfSeconds(tf)) return null;
  return bar.time;
}

function eventColor(type: AnalysisResult['events'][number]['type']): string {
  if (BULLISH_EVENTS.has(type)) return COLORS.bull;
  if (BEARISH_EVENTS.has(type)) return COLORS.bear;
  return COLORS.neutral;
}

function biasColor(bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): string {
  return bias === 'BULLISH' ? COLORS.bull : bias === 'BEARISH' ? COLORS.bear : COLORS.neutral;
}

const fmtPrice = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 1 : 6 });

export interface BuildOptions {
  layers?: LayerVisibility;
  /** Hiện cả sự kiện của khung nhỏ hơn khung đang xem (mặc định ẩn để tránh rối). */
  showLowerTfItems?: boolean;
  /** Độ rộng (số nến khung hiện tại) của công cụ Long/Short. */
  positionToolBars?: number;
  /** Chỉ vẽ setup có chỉ số này (null = tất cả). */
  selectedSetup?: number | null;
  /** Khi đứng ngoài: vẫn vẽ setup tham khảo. */
  showReferenceSetups?: boolean;
}

interface PositionTool {
  direction: 'LONG' | 'SHORT';
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfits: number[];
  t1: number;
  t2: number;
  pending: boolean;
  title: string;
  /** SL tầng 2 (ước lượng) trên khung nhỏ. */
  refined?: { tf: Timeframe; distance: number };
}

/** Công cụ Long/Short kiểu TradingView: vùng TP (xanh), vùng SL (đỏ), vùng entry, TP trung gian. */
function pushPositionTool(model: OverlayModel, p: PositionTool): void {
  const tp = p.takeProfits.at(-1);
  if (tp === undefined) return;
  const isLong = p.direction === 'LONG';
  const mid = (p.entryLow + p.entryHigh) / 2;
  model.rects.push({
    t1: p.t1, t2: p.t2, top: Math.max(mid, tp), bottom: Math.min(mid, tp),
    fill: p.pending ? COLORS.tpFillPending : COLORS.tpFill, stroke: p.pending ? COLORS.bull : undefined, dashed: p.pending,
    label: `${p.title} · TP ${fmtPrice(tp)}`, labelColor: COLORS.bull, labelAt: isLong ? 'top-left' : 'bottom-left',
  });
  model.rects.push({
    t1: p.t1, t2: p.t2, top: Math.max(mid, p.stopLoss), bottom: Math.min(mid, p.stopLoss),
    fill: p.pending ? COLORS.slFillPending : COLORS.slFill, stroke: p.pending ? COLORS.bear : undefined, dashed: p.pending,
    label: `SL ${fmtPrice(p.stopLoss)}`, labelColor: COLORS.bear, labelAt: isLong ? 'bottom-left' : 'top-left',
  });
  if (p.entryHigh > p.entryLow) {
    model.rects.push({
      t1: p.t1, t2: p.t2, top: p.entryHigh, bottom: p.entryLow, fill: COLORS.entryZone, stroke: COLORS.entryZoneStroke, dashed: true,
      label: `Entry ${fmtPrice(p.entryLow)}–${fmtPrice(p.entryHigh)}`, labelColor: COLORS.entryZoneStroke, labelAt: 'top-right',
    });
  } else {
    model.lines.push({ points: [{ time: p.t1, price: mid }, { time: p.t2, price: mid }], color: COLORS.entry, width: 1, dashed: p.pending, label: `Entry ${fmtPrice(mid)}` });
  }
  if (p.refined) {
    const price = isLong ? mid - p.refined.distance : mid + p.refined.distance;
    model.lines.push({
      points: [{ time: p.t1, price }, { time: p.t2, price }], color: COLORS.bear, width: 1, dashed: true,
      label: `SL ${tfLabel(p.refined.tf)} ≈ ${fmtPrice(price)}`,
    });
  }
  p.takeProfits.slice(0, -1).forEach((price, i) => {
    model.lines.push({ points: [{ time: p.t1, price }, { time: p.t2, price }], color: COLORS.bull, width: 1, dashed: true, label: `TP${i + 1}` });
  });
}

/** Độ rộng tối thiểu (số nến khung hiện tại) của mỗi công cụ Long/Short để nhãn đọc được. */
export const MIN_TOOL_BARS = 12;

/**
 * Đảm bảo độ rộng tối thiểu; nhiều setup → chia thành các cột cạnh nhau (setup chính bên trái),
 * cách nhau 1 nến, để hộp và nhãn không chồng lên nhau.
 */
function layoutPositionTools(tools: PositionTool[], barSec: number): void {
  const n = tools.length;
  if (!n) return;
  const start = Math.min(...tools.map(t => t.t1));
  const end = Math.max(...tools.map(t => t.t2));
  const total = Math.max(end - start, n * MIN_TOOL_BARS * barSec + (n - 1) * barSec);
  if (n === 1) {
    tools[0]!.t2 = start + total;
    return;
  }
  const col = (total - (n - 1) * barSec) / n;
  tools.forEach((t, i) => {
    t.t1 = start + i * (col + barSec);
    t.t2 = t.t1 + col;
  });
}

export interface LabelBox {
  x: number;
  y: number;
  width: number;
  align: 'left' | 'right' | 'center';
}

export const LABEL_HEIGHT = 12;

/**
 * Giãn nhãn theo chiều dọc để không đè nhau: nhãn sau trùng nhãn trước thì thử dịch xuống/lên
 * từng bậc LABEL_HEIGHT (tối đa `maxSteps` bậc mỗi phía). Trả về y mới theo thứ tự đầu vào.
 */
export function layoutLabels(labels: readonly LabelBox[], maxSteps = 4): number[] {
  const placed: { left: number; right: number; y: number }[] = [];
  const hits = (left: number, right: number, y: number) =>
    placed.some(p => left < p.right && right > p.left && Math.abs(y - p.y) < LABEL_HEIGHT);
  return labels.map(l => {
    const left = l.align === 'left' ? l.x : l.align === 'right' ? l.x - l.width : l.x - l.width / 2;
    const right = left + l.width;
    let y = l.y;
    for (let step = 1; hits(left, right, y) && step <= maxSteps; step++) {
      if (!hits(left, right, l.y + step * LABEL_HEIGHT)) y = l.y + step * LABEL_HEIGHT;
      else if (!hits(left, right, l.y - step * LABEL_HEIGHT)) y = l.y - step * LABEL_HEIGHT;
    }
    placed.push({ left, right, y });
    return y;
  });
}

const ENTRY_TYPE_LABEL ={ MARKET: 'Vào ngay', LIMIT: 'Chờ hồi', STOP: 'Chờ phá vỡ' } as const;

export function buildOverlayModel(
  analysis: AnalysisResult | null,
  candles: readonly Candle[],
  currentTf: Timeframe,
  opts: BuildOptions = {},
): OverlayModel {
  if (!analysis || !candles.length) return EMPTY_MODEL;
  const layers = opts.layers ?? ALL_LAYERS_ON;
  const curSec = tfSeconds(currentTf);
  const visibleTf = (tf: Timeframe) => opts.showLowerTfItems || tfSeconds(tf) >= curSec;
  const tfTag = (tf: Timeframe) => (tf === currentTf ? '' : `·${tfLabel(tf)}`);
  const last = candles[candles.length - 1]!;
  const model: OverlayModel = { markers: [], rects: [], bands: [], lines: [], priceLines: [], futureBars: 0 };
  let maxTime = last.time;

  if (layers.events) {
    analysis.events.forEach((ev, eventIndex) => {
      if (!visibleTf(ev.tf)) return;
      const time = snapToBar(candles, currentTf, ev.time);
      if (time === null) return;
      const bar = candles[indexAtOrBefore(candles, time)]!;
      const atHigh = ev.price >= (bar.high + bar.low) / 2;
      model.markers.push({
        time,
        position: atHigh ? 'aboveBar' : 'belowBar',
        shape: atHigh ? 'arrowDown' : 'arrowUp',
        color: eventColor(ev.type),
        text: `${ev.type}${tfTag(ev.tf)}`,
        eventIndex,
      });
    });
    model.markers.sort((a, b) => a.time - b.time);
  }

  if (layers.phases) {
    analysis.phases
      .filter(p => visibleTf(p.tf))
      .forEach(p => {
        model.bands.push({
          t1: p.start,
          t2: p.end + tfSeconds(p.tf),
          fill: COLORS.phaseFills['ABCDE'.indexOf(p.phase)] ?? COLORS.phaseFills[0]!,
          label: `Phase ${p.phase}${tfTag(p.tf)}`,
        });
      });
  }

  if (layers.ranges) {
    analysis.ranges
      .filter(r => visibleTf(r.tf))
      .forEach(r => {
        const t2 = r.end + tfSeconds(r.tf);
        model.rects.push({
          t1: r.start,
          t2,
          top: r.top,
          bottom: r.bottom,
          fill: COLORS.range,
          stroke: COLORS.rangeStroke,
          noAutoscale: true,
          label: `${r.label}${tfTag(r.tf)}`,
          labelColor: COLORS.rangeStroke,
          labelAt: 'top-left',
        });
        if (r.creek) model.lines.push({ points: [{ time: r.start, price: r.creek }, { time: t2, price: r.creek }], color: COLORS.creek, width: 1, dashed: true, label: 'Creek' });
        if (r.ice) model.lines.push({ points: [{ time: r.start, price: r.ice }, { time: t2, price: r.ice }], color: COLORS.ice, width: 1, dashed: true, label: 'Ice' });
      });
  }

  if (layers.levels) {
    const levelStyle: Record<string, Pick<PriceLineItem, 'color' | 'style'>> = {
      SUPPORT: { color: COLORS.bull, style: 'dotted' },
      RESISTANCE: { color: COLORS.bear, style: 'dotted' },
      CREEK: { color: COLORS.creek, style: 'dashed' },
      ICE: { color: COLORS.ice, style: 'dashed' },
      INVALIDATION: { color: COLORS.bear, style: 'solid' },
      TARGET: { color: COLORS.bull, style: 'dashed' },
    };
    for (const lv of analysis.levels) {
      const s = levelStyle[lv.kind] ?? { color: COLORS.neutral, style: 'dotted' as const };
      // Nhãn ngắn để không đè lên nến; ghi chú đầy đủ xem ở panel.
      model.priceLines.push({ price: lv.price, ...s, title: LEVEL_LABELS[lv.kind] ?? lv.kind });
    }
  }

  if (layers.orderflow && analysis.orderflow) {
    const levels = analysis.orderflow.levels.filter(lv => lv.price !== undefined);
    // Độ dày theo size tương đối, chỉ so trong cùng ảnh + cùng nguồn (COB ≠ SVP).
    const maxSize = new Map<string, number>();
    for (const lv of levels) {
      if (lv.size === undefined) continue;
      const key = `${lv.image}:${lv.sizeSource}`;
      maxSize.set(key, Math.max(maxSize.get(key) ?? 0, lv.size));
    }
    const unit = bookmapSizeUnit(analysis.symbol);
    for (const lv of levels) {
      let width: 1 | 2 | 3 = 1;
      let sizeText = '';
      if (lv.size !== undefined) {
        const ratio = lv.size / (maxSize.get(`${lv.image}:${lv.sizeSource}`) ?? lv.size);
        width = ratio >= 0.999 ? 3 : ratio >= 0.5 ? 2 : 1;
        sizeText = ` · ${Number(lv.size.toFixed(2))}${unit ? ` ${unit}` : ''}`;
      }
      model.priceLines.push({ price: lv.price!, color: COLORS.orderflow, style: 'dotted', width, title: `BM ${ORDERFLOW_KIND_LABELS[lv.kind]}${sizeText}` });
    }
  }

  if (layers.forecast) {
    const ranked = [...analysis.scenarios].sort((a, b) => b.probability - a.probability);
    ranked.forEach((sc, rank) => {
      const points = [...sc.path].sort((a, b) => a.time - b.time);
      maxTime = Math.max(maxTime, ...points.map(p => p.time));
      model.lines.push({
        points,
        color: biasColor(sc.bias),
        width: rank === 0 ? 2.5 : 1.5,
        dashed: true,
        label: `${sc.name} ${Math.round(sc.probability * 100)}%`,
      });
    });
  }

  if (layers.action) {
    const t1 = snapToBar(candles, currentTf, analysis.asOf) ?? last.time;
    const defaultT2 = last.time + (opts.positionToolBars ?? 25) * curSec;
    const plan = analysis.tradePlan;
    const tools: PositionTool[] = [];
    if (plan) {
      const drawable = plan.decision !== 'STAND_ASIDE' || opts.showReferenceSetups;
      plan.setups.forEach((st, i) => {
        if (!drawable) return;
        if (opts.selectedSetup != null && opts.selectedSetup !== i) return;
        const pending = !(plan.decision === 'ENTER' && st.entryType === 'MARKET');
        const rr = st.riskReward !== undefined ? ` · R:R ${st.riskReward.toFixed(2)}` : '';
        const prefix = plan.decision === 'STAND_ASIDE' ? 'Tham khảo · ' : pending ? `${ENTRY_TYPE_LABEL[st.entryType]} ${st.trigger} · ` : '';
        tools.push({
          direction: st.direction,
          entryLow: st.entryLow,
          entryHigh: st.entryHigh,
          stopLoss: st.stopLoss,
          takeProfits: st.takeProfits,
          t1,
          t2: st.validUntil && st.validUntil > last.time ? st.validUntil : defaultT2,
          pending,
          title: `${prefix}${st.direction}${rr}`,
          refined: st.refinedEntry ? { tf: st.refinedEntry.tf, distance: st.refinedEntry.estStopDistance } : undefined,
        });
      });
    } else {
      // Bản ghi cũ (trước khi có tradePlan).
      const a = analysis.action;
      if (a.type !== 'WAIT' && a.entry && a.stopLoss && a.takeProfits.length) {
        const rr = a.riskReward !== undefined ? ` · R:R ${a.riskReward.toFixed(2)}` : '';
        tools.push({
          direction: a.type, entryLow: a.entry, entryHigh: a.entry, stopLoss: a.stopLoss, takeProfits: a.takeProfits,
          t1, t2: defaultT2, pending: false, title: `${a.type}${rr}`,
        });
      }
    }
    layoutPositionTools(tools, curSec);
    for (const tool of tools) {
      maxTime = Math.max(maxTime, tool.t2);
      pushPositionTool(model, tool);
    }
  }

  model.futureBars = Math.max(0, Math.ceil((maxTime - last.time) / curSec));
  return model;
}
