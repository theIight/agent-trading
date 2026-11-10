// Agent phân tích có thể chọn khi bấm Analyze.

export const RUNNER_IDS = ['claude-code', 'agy'] as const;
export type RunnerId = (typeof RUNNER_IDS)[number];

export const isRunnerId = (v: unknown): v is RunnerId => typeof v === 'string' && (RUNNER_IDS as readonly string[]).includes(v);

export interface RunnerModel {
  id: string;
  label: string;
}

/** Thông tin runner cho UI (`GET /api/runners`). */
export interface RunnerInfo {
  id: RunnerId;
  label: string;
  /** Binary có trong PATH và chạy được. */
  available: boolean;
  /** Lý do không khả dụng (nếu có). */
  reason?: string;
  /** Model dùng khi người dùng để "Mặc định" (undefined = mặc định của CLI). */
  defaultModel?: string;
  models: RunnerModel[];
  /** Agent nhận được ảnh chart qua MCP hay không. */
  supportsScreenshot: boolean;
}
