import { tfSeconds, type Timeframe } from '@wca/shared';

// Đếm ngược tới lúc nến đang chạy đóng (pure, test được).

/** Sau khi quá giờ đóng chừng này giây mà chưa có nến mới → ẩn (thị trường đóng cửa / mất kết nối). */
export const COUNTDOWN_GRACE_SEC = 5;
/** Chỉ hiệu chỉnh lệch giờ máy ↔ sàn khi lệch quá mức này (ms). */
export const SKEW_MIN_MS = 1000;

/** Mốc đóng (unix giây) của nến mở lúc `openTime`. */
export function closeTime(openTime: number, tf: Timeframe): number {
  return openTime + tfSeconds(tf);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `mm:ss` (< 1 giờ), `hh:mm:ss` (< 1 ngày), `Xd hh:mm` (≥ 1 ngày). */
export function formatCountdown(secLeft: number): string {
  const s = Math.max(0, Math.floor(secLeft));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}`;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

/** Nhãn đếm ngược cho nến cuối tại `nowSec`; null = ẩn. */
export function countdownLabel(lastOpenTime: number | undefined, tf: Timeframe, nowSec: number): string | null {
  if (lastOpenTime === undefined) return null;
  const left = closeTime(lastOpenTime, tf) - nowSec;
  if (left < -COUNTDOWN_GRACE_SEC) return null;
  // Nến mở trong tương lai (lệch giờ lớn) → không hiện số vô lý.
  if (left > tfSeconds(tf)) return null;
  return formatCountdown(left);
}

/** Cập nhật lệch giờ (giờ sàn − giờ máy, ms) có làm mượt; lệch nhỏ coi như 0. */
export function updateSkew(prev: number, eventMs: number, localMs: number): number {
  const sample = eventMs - localMs;
  const next = prev === 0 ? sample : prev * 0.8 + sample * 0.2;
  return Math.abs(next) < SKEW_MIN_MS ? 0 : next;
}
