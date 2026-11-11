import type { InstrumentInfo, RunnerId, RunnerModel, TfPlanEntry, Timeframe } from '@wca/shared';

export interface AgentRunRequest {
  analysisId: string;
  symbol: string;
  primaryTf: Timeframe;
  plan: TfPlanEntry[];
  barsPerTf: number;
  hasScreenshot: boolean;
  /** Có ảnh Bookmap (order flow) → agent gọi get_bookmap_images. */
  hasBookmap?: boolean;
  /** Model người dùng chọn; không có thì dùng mặc định của runner. */
  model?: string;
  /** Nguồn dữ liệu / loại volume của symbol (vàng OANDA: tick volume). */
  instrument?: InstrumentInfo;
}

export interface AgentRunHooks {
  onStep: (message: string) => void;
  onText: (text: string) => void;
  onModel?: (model: string) => void;
  signal: AbortSignal;
}

export interface AgentRunOutcome {
  ok: boolean;
  /** Văn bản kết quả cuối cùng của agent (nếu có). */
  resultText?: string;
  error?: string;
  costUsd?: number;
  durationMs?: number;
}

/** Interface chung cho mọi agent (Claude Code, Antigravity, sau này Claude API…). */
export interface AgentRunner {
  readonly id: RunnerId;
  readonly label: string;
  readonly defaultModel?: string;
  readonly supportsScreenshot: boolean;
  /** Nhận được ảnh Bookmap qua MCP. */
  readonly supportsBookmap: boolean;
  /** Binary có chạy được không (kiểm tra lần đầu rồi nhớ). */
  availability(): { available: boolean; reason?: string };
  listModels(): Promise<RunnerModel[]>;
  run(req: AgentRunRequest, hooks: AgentRunHooks): Promise<AgentRunOutcome>;
}

/** Item chung sau khi parse output stream của một CLI agent. */
export type ParsedItem =
  | { kind: 'step'; message: string }
  | { kind: 'text'; text: string }
  | { kind: 'model'; model: string }
  | { kind: 'result'; ok: boolean; text?: string; error?: string; costUsd?: number; durationMs?: number };
