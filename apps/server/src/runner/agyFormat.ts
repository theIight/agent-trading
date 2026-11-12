import {
  analysisSubmissionSchema,
  levelSchema,
  ORDERFLOW_LEVEL_KINDS,
  ORDERFLOW_SIZE_SOURCES,
  orderflowLevelSchema,
  orderflowSchema,
  phaseSpanSchema,
  REFINED_TRIGGERS,
  refinedEntrySchema,
  scenarioSchema,
  SETUP_TRIGGERS,
  SUBMISSION_EXAMPLE,
  topDownStepSchema,
  tradePlanSchema,
  tradeSetupSchema,
  tradingRangeSchema,
  WYCKOFF_EVENT_TYPES,
  wyckoffEventSchema,
} from '@wca/shared';
import type { z } from 'zod';
import type { AgentRunRequest } from './types.ts';

// Hướng dẫn định dạng cho agy: model (nhất là Gemini Flash) không thấy JSON schema của tool MCP
// nên hay bỏ trường "hiển nhiên" (symbol, primaryTf, scenario.bias) hoặc chép giá trị từ ví dụ.

type AnyObject = z.ZodObject<z.ZodRawShape>;

/** Trường bắt buộc của một object schema (không optional, không có default). */
export function requiredKeys(schema: AnyObject): string[] {
  return Object.entries(schema.shape)
    .filter(([, s]) => !(s as z.ZodType).safeParse(undefined).success)
    .map(([k]) => k);
}

const OBJECTS: [string, AnyObject][] = [
  ['analysis (cấp ngoài)', analysisSubmissionSchema as unknown as AnyObject],
  ['topDown[]', topDownStepSchema as unknown as AnyObject],
  ['events[]', wyckoffEventSchema as unknown as AnyObject],
  ['ranges[]', tradingRangeSchema as unknown as AnyObject],
  ['phases[]', phaseSpanSchema as unknown as AnyObject],
  ['levels[]', levelSchema as unknown as AnyObject],
  ['scenarios[]', scenarioSchema as unknown as AnyObject],
  ['tradePlan', tradePlanSchema as unknown as AnyObject],
  ['tradePlan.setups[]', tradeSetupSchema as unknown as AnyObject],
  ['setups[].refinedEntry', refinedEntrySchema as unknown as AnyObject],
  ['orderflow (chỉ khi có ảnh Bookmap hoặc order flow Binance)', orderflowSchema as unknown as AnyObject],
  ['orderflow.levels[]', orderflowLevelSchema as unknown as AnyObject],
];

export const REQUIRED_FIELDS_TEXT = OBJECTS.map(([name, s]) => `- ${name}: ${requiredKeys(s).join(', ')}`).join('\n');

export const SUBMIT_FORMAT_APPENDIX = [
  '## Định dạng submit_analysis (bắt buộc đúng cấu trúc)',
  '',
  'Gọi `call_mcp_tool` với ServerName `wyckoff`, ToolName `submit_analysis`, Arguments = `{ "analysisId": "<id được giao>", "analysis": { ... } }`.',
  '',
  '### Trường BẮT BUỘC (thiếu một trường là bị từ chối)',
  REQUIRED_FIELDS_TEXT,
  '- scenarios[].path: 2–12 điểm `{ "time", "price" }`; mỗi kịch bản PHẢI có `bias` và `invalidation`.',
  '',
  '### Giá trị hợp lệ',
  '- tf (mọi chỗ): 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w — viết thường.',
  '- schematic: ACCUMULATION, REACCUMULATION, DISTRIBUTION, REDISTRIBUTION, UNCLEAR. bias (cả analysis, topDown và scenarios): BULLISH, BEARISH, NEUTRAL. phase/currentPhase: A, B, C, D, E hoặc null.',
  `- events[].type: ${WYCKOFF_EVENT_TYPES.join(', ')}`,
  '- topDown[].role: HTF, PRIMARY, LTF. levels[].kind: SUPPORT, RESISTANCE, CREEK, ICE, INVALIDATION, TARGET.',
  '- tradePlan.decision: ENTER, WAIT_FOR_SETUP, STAND_ASIDE. setups[].direction: LONG, SHORT. setups[].entryType: MARKET, LIMIT, STOP.',
  `- setups[].trigger: ${SETUP_TRIGGERS.join(', ')}. refinedEntry.trigger: ${REFINED_TRIGGERS.join(', ')}`,
  `- orderflow.levels[].kind: ${ORDERFLOW_LEVEL_KINDS.join(', ')}. image / lastPrices[].image: htf, ltf. sizeSource: ${ORDERFLOW_SIZE_SOURCES.join(', ')}. Không gửi price/offset/measuredOffset (server tự tính). Với ảnh Bookmap, mỗi levels[] bắt buộc có image và bookmapPrice. Với order flow Binance chỉ gửi summary + cvd (server tự gắn levels).`,
  '- summary ≥ 80 ký tự, mỗi topDown[].note ≥ 15 ký tự, tradePlan.reason ≥ 20 ký tự; không dùng placeholder ("test", "todo"…). schematic khác UNCLEAR thì events phải có ít nhất 1 phần tử.',
  '',
  '### Ví dụ cấu trúc (KHÔNG chép giá trị — mọi time/giá/nội dung phải lấy từ dữ liệu thật của bạn)',
  '```json',
  JSON.stringify(SUBMISSION_EXAMPLE),
  '```',
].join('\n');

/** Khung JSON điền sẵn cho đúng lượt chạy: agent chỉ việc thay các chỗ <...>. */
export function buildAgySkeleton(req: Pick<AgentRunRequest, 'analysisId' | 'symbol' | 'primaryTf' | 'plan' | 'hasBookmap' | 'hasBinanceOrderflow'>): string {
  const skeleton = {
    analysisId: req.analysisId,
    analysis: {
      symbol: req.symbol,
      primaryTf: req.primaryTf,
      schematic: '<ACCUMULATION|REACCUMULATION|DISTRIBUTION|REDISTRIBUTION|UNCLEAR>',
      currentPhase: '<A|B|C|D|E|null>',
      bias: '<BULLISH|BEARISH|NEUTRAL>',
      confidence: '<0..1>',
      summary: '<≥ 80 ký tự tiếng Việt>',
      topDown: req.plan.map(p => ({ tf: p.tf, role: p.role, bias: '<BULLISH|BEARISH|NEUTRAL>', phase: '<A-E|null>', schematic: '<...>', note: '<≥ 15 ký tự>' })),
      events: ['<{type, tf, time, price, confidence, note}>'],
      ranges: ['<{tf, start, end, top, bottom, label, creek?, ice?}>'],
      phases: ['<{tf, phase, start, end}>'],
      levels: ['<{kind, price, tf, note}>'],
      scenarios: ['<{name, probability, bias, path:[{time, price}…], trigger, invalidation, note}>'],
      tradePlan: { decision: '<ENTER|WAIT_FOR_SETUP|STAND_ASIDE>', reason: '<≥ 20 ký tự>', reconsiderWhen: '<bắt buộc nếu STAND_ASIDE>', setups: ['<0–2 setup>'] },
      tfConflicts: [],
      ...(req.hasBookmap
        ? {
            orderflow: {
              lastPrices: ['<{image: htf|ltf, bookmapPrice: giá cuối trên ảnh}>'],
              summary: '<nhận xét order flow tiếng Việt>',
              levels: ['<{kind, image, bookmapPrice, size?, sizeSource?, strength, note}>'],
              cvd: '<diễn biến CVD>',
            },
          }
        : req.hasBinanceOrderflow
          ? { orderflow: { summary: '<nhận xét order flow Binance tiếng Việt>', cvd: '<diễn biến CVD>' } }
          : {}),
    },
  };
  return JSON.stringify(skeleton, null, 1);
}

/** Nhắc lại ràng buộc của lần chạy + khung điền sẵn + checklist trước khi nộp. */
export function buildAgyPromptSuffix(req: Pick<AgentRunRequest, 'analysisId' | 'symbol' | 'primaryTf' | 'plan' | 'barsPerTf' | 'hasBookmap' | 'hasBinanceOrderflow'>): string {
  return [
    '',
    `Đọc get_features + get_klines với limit ${req.barsPerTf} cho TỪNG khung trước khi nộp; chỉ nộp một lần khi đã hoàn tất.`,
    '',
    'Khi nộp, dùng ĐÚNG khung Arguments dưới đây (giữ nguyên analysisId, symbol, primaryTf và tf/role của topDown; thay mọi chỗ <...> bằng kết quả thật, không để sót):',
    '```json',
    buildAgySkeleton(req),
    '```',
    `Checklist trước khi gọi submit_analysis: (1) analysis.symbol = "${req.symbol}" — LỖI HAY GẶP NHẤT là quên trường symbol, analysisId KHÔNG thay thế được symbol; analysis.primaryTf = "${req.primaryTf}"; (2) topDown đủ ` +
      `${req.plan.length} khung, đúng thứ tự; (3) mọi scenario có bias + invalidation + path ≥ 2 điểm; (4) mọi event có type, tf, time (unix từ get_klines), price; ` +
      '(5) không còn chuỗi "<...>" nào; (6) không chép số liệu từ ví dụ trong system prompt.',
  ].join('\n');
}
