import type { ChartAlert, PriceAlert, SetupHitTp } from './alerts.ts';
import type { AnalysisRecord } from './analysis.ts';

/** Sự kiện tiến trình gửi qua SSE. */
export type ProgressEvent =
  | { kind: 'status'; analysisId: string; status: AnalysisRecord['status']; message?: string }
  | { kind: 'step'; analysisId: string; message: string; at: number }
  | { kind: 'text'; analysisId: string; text: string; at: number }
  | { kind: 'result'; analysisId: string; record: AnalysisRecord }
  /** Alert chạm entry đổi trạng thái (chỉ gửi qua SSE chung `/api/events`). */
  | { kind: 'alert'; analysisId: string; alert: PriceAlert }
  /** Alert giá thủ công trên biểu đồ kích hoạt. */
  | { kind: 'chart_alert'; alert: ChartAlert; triggerPrice: number }
  /** Setup chạm mốc TP. */
  | { kind: 'setup_tp'; analysisId?: string; alertId: number; symbol: string; setupIndex?: number; tpIndex: number; price: number; riskReward: number; hitTps: SetupHitTp[]; isFinal?: boolean; at?: number }
  /** Setup chạm mốc SL. */
  | { kind: 'setup_sl'; analysisId?: string; alertId: number; symbol: string; setupIndex?: number; price: number; riskReward: number; at?: number };


