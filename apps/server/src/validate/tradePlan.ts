import { tfSeconds, type Timeframe, type TopDownStep, type TradeAction, type TradePlan, type TradeSetup } from '@wca/shared';

// Kiểm tra trade plan agent gửi: chiều giá, loại lệnh so với giá hiện tại, R:R tối thiểu,
// rồi hạ cấp quyết định nếu không còn setup hợp lệ. Thuần tuý, không I/O.

export interface TradePlanContext {
  /** Giá đóng cửa nến đã đóng gần nhất của khung chính. */
  lastClose: number;
  /** ATR14 khung chính (dung sai xác định giá có nằm trong vùng entry). */
  atr: number;
  /** Open time nến đóng gần nhất của khung chính. */
  asOf: number;
  minRiskReward: number;
  scenarioNames: readonly string[];
  topDown: readonly TopDownStep[];
  primaryTf: Timeframe;
  /** ATR14 theo khung (nến đã đóng) — dùng cho entry tinh chỉnh. */
  atrByTf: Partial<Record<Timeframe, number>>;
}

/** SL tinh chỉnh tối thiểu theo bội số ATR của khung tinh chỉnh (chặt hơn là nằm trong nhiễu). */
export const REFINED_MIN_STOP_ATR = 0.5;

/** Dung sai "giá đang ở vùng entry" theo bội số ATR. */
export const MARKET_ZONE_ATR = 0.25;

const r2 = (x: number) => Math.round(x * 100) / 100;
const sig4 = (x: number) => Number(x.toPrecision(4));

export const entryMid = (s: Pick<TradeSetup, 'entryLow' | 'entryHigh'>) => (s.entryLow + s.entryHigh) / 2;

/** Loại lệnh đúng theo vị trí giá hiện tại so với vùng entry. */
export function expectedEntryType(setup: TradeSetup, lastClose: number, tol: number): TradeSetup['entryType'] {
  if (lastClose >= setup.entryLow - tol && lastClose <= setup.entryHigh + tol) return 'MARKET';
  const zoneBelow = setup.entryHigh < lastClose;
  if (setup.direction === 'LONG') return zoneBelow ? 'LIMIT' : 'STOP';
  return zoneBelow ? 'STOP' : 'LIMIT';
}

export function validateTradePlan(
  raw: TradePlan,
  ctx: TradePlanContext,
): { ok: true; plan: TradePlan; warnings: string[] } | { ok: false; errors: string[] } {
  if (raw.decision === 'STAND_ASIDE' && !raw.reconsiderWhen.trim()) {
    return { ok: false, errors: ['tradePlan.reconsiderWhen: bắt buộc khi STAND_ASIDE (mức giá / sự kiện cần thấy để phân tích lại)'] };
  }
  const warnings: string[] = [];
  const tol = ctx.atr * MARKET_ZONE_ATR;
  const P = ctx.lastClose;

  const setups = raw.setups.flatMap((orig): TradeSetup[] => {
    const s: TradeSetup = { ...orig, takeProfits: [...orig.takeProfits] };
    const tag = `Setup "${s.name}" (${s.direction})`;
    if (s.entryLow > s.entryHigh) [s.entryLow, s.entryHigh] = [s.entryHigh, s.entryLow];
    const isLong = s.direction === 'LONG';

    // Chiều giá.
    const problems: string[] = [];
    if (isLong) {
      if (!(s.stopLoss < s.entryLow)) problems.push('LONG cần stopLoss < entryLow');
      if (!s.takeProfits.every(tp => tp > s.entryHigh)) problems.push('LONG cần mọi TP > entryHigh');
    } else {
      if (!(s.stopLoss > s.entryHigh)) problems.push('SHORT cần stopLoss > entryHigh');
      if (!s.takeProfits.every(tp => tp < s.entryLow)) problems.push('SHORT cần mọi TP < entryLow');
    }
    if (problems.length) {
      warnings.push(`Bỏ ${tag}: ${problems.join('; ')}`);
      return [];
    }
    s.takeProfits.sort((a, b) => (isLong ? a - b : b - a));
    const farTp = s.takeProfits.at(-1)!;

    // Giá hiện tại đã vô hiệu hoặc đã chạy hết setup. Agent khai báo STOP (chờ phá vỡ, vùng entry
    // phía trước giá) thì giá nằm ngoài SL nghĩa là chưa kích hoạt, không phải vô hiệu.
    const expected = expectedEntryType(s, P, tol);
    const pendingBreakout = s.entryType === 'STOP' && expected === 'STOP';
    if (!pendingBreakout && (isLong ? P <= s.stopLoss : P >= s.stopLoss)) {
      warnings.push(`Bỏ ${tag}: giá hiện tại ${P} đã vượt stopLoss ${s.stopLoss}`);
      return [];
    }
    if (isLong ? P >= farTp : P <= farTp) {
      warnings.push(`Bỏ ${tag}: giá hiện tại ${P} đã vượt TP xa nhất ${farTp}`);
      return [];
    }

    // R:R theo giữa vùng entry.
    const mid = entryMid(s);
    const risk = Math.abs(mid - s.stopLoss);
    const rr = r2(Math.abs(farTp - mid) / risk);
    const rrTp1 = r2(Math.abs(s.takeProfits[0]! - mid) / risk);
    if (orig.riskReward !== undefined && Math.abs(orig.riskReward - rr) > 0.05) {
      warnings.push(`${tag}: R:R agent gửi ${orig.riskReward} → server tính lại ${rr}`);
    }
    if (rr < ctx.minRiskReward) {
      warnings.push(`Bỏ ${tag}: R:R ${rr} < tối thiểu ${ctx.minRiskReward}`);
      return [];
    }
    s.riskReward = rr;
    s.riskRewardTp1 = rrTp1;

    // SL tầng 2 (tinh chỉnh khung nhỏ): chỉ tham khảo, không dùng cho ngưỡng R:R tối thiểu.
    if (s.refinedEntry) {
      const ref = { ...s.refinedEntry };
      const refAtr = ctx.atrByTf[ref.tf];
      if (tfSeconds(ref.tf) > tfSeconds(ctx.primaryTf)) {
        warnings.push(`${tag}: bỏ entry tinh chỉnh vì khung ${ref.tf} lớn hơn khung chính ${ctx.primaryTf}`);
        delete s.refinedEntry;
      } else if (!refAtr) {
        warnings.push(`${tag}: bỏ entry tinh chỉnh vì không có dữ liệu khung ${ref.tf}`);
        delete s.refinedEntry;
      } else {
        const minDist = REFINED_MIN_STOP_ATR * refAtr;
        if (ref.estStopDistance < minDist) {
          warnings.push(`${tag}: SL tinh chỉnh ${ref.estStopDistance} quá chặt (< ${REFINED_MIN_STOP_ATR} ATR ${ref.tf} = ${sig4(minDist)}) → nâng lên ${sig4(minDist)}`);
          ref.estStopDistance = sig4(minDist);
        }
        if (ref.estStopDistance >= risk) {
          warnings.push(`${tag}: bỏ entry tinh chỉnh vì SL ${ref.estStopDistance} không chặt hơn SL cấu trúc (${sig4(risk)})`);
          delete s.refinedEntry;
        } else {
          s.refinedEntry = {
            ...ref,
            atr: sig4(refAtr),
            riskReward: r2(Math.abs(farTp - mid) / ref.estStopDistance),
            riskRewardTp1: r2(Math.abs(s.takeProfits[0]! - mid) / ref.estStopDistance),
          };
        }
      }
    }

    // Loại lệnh so với vị trí giá.
    if (s.entryType === 'MARKET' && expected !== 'MARKET') {
      warnings.push(`${tag}: giá ${P} không ở vùng entry [${s.entryLow}, ${s.entryHigh}] → đổi MARKET thành ${expected}`);
      s.entryType = expected;
    } else if (s.entryType !== 'MARKET' && expected !== 'MARKET' && expected !== s.entryType) {
      warnings.push(`${tag}: vùng entry ${expected === 'LIMIT' ? 'cần giá hồi về' : 'cần giá phá vỡ'} → đổi ${s.entryType} thành ${expected}`);
      s.entryType = expected;
    }

    if (s.validUntil !== undefined && s.validUntil <= ctx.asOf) {
      warnings.push(`${tag}: bỏ validUntil vì không ở tương lai`);
      delete s.validUntil;
    }
    if (s.scenario !== undefined && !ctx.scenarioNames.includes(s.scenario)) {
      warnings.push(`${tag}: bỏ liên kết kịch bản "${s.scenario}" vì không tồn tại`);
      delete s.scenario;
    }

    // Ngược bias khung lớn: chỉ cảnh báo, không tự đổi quyết định.
    const against = ctx.topDown.filter(t => t.role === 'HTF' && t.bias === (isLong ? 'BEARISH' : 'BULLISH'));
    if (against.length) warnings.push(`${tag} ngược bias khung lớn ${against.map(t => t.tf).join(', ')}`);
    return [s];
  });

  // Hạ cấp quyết định khi không còn setup phù hợp.
  let decision = raw.decision;
  let reconsiderWhen = raw.reconsiderWhen;
  if (decision === 'ENTER' && !setups.some(s => s.entryType === 'MARKET')) {
    decision = setups.length ? 'WAIT_FOR_SETUP' : 'STAND_ASIDE';
    warnings.push(`Không còn setup vào ngay (MARKET) hợp lệ → quyết định ENTER chuyển ${decision}`);
  }
  if (decision === 'WAIT_FOR_SETUP' && !setups.length) {
    decision = 'STAND_ASIDE';
    warnings.push('Không còn setup hợp lệ → quyết định chuyển STAND_ASIDE');
  }
  if (decision === 'STAND_ASIDE' && !reconsiderWhen.trim()) {
    reconsiderWhen = `Phân tích lại khi xuất hiện setup đạt R:R ≥ ${ctx.minRiskReward}`;
  }
  // ENTER: đưa setup MARKET lên đầu (setup chính).
  if (decision === 'ENTER') setups.sort((a, b) => Number(b.entryType === 'MARKET') - Number(a.entryType === 'MARKET'));

  return { ok: true, plan: { ...raw, decision, reconsiderWhen, setups }, warnings };
}

/** Suy ra `action` (contract cũ) từ trade plan để lịch sử / code cũ vẫn dùng được. */
export function deriveAction(plan: TradePlan): TradeAction {
  const main = plan.setups[0];
  if (plan.decision === 'STAND_ASIDE' || !main) {
    const cond = [plan.reason, plan.reconsiderWhen && `Xem lại khi: ${plan.reconsiderWhen}`].filter(Boolean).join(' ');
    return { type: 'WAIT', takeProfits: [], condition: cond.slice(0, 500) };
  }
  const levels = {
    tf: main.tf,
    entry: entryMid(main),
    stopLoss: main.stopLoss,
    takeProfits: main.takeProfits,
    riskReward: main.riskReward,
  };
  const trigger = `${main.name} · ${main.trigger}${main.triggerNote ? `: ${main.triggerNote}` : ''}`;
  if (plan.decision === 'ENTER') return { type: main.direction, ...levels, condition: trigger.slice(0, 500) };
  return { type: 'WAIT', ...levels, condition: `Chờ ${trigger}`.slice(0, 500) };
}
