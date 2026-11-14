import { isTimeframe, roleOf, sortTopDown, type AnalysisRecord, type AnalysisResult, type TradeSetup } from '@wca/shared';

// Nội dung tin nhắn Telegram (HTML parse mode) cho kết quả phân tích. Pure, không gọi mạng.

/** Giới hạn caption ảnh của Telegram. */
export const CAPTION_LIMIT = 1024;
/** Giới hạn tin nhắn chữ của Telegram. */
export const MESSAGE_LIMIT = 4096;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const fmtPrice = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 1 : p >= 1 ? 3 : 6 });

const DECISIONS: Record<string, string> = { ENTER: 'Vào lệnh', WAIT_FOR_SETUP: 'Chờ setup', STAND_ASIDE: 'Đứng ngoài' };
const SCHEMATICS: Record<string, string> = {
  ACCUMULATION: 'Accumulation',
  REACCUMULATION: 'Re-accumulation',
  DISTRIBUTION: 'Distribution',
  REDISTRIBUTION: 'Re-distribution',
};

/** "12:34 14/11" theo múi giờ (không phụ thuộc định dạng locale của Node). */
export function fmtTime(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')} ${get('day')}/${get('month')}`;
}

function setupLine(s: TradeSetup, i: number): string {
  const entry = s.entryLow === s.entryHigh ? fmtPrice(s.entryLow) : `${fmtPrice(s.entryLow)}–${fmtPrice(s.entryHigh)}`;
  const rr = s.riskReward !== undefined ? ` · R:R ${s.riskReward.toFixed(2)}` : '';
  return `${['①', '②', '③'][i] ?? `${i + 1}.`} <b>${s.direction}</b> ${s.entryType} ${s.tf} · Entry ${entry} · SL ${fmtPrice(s.stopLoss)} · TP ${s.takeProfits.map(fmtPrice).join(' / ')}${rr}`;
}

/** Các dòng kế hoạch giao dịch (đã escape). Bản ghi cũ không có `tradePlan` → dùng `action`. */
function planLines(r: AnalysisResult): string[] {
  const plan = r.tradePlan;
  if (plan) {
    const out = [`Quyết định: <b>${DECISIONS[plan.decision] ?? plan.decision}</b>`];
    plan.setups.forEach((s, i) => out.push(setupLine(s, i)));
    if (plan.decision === 'STAND_ASIDE' && plan.reconsiderWhen) out.push(`Xem lại khi: ${escapeHtml(plan.reconsiderWhen)}`);
    return out;
  }
  const a = r.action;
  if (a.type === 'WAIT') return [`Hành động: <b>WAIT</b>${a.condition ? ` · ${escapeHtml(a.condition)}` : ''}`];
  const parts = [`<b>${a.type}</b>`];
  if (a.entry !== undefined) parts.push(`Entry ${fmtPrice(a.entry)}`);
  if (a.stopLoss !== undefined) parts.push(`SL ${fmtPrice(a.stopLoss)}`);
  if (a.takeProfits.length) parts.push(`TP ${a.takeProfits.map(fmtPrice).join(' / ')}`);
  if (a.riskReward !== undefined) parts.push(`R:R ${a.riskReward.toFixed(2)}`);
  return [`Hành động: ${parts.join(' · ')}`];
}

/** Cắt văn bản thô sao cho bản escape dài ≤ `max` (thêm "…" khi cắt); cắt trên văn bản thô nên không bao giờ hỏng entity. */
export function fitEscaped(text: string, max: number): string {
  const t = text.trim();
  if (max <= 0) return '';
  const full = escapeHtml(t);
  if (full.length <= max) return full;
  // Tìm nhị phân độ dài thô lớn nhất còn vừa.
  const fits = (n: number) => escapeHtml(t.slice(0, n).trimEnd()).length + 1 <= max;
  let lo = 0;
  let hi = Math.min(t.length, max);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${escapeHtml(t.slice(0, lo).trimEnd())}…` : '';
}

export interface FormatOptions {
  /** Múi giờ hiển thị (mặc định của máy chủ). */
  timeZone?: string;
}

/** Caption ảnh đầu album: dòng tiêu đề, bias, kế hoạch luôn giữ; tóm tắt cắt cho vừa `limit`. */
export function formatCaption(rec: AnalysisRecord, opts: FormatOptions = {}, limit = CAPTION_LIMIT): string {
  const r = rec.result;
  const tfs = r?.tfs ?? rec.tfs;
  const head = [`<b>${escapeHtml(rec.symbol)} · ${escapeHtml(rec.primaryTf)}</b>${tfs.length > 1 ? ` (${tfs.map(escapeHtml).join(' → ')})` : ''}`];
  if (!r) return head.join('\n');
  const ctx = [`${r.bias} ${Math.round(r.confidence * 100)}%`];
  if (r.currentPhase) ctx.push(`Pha ${r.currentPhase}`);
  if (SCHEMATICS[r.schematic]) ctx.push(SCHEMATICS[r.schematic]!);
  head.push(ctx.join(' · '), ...planLines(r));
  const foot = [r.model, fmtTime(rec.finishedAt ?? r.createdAt, opts.timeZone)].filter(Boolean).map(s => escapeHtml(String(s))).join(' · ');
  let fixed = [...head, '', foot].join('\n');
  // Phần cố định quá dài (hiếm) → bỏ dần dòng cuối (không cắt giữa thẻ HTML).
  while (fixed.length > limit && head.length > 1) {
    head.pop();
    fixed = [...head, '', foot].join('\n');
  }
  if (fixed.length > limit) return '';
  const room = limit - fixed.length - 1;
  const summary = fitEscaped(r.summary, room);
  return summary ? [...head, '', summary, foot].join('\n') : fixed;
}

/** Tin nhắn khi phân tích lỗi. */
export function formatFailure(rec: AnalysisRecord, opts: FormatOptions = {}): string {
  const err = fitEscaped(rec.error ?? 'Không rõ lỗi', 300);
  return `❌ <b>${escapeHtml(rec.symbol)} · ${escapeHtml(rec.primaryTf)}</b> phân tích lỗi (${fmtTime(rec.finishedAt ?? rec.createdAt, opts.timeZone)})\n${err}`;
}

/** Khung cần chụp: top-down (lớn → nhỏ); `primary` → chỉ khung chính. Bỏ giá trị không phải khung hợp lệ. */
export function snapshotTfs(rec: AnalysisRecord, mode: 'all' | 'primary'): string[] {
  if (mode === 'primary') return isTimeframe(rec.primaryTf) ? [rec.primaryTf] : [];
  const tfs = (rec.result?.tfs ?? rec.tfs).filter(isTimeframe);
  return sortTopDown([...new Set(tfs)]);
}

/** Lớp ẩn ở ảnh khung lớn (HTF): Setup + Mức giá — ảnh khung lớn chỉ giữ bối cảnh. */
export const HTF_HIDDEN_LAYERS = ['action', 'levels'] as const;

export interface SnapshotShot {
  tf: string;
  /** Lớp kết quả ẩn trên ảnh (tham số `hide` của trang `?snapshot=`). */
  hide: string[];
}

/** Lớp cần ẩn cho ảnh khung `tf`: khung lớn hơn khung chính → Setup + Mức giá; còn lại giữ đủ. */
export function snapshotHiddenLayers(tf: string, primaryTf: string): string[] {
  if (!isTimeframe(tf) || !isTimeframe(primaryTf)) return [];
  return roleOf(tf, primaryTf) === 'HTF' ? [...HTF_HIDDEN_LAYERS] : [];
}

/** Danh sách ảnh cần chụp (top-down) kèm lớp ẩn theo vai trò khung. */
export function snapshotShots(rec: AnalysisRecord, mode: 'all' | 'primary'): SnapshotShot[] {
  return snapshotTfs(rec, mode).map(tf => ({ tf, hide: snapshotHiddenLayers(tf, rec.primaryTf) }));
}
