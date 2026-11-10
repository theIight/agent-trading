import type { AnalysisRecord } from './analysis.ts';

/** Sự kiện tiến trình gửi qua SSE. */
export type ProgressEvent =
  | { kind: 'status'; analysisId: string; status: AnalysisRecord['status']; message?: string }
  | { kind: 'step'; analysisId: string; message: string; at: number }
  | { kind: 'text'; analysisId: string; text: string; at: number }
  | { kind: 'result'; analysisId: string; record: AnalysisRecord };
