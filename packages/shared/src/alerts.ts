// Alert chạm vùng entry của setup (crypto). Contract server ↔ UI; không thuộc contract agent.

export const PRICE_ALERT_STATUSES = ['ARMED', 'TRIGGERED', 'INVALIDATED', 'EXPIRED', 'REPLACED', 'CANCELED'] as const;
export type PriceAlertStatus = (typeof PRICE_ALERT_STATUSES)[number];

export interface PriceAlert {
  id: number;
  analysisId: string;
  symbol: string;
  /** Vị trí setup trong `tradePlan.setups` (0 = chính). */
  setupIndex: number;
  direction: 'LONG' | 'SHORT';
  entryType: 'MARKET' | 'LIMIT' | 'STOP';
  /** Khung xác nhận entry của setup. */
  tf: string;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfits: number[];
  /** R:R server tính (đã qua validateSubmission). */
  riskReward?: number;
  /** Hạn hiệu lực (unix giây): `setup.validUntil` hoặc lúc đặt + PRICE_ALERT_MAX_AGE_H. */
  validUntil: number;
  /** Lúc đặt alert (unix giây) = lúc phân tích DONE. */
  armedAt: number;
  /** Giá lúc đặt (thiếu khi không lấy được). Giá lúc đặt đã vượt SL (vd STOP có SL nằm giữa giá và entry) → bỏ luật "chạm SL trước". */
  armPrice?: number;
  /** `time` của nến 1m cuối đã kiểm (unix giây). */
  checkedUntil?: number;
  status: PriceAlertStatus;
  /** Lúc đổi trạng thái gần nhất (unix giây). */
  statusAt: number;
  /** Giá lúc chạm (TRIGGERED) hoặc lúc chạm SL (INVALIDATED). */
  triggerPrice?: number;
  /** Ghi chú: "đang ở trong vùng entry", "đã chạm cả SL trong cùng nến", lý do huỷ… */
  note?: string;
}

export const PRICE_ALERT_STATUS_LABELS: Record<PriceAlertStatus, string> = {
  ARMED: 'đang canh',
  TRIGGERED: 'đã chạm',
  INVALIDATED: 'chạm SL trước',
  EXPIRED: 'hết hạn',
  REPLACED: 'có phân tích mới',
  CANCELED: 'đã tắt',
};
