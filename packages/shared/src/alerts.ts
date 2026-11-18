// Alert chạm vùng entry của setup (crypto). Contract server ↔ UI; không thuộc contract agent.

export const PRICE_ALERT_STATUSES = [
  'ARMED',
  'TRIGGERED',
  'TP_HIT',
  'SL_HIT',
  'CLOSED',
  'INVALIDATED',
  'EXPIRED',
  'REPLACED',
  'CANCELED',
] as const;
export type PriceAlertStatus = (typeof PRICE_ALERT_STATUSES)[number];

export interface SetupHitTp {
  index: number;
  price: number;
  time: number;
  riskReward: number;
  pnlPct?: number;
}

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
  /** Giá khớp entry thực tế. */
  entryPrice?: number;
  /** Thời gian khớp entry (unix giây). */
  entryAt?: number;
  /** Các mốc TP đã chạm sau khi khớp entry. */
  hitTps?: SetupHitTp[];
  /** R:R thực tế đạt được. */
  realizedRr?: number;
  /** Ghi chú: "đang ở trong vùng entry", "đã chạm cả SL trong cùng nến", lý do huỷ… */
  note?: string;
}

export const PRICE_ALERT_STATUS_LABELS: Record<PriceAlertStatus, string> = {
  ARMED: 'đang canh',
  TRIGGERED: 'đã khớp entry',
  TP_HIT: 'đã chạm TP',
  SL_HIT: 'chạm SL',
  CLOSED: 'hoàn thành',
  INVALIDATED: 'chạm SL trước',
  EXPIRED: 'hết hạn',
  REPLACED: 'có phân tích mới',
  CANCELED: 'đã tắt',
};

// ---------- Đánh giá hiệu quả Setup (Trade History & Performance) ----------

export const SETUP_OUTCOMES = ['OPEN', 'TP_FULL', 'TP_PARTIAL', 'SL_HIT'] as const;
export type SetupOutcome = (typeof SETUP_OUTCOMES)[number];

export interface SetupHistoryRecord {
  id: number;
  alertId: number;
  analysisId: string;
  symbol: string;
  setupIndex: number;
  direction: 'LONG' | 'SHORT';
  entryType: 'MARKET' | 'LIMIT' | 'STOP';
  tf: string;
  entryPrice: number;
  entryAt: number;
  stopLoss: number;
  takeProfits: number[];
  hitTps: SetupHitTp[];
  exitPrice?: number;
  exitAt?: number;
  status: SetupOutcome;
  realizedRr?: number;
  pnlPct?: number;
  note?: string;
}

export interface SetupPerformanceSummary {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  totalRealizedRr: number;
  avgRealizedRr: number;
}

// ---------- Alert giá thủ công trên biểu đồ (Chart Price Alert) ----------

export const CHART_ALERT_TYPES = ['once', 'every'] as const;
export type ChartAlertType = (typeof CHART_ALERT_TYPES)[number];

export const CHART_ALERT_STATUSES = ['ACTIVE', 'TRIGGERED', 'DISABLED'] as const;
export type ChartAlertStatus = (typeof CHART_ALERT_STATUSES)[number];

export interface ChartAlert {
  id: string;
  symbol: string;
  price: number;
  type: ChartAlertType;
  color: string;
  /** Độ đậm nhạt / độ trong suốt của màu (0.1 - 1.0). */
  opacity: number;
  status: ChartAlertStatus;
  createdAt: number;
  triggeredAt?: number | null;
  note?: string | null;
}

