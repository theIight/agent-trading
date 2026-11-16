/** Giá dạng số thô để dán vào sàn/Telegram: dấu `.` thập phân, không phân cách hàng nghìn. */
export function formatPriceForCopy(price: number, precision: number): string {
  const s = price.toFixed(Math.max(0, Math.min(12, Math.round(precision))));
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** Số lẻ theo độ lớn giá (BTC ≈ 0.1, altcoin nhỏ hơn); `fixed` = số lẻ cố định của instrument. */
export function pricePrecision(ref: number, fixed: number | null): number {
  if (fixed !== null) return fixed;
  return ref >= 1000 ? 1 : ref >= 10 ? 2 : ref >= 1 ? 4 : ref >= 0.01 ? 5 : 7;
}

/** Vị trí menu tại con trỏ, lật vào trong nếu tràn mép phải/dưới của khung. */
export function clampMenuPosition(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
  boxW: number,
  boxH: number,
): { left: number; top: number } {
  const left = x + menuW > boxW ? Math.max(0, x - menuW) : x;
  const top = y + menuH > boxH ? Math.max(0, y - menuH) : y;
  return { left, top };
}
