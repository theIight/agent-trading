import { z } from 'zod';
import { SUPPORTED_TFS } from './timeframes.ts';

// Contract trung tâm giữa agent (MCP) ↔ server ↔ UI. Mọi `time` là unix giây (UTC) = open time của nến.

export const WYCKOFF_EVENT_TYPES = [
  'PS', // Preliminary Support
  'PSY', // Preliminary Supply
  'SC', // Selling Climax
  'BC', // Buying Climax
  'AR', // Automatic Rally / Reaction
  'ST', // Secondary Test
  'ST_B', // Secondary Test trong Phase B
  'UT', // Upthrust
  'UTAD', // Upthrust After Distribution
  'SPRING',
  'SHAKEOUT',
  'TEST',
  'SOS', // Sign of Strength
  'SOW', // Sign of Weakness
  'LPS', // Last Point of Support
  'LPSY', // Last Point of Supply
  'BU', // Back-Up
  'JAC', // Jump Across the Creek
  'BOS', // Break of Structure
  'CHOCH', // Change of Character
  'OTHER',
] as const;
export type WyckoffEventType = (typeof WYCKOFF_EVENT_TYPES)[number];

/** Sự kiện mang tính cầu (bullish) hay cung (bearish) — dùng cho màu hiển thị. */
export const BULLISH_EVENTS: ReadonlySet<WyckoffEventType> = new Set([
  'PS', 'SC', 'ST', 'SPRING', 'SHAKEOUT', 'TEST', 'SOS', 'LPS', 'BU', 'JAC',
]);
export const BEARISH_EVENTS: ReadonlySet<WyckoffEventType> = new Set(['PSY', 'BC', 'UT', 'UTAD', 'SOW', 'LPSY']);

export const tfSchema = z.enum(SUPPORTED_TFS);
export const biasSchema = z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']);
export const phaseSchema = z.enum(['A', 'B', 'C', 'D', 'E']);
export const schematicSchema = z.enum(['ACCUMULATION', 'REACCUMULATION', 'DISTRIBUTION', 'REDISTRIBUTION', 'UNCLEAR']);

const unixSec = z.number().int().positive().describe('Unix time tính bằng giây (open time của nến)');
const price = z.number().positive();
const confidence = z.number().min(0).max(1);
const note = z.string().max(500);

export const wyckoffEventSchema = z.object({
  type: z.enum(WYCKOFF_EVENT_TYPES),
  tf: tfSchema,
  time: unixSec,
  price,
  confidence: confidence.default(0.6),
  note: note.default(''),
});

export const tradingRangeSchema = z.object({
  tf: tfSchema,
  start: unixSec,
  end: unixSec.describe('Thời điểm kết thúc range; có thể là nến hiện tại nếu range còn hiệu lực'),
  top: price,
  bottom: price,
  label: z.string().max(80).default('Trading Range'),
  creek: price.optional(),
  ice: price.optional(),
});

export const phaseSpanSchema = z.object({
  tf: tfSchema,
  phase: phaseSchema,
  start: unixSec,
  end: unixSec,
});

export const levelSchema = z.object({
  kind: z.enum(['SUPPORT', 'RESISTANCE', 'CREEK', 'ICE', 'INVALIDATION', 'TARGET']),
  price,
  tf: tfSchema.optional(),
  note: note.default(''),
});

export const scenarioSchema = z.object({
  name: z.string().min(1).max(80),
  probability: z.number().min(0).max(1),
  bias: biasSchema,
  path: z
    .array(z.object({ time: unixSec, price }))
    .min(2)
    .max(12)
    .describe('Đường giá dự kiến; điểm đầu nên là nến hiện tại, các điểm sau có thể ở tương lai'),
  trigger: note.default(''),
  invalidation: price,
  note: note.default(''),
});

export const tradeActionSchema = z.object({
  type: z.enum(['LONG', 'SHORT', 'WAIT']),
  tf: tfSchema.optional(),
  entry: price.optional(),
  stopLoss: price.optional(),
  takeProfits: z.array(price).max(3).default([]),
  /** Server tính lại; giá trị agent gửi bị ghi đè. */
  riskReward: z.number().optional(),
  condition: note.default(''),
});

/** Sự kiện Wyckoff (hoặc phá vỡ) cần thấy để kích hoạt setup. */
export const SETUP_TRIGGERS = [
  'SPRING', 'SHAKEOUT', 'TEST', 'LPS', 'BU', 'JAC', 'SOS',
  'UT', 'UTAD', 'LPSY', 'SOW', 'BREAKOUT', 'BREAKDOWN', 'OTHER',
] as const;

/** Tín hiệu kích hoạt trên khung nhỏ khi tinh chỉnh entry. */
export const REFINED_TRIGGERS = [...SETUP_TRIGGERS, 'CHOCH'] as const;

/** SL tầng 2: entry tinh chỉnh trên khung nhỏ khi giá vào vùng entry. SL là ước lượng khoảng cách. */
export const refinedEntrySchema = z.object({
  tf: tfSchema.describe('Khung tinh chỉnh, ≤ khung chính (thường 1m hoặc 5m)'),
  trigger: z.enum(REFINED_TRIGGERS),
  condition: note.describe('Tín hiệu cần thấy trên khung nhỏ, vd "UT 1m quét trên 75.2k rồi CHoCH xuống, volume giảm"'),
  stopRule: note.describe('Cách đặt SL, vd "Trên đỉnh UT 1m + 0.3 ATR(1m)"'),
  estStopDistance: z.number().positive().describe('Khoảng cách entry → SL tinh chỉnh ước lượng (đơn vị giá)'),
  /** Server điền: ATR14 của `tf` tại asOf. */
  atr: z.number().optional(),
  /** Server tính: |TP xa nhất − giữa vùng entry| / estStopDistance. */
  riskReward: z.number().optional(),
  riskRewardTp1: z.number().optional(),
});

export const tradeSetupSchema = z.object({
  name: z.string().min(1).max(80).describe('Tên ngắn, vd "Short LPSY retest Ice"'),
  direction: z.enum(['LONG', 'SHORT']),
  entryType: z
    .enum(['MARKET', 'LIMIT', 'STOP'])
    .describe('MARKET = vào ngay ở giá hiện tại; LIMIT = chờ giá hồi về vùng entry; STOP = chờ giá phá vỡ lên/xuống vùng entry'),
  tf: tfSchema.describe('Khung xác nhận entry'),
  trigger: z.enum(SETUP_TRIGGERS),
  triggerNote: note.default('').describe('Điều kiện kích hoạt cụ thể: volume, spread, vị trí đóng cửa'),
  entryLow: price,
  entryHigh: price.describe('Bằng entryLow nếu entry là một giá'),
  stopLoss: price,
  takeProfits: z.array(price).min(1).max(3),
  validUntil: unixSec.optional().describe('Hết hạn setup (tương lai); quá hạn chưa kích hoạt thì huỷ'),
  scenario: z.string().max(80).optional().describe('Tên kịch bản trong scenarios mà setup dựa vào'),
  confidence: confidence.default(0.5),
  rationale: note.default(''),
  /** Server tính (giữa vùng entry → TP xa nhất); giá trị agent gửi bị ghi đè. */
  riskReward: z.number().optional(),
  /** Server tính (giữa vùng entry → TP1). */
  riskRewardTp1: z.number().optional(),
  refinedEntry: refinedEntrySchema.optional().describe('SL tầng 2 trên khung nhỏ (tuỳ chọn); không thay thế stopLoss cấu trúc'),
});

export const TRADE_DECISIONS = ['ENTER', 'WAIT_FOR_SETUP', 'STAND_ASIDE'] as const;

export const tradePlanSchema = z.object({
  decision: z
    .enum(TRADE_DECISIONS)
    .describe('ENTER = vào lệnh ngay (cần setup MARKET); WAIT_FOR_SETUP = chờ setup kích hoạt; STAND_ASIDE = đứng ngoài'),
  reason: z.string().min(1).max(1000).describe('Lý do quyết định (tiếng Việt)'),
  reconsiderWhen: note.default('').describe('Bắt buộc khi STAND_ASIDE: mức giá / sự kiện cần thấy để phân tích lại'),
  setups: z.array(tradeSetupSchema).max(2).default([]).describe('Tối đa 2: setup chính (thuận khung lớn) + phương án B'),
});

// ---------- Order flow từ ảnh Bookmap (tuỳ chọn, chỉ khi người dùng gửi ảnh) ----------

/** Ảnh Bookmap: `htf` = khung lớn (zoom rộng), `ltf` = khung bé (zoom hẹp). */
export const BOOKMAP_IMAGE_ROLES = ['htf', 'ltf'] as const;
export type BookmapImageRole = (typeof BOOKMAP_IMAGE_ROLES)[number];

export const ORDERFLOW_LEVEL_KINDS = ['ASK_WALL', 'BID_WALL', 'POC', 'HVN', 'LVN', 'ABSORPTION', 'AGGRESSION'] as const;
export type OrderflowLevelKind = (typeof ORDERFLOW_LEVEL_KINDS)[number];

/**
 * Ảnh Bookmap: COB = lệnh chờ trong sổ lệnh lúc chụp; SVP = volume đã khớp trong phiên; BUBBLE = lệnh market lớn.
 * Binance (server tự tính): BOOK = lệnh chờ trong sổ lệnh; VOLUME = volume đã khớp (profile); TRADES = lệnh market lớn.
 */
export const ORDERFLOW_SIZE_SOURCES = ['COB', 'SVP', 'BUBBLE', 'BOOK', 'VOLUME', 'TRADES'] as const;

/** Nguồn order flow của một phân tích. */
export const ORDERFLOW_SOURCES = ['bookmap-image', 'binance'] as const;
export type OrderflowSource = (typeof ORDERFLOW_SOURCES)[number];

const bookmapImageSchema = z.enum(BOOKMAP_IMAGE_ROLES);

export const orderflowLevelSchema = z.object({
  kind: z.enum(ORDERFLOW_LEVEL_KINDS),
  /** Bắt buộc với nguồn ảnh Bookmap; mức Binance do server tính không có. */
  image: bookmapImageSchema.optional().describe('Ảnh đọc được mức này: htf (khung lớn) | ltf (khung bé)'),
  bookmapPrice: price.optional().describe('Giá đúng như trên trục Bookmap, CHƯA quy đổi offset'),
  /** Server điền = bookmapPrice − offset (giá trên chart của app); Binance: giá spot − basis. */
  price: price.optional(),
  /** Binance: giá gốc trên sổ lệnh spot (chưa trừ basis). */
  sourcePrice: price.optional(),
  /** Binance: tường đã đứng liên tục bao nhiêu phút (server tính). */
  persistMin: z.number().nonnegative().optional(),
  size: z.number().positive().optional().describe('Khối lượng in trên ảnh (COB/SVP). Không có số thì bỏ trống, không ước từ màu heatmap'),
  sizeSource: z.enum(ORDERFLOW_SIZE_SOURCES).optional(),
  strength: confidence.default(0.5),
  note: note.default(''),
});

export const orderflowSchema = z.object({
  lastPrices: z
    .array(z.object({ image: bookmapImageSchema, bookmapPrice: price }))
    .max(2)
    .default([])
    .describe('Giá cuối (ô giá hiện tại) đọc trên từng ảnh — để server kiểm tra ảnh cũ'),
  summary: z.string().min(1).max(1000).describe('Nhận xét order flow (tiếng Việt): hấp thụ, tường thanh khoản, CVD'),
  levels: z.array(orderflowLevelSchema).max(12).default([]),
  cvd: note.default(''),
  /** Server điền: offset đã dùng để quy đổi. */
  offset: z.number().optional(),
  /** Server điền: giá cuối đọc trên ảnh − giá app lúc chụp. */
  measuredOffset: z.number().optional(),
  /** Server điền: nguồn dữ liệu (thiếu = ảnh Bookmap, bản ghi cũ). */
  source: z.enum(ORDERFLOW_SOURCES).optional(),
  /** Server điền (Binance): thời điểm lấy dữ liệu, unix giây. */
  asOf: z.number().optional(),
  /** Server điền (Binance): số phút lịch sử sổ lệnh đã ghi tới lúc lấy. */
  historyMin: z.number().optional(),
});

export const topDownStepSchema = z.object({
  tf: tfSchema,
  role: z.enum(['HTF', 'PRIMARY', 'LTF']),
  bias: biasSchema,
  phase: phaseSchema.nullable().default(null),
  schematic: schematicSchema.default('UNCLEAR'),
  note: note.default(''),
});

/** Dữ liệu agent nộp qua tool `submit_analysis`. */
export const analysisSubmissionSchema = z.object({
  symbol: z.string().min(2).max(30),
  primaryTf: tfSchema,
  schematic: schematicSchema,
  currentPhase: phaseSchema.nullable(),
  bias: biasSchema,
  confidence,
  summary: z.string().min(1).max(4000).describe('Tóm tắt phân tích bằng tiếng Việt'),
  topDown: z.array(topDownStepSchema).min(1).describe('Kết luận từng khung, thứ tự từ khung lớn → khung nhỏ'),
  events: z.array(wyckoffEventSchema).max(60).default([]),
  ranges: z.array(tradingRangeSchema).max(6).default([]),
  phases: z.array(phaseSpanSchema).max(10).default([]),
  levels: z.array(levelSchema).max(20).default([]),
  scenarios: z.array(scenarioSchema).max(3).default([]),
  tradePlan: tradePlanSchema,
  /** Không còn do agent gửi: server suy ra từ `tradePlan` (giữ để tương thích bản ghi cũ). */
  action: tradeActionSchema.optional(),
  tfConflicts: z.array(note).max(10).default([]),
  /** Chỉ khi phân tích có order flow (ảnh Bookmap hoặc Binance). */
  orderflow: orderflowSchema.optional(),
});

export type AnalysisSubmissionInput = z.input<typeof analysisSubmissionSchema>;
export type AnalysisSubmission = z.output<typeof analysisSubmissionSchema>;
export type WyckoffEvent = z.output<typeof wyckoffEventSchema>;
export type TradingRange = z.output<typeof tradingRangeSchema>;
export type PhaseSpan = z.output<typeof phaseSpanSchema>;
export type Level = z.output<typeof levelSchema>;
export type Scenario = z.output<typeof scenarioSchema>;
export type TradeAction = z.output<typeof tradeActionSchema>;
export type TopDownStep = z.output<typeof topDownStepSchema>;
export type TradeSetup = z.output<typeof tradeSetupSchema>;
export type TradePlan = z.output<typeof tradePlanSchema>;
export type RefinedEntry = z.output<typeof refinedEntrySchema>;
export type TradeDecision = (typeof TRADE_DECISIONS)[number];
export type Orderflow = z.output<typeof orderflowSchema>;
export type OrderflowLevel = z.output<typeof orderflowLevelSchema>;

/** Bản nộp sau khi validate: `action` luôn có (suy ra từ `tradePlan`). */
export type ValidatedSubmission = Omit<AnalysisSubmission, 'action'> & { action: TradeAction };

/** Kết quả đã validate + lưu trữ. */
export interface AnalysisResult extends Omit<ValidatedSubmission, 'tradePlan'> {
  /** Thiếu ở bản ghi cũ (trước khi có trade setup) — khi đó dùng `action`. */
  tradePlan?: TradePlan;
  id: string;
  createdAt: number;
  /** Các khung agent được giao, thứ tự top-down. */
  tfs: string[];
  /** Thời điểm nến đóng cuối cùng của khung chính khi phân tích (anchor cho action/scenario). */
  asOf: number;
  model?: string;
  /** Những chỗ validator đã sửa hoặc loại bỏ. */
  warnings: string[];
}

export type AnalysisStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELED';

export interface AnalysisRecord {
  id: string;
  symbol: string;
  primaryTf: string;
  tfs: string[];
  /** Agent chạy phân tích (bản ghi cũ: không có = claude-code). */
  runner?: string;
  /** Model người dùng chọn (không có = mặc định). */
  model?: string;
  /** Phân tích có kèm ảnh Bookmap. */
  bookmap?: boolean;
  /** Nguồn order flow (thiếu: suy ra từ `bookmap`). */
  orderflowSource?: OrderflowSource;
  status: AnalysisStatus;
  createdAt: number;
  finishedAt?: number;
  result?: AnalysisResult;
  error?: string;
}
