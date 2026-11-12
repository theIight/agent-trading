import { checkStaleness, toAppPrice, type BookmapMeta, type Candle, type Orderflow, type TradeSetup } from '@wca/shared';
import type { BinanceOrderflowSnapshot } from '../orderflow/calc.ts';

// Order flow từ ảnh Bookmap: server tự quy đổi giá (không tin số agent quy đổi), lọc mức vô lý, kiểm tra ảnh cũ.

export interface OrderflowContext extends BookmapMeta {
  /** Tuổi ảnh tối đa (giây) trước khi cảnh báo. */
  maxAgeSec: number;
}

/** Order flow Binance đã chụp lúc job bắt đầu. */
export interface BinanceOrderflowContext {
  snapshot: BinanceOrderflowSnapshot;
  /** CVD dạng chữ (dùng khi agent không nhận xét CVD). */
  cvdText: string;
}

/**
 * Order flow Binance: mức giá do server tính, agent chỉ nhận xét. Bỏ mọi levels/lastPrices agent gửi,
 * gắn levels từ snapshot (đã quy đổi về giá chart).
 */
export function validateBinanceOrderflow(of: Orderflow | undefined, ctx: BinanceOrderflowContext): { orderflow: Orderflow; warnings: string[] } {
  const warnings: string[] = [];
  const snap = ctx.snapshot;
  if (!of) warnings.push('Có order flow Binance nhưng agent không nộp orderflow — chỉ hiển thị số liệu server tính');
  if (of?.levels.length) warnings.push(`Bỏ ${of.levels.length} mức orderflow agent gửi: với Binance server tự tính levels`);
  if (of?.lastPrices.length) warnings.push('Bỏ orderflow.lastPrices: không dùng với order flow Binance');
  const orderflow: Orderflow = {
    source: 'binance',
    summary: of?.summary ?? 'Agent không nhận xét order flow.',
    cvd: of?.cvd || ctx.cvdText,
    lastPrices: [],
    levels: snap.levels,
    offset: snap.basis,
    asOf: snap.asOf,
    historyMin: snap.historyMin,
  };
  return { orderflow, warnings };
}

/** Mức quy đổi phải nằm trong [min low, max high] của số nến này (khung chính) ± RANGE_ATR × ATR. */
export const ORDERFLOW_RANGE_BARS = 300;
export const ORDERFLOW_RANGE_ATR = 3;

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Sai lệch coi là "trùng một mức" (agent chép giá Bookmap thường trùng chính xác), theo bội số ATR14 khung chính. */
export const UNCONVERTED_MATCH_ATR = 0.02;

/**
 * Agent hay lấy thẳng giá Bookmap (chưa trừ offset) làm entry/SL/TP. Giá setup trùng `bookmapPrice`
 * của một mức nhưng không trùng giá đã quy đổi → cảnh báo (không tự sửa setup).
 */
export function unconvertedPriceWarnings(setups: readonly TradeSetup[], levels: Orderflow['levels'], offset: number, atr: number): string[] {
  const tol = UNCONVERTED_MATCH_ATR * atr;
  if (!(tol > 0) || Math.abs(offset) <= 2 * tol) return [];
  const out: string[] = [];
  for (const st of setups) {
    const prices: [string, number][] = [
      ['entryLow', st.entryLow],
      ['entryHigh', st.entryHigh],
      ['stopLoss', st.stopLoss],
      ...st.takeProfits.map((tp, i): [string, number] => [`TP${i + 1}`, tp]),
    ];
    for (const [field, p] of prices) {
      if (field === 'entryHigh' && st.entryHigh === st.entryLow) continue;
      const lv = levels.find(
        l => l.bookmapPrice !== undefined && Math.abs(p - l.bookmapPrice) <= tol && Math.abs(p - toAppPrice(l.bookmapPrice, offset)) > tol,
      );
      if (lv) {
        out.push(
          `Setup "${st.name}" ${field} = ${p} trùng giá Bookmap CHƯA quy đổi của mức ${lv.kind} (${lv.bookmapPrice}); trên chart mức này ở ${toAppPrice(lv.bookmapPrice!, offset)} — kiểm tra lại`,
        );
      }
    }
  }
  return out;
}

export function validateOrderflow(
  of: Orderflow | undefined,
  ctx: OrderflowContext | undefined,
  primary: { candles: readonly Candle[]; atr: number },
  setups: readonly TradeSetup[] = [],
): { orderflow?: Orderflow; warnings: string[] } {
  const warnings: string[] = [];
  if (!ctx) {
    if (of) warnings.push('Bỏ orderflow: phân tích này không có ảnh Bookmap');
    return { warnings };
  }
  if (!of) {
    warnings.push('Có ảnh Bookmap nhưng agent không nộp orderflow');
    return { warnings };
  }

  const recent = primary.candles.slice(-ORDERFLOW_RANGE_BARS);
  const lo = Math.min(...recent.map(c => c.low)) - ORDERFLOW_RANGE_ATR * primary.atr;
  const hi = Math.max(...recent.map(c => c.high)) + ORDERFLOW_RANGE_ATR * primary.atr;

  const lastPrices = of.lastPrices.filter(lp => {
    if (ctx.images.includes(lp.image)) return true;
    warnings.push(`orderflow.lastPrices: bỏ ảnh ${lp.image} vì không được gửi`);
    return false;
  });

  const levels = of.levels.flatMap(lv => {
    if (!lv.image || lv.bookmapPrice === undefined) {
      warnings.push(`orderflow: bỏ mức ${lv.kind} — thiếu image hoặc bookmapPrice`);
      return [];
    }
    if (!ctx.images.includes(lv.image)) {
      warnings.push(`orderflow: bỏ mức ${lv.kind} ${lv.bookmapPrice} — không có ảnh ${lv.image}`);
      return [];
    }
    const p = toAppPrice(lv.bookmapPrice, ctx.offset);
    if (p < lo || p > hi) {
      warnings.push(`orderflow: bỏ mức ${lv.kind} ${lv.bookmapPrice} (quy đổi ${p}) — ngoài vùng giá [${r2(lo)}, ${r2(hi)}]`);
      return [];
    }
    const out = { ...lv, price: p };
    delete out.sourcePrice;
    delete out.persistMin;
    if (out.size !== undefined && !out.sizeSource) {
      warnings.push(`orderflow: bỏ size của mức ${lv.kind} ${lv.bookmapPrice} vì thiếu sizeSource`);
      delete out.size;
    }
    if (out.size === undefined) delete out.sizeSource;
    return [out];
  });

  const stale = checkStaleness({
    lastPrices,
    refPrice: ctx.refPrice,
    offset: ctx.offset,
    tolerance: ctx.tolerance,
    capturedAt: ctx.capturedAt,
    submittedAt: ctx.submittedAt,
    maxAgeSec: ctx.maxAgeSec,
  });
  warnings.push(...stale.warnings);
  warnings.push(...unconvertedPriceWarnings(setups, of.levels.filter(lv => lv.image && ctx.images.includes(lv.image)), ctx.offset, primary.atr));

  const orderflow: Orderflow = { ...of, source: 'bookmap-image', lastPrices, levels, offset: ctx.offset };
  delete orderflow.asOf;
  delete orderflow.historyMin;
  if (stale.measuredOffset !== undefined) orderflow.measuredOffset = stale.measuredOffset;
  else delete orderflow.measuredOffset;
  return { orderflow, warnings };
}
