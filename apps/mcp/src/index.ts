// MCP server (stdio) cho Claude Code: cung cấp dữ liệu nến, đặc trưng Wyckoff và tool nộp kết quả.
// Chạy: node --import tsx apps/mcp/src/index.ts (được khai báo trong .mcp.json).
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { analysisSubmissionSchema, normalizeSymbol, RUN_CONTEXT_ENV, SUPPORTED_TFS, type KlinesResponse } from '@wca/shared';
import { computeFeatures } from '../../server/src/features/index.ts';
import { formatKlinesCsv, MIN_BARS, resolveKlineArgs, resolveParam } from './format.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SERVER_URL = process.env.WCA_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const DEFAULT_BARS = Number(process.env.AGENT_BARS_PER_TF ?? 300);


function internalToken(): string {
  if (process.env.WCA_INTERNAL_TOKEN) return process.env.WCA_INTERNAL_TOKEN;
  try {
    return fs.readFileSync(path.join(ROOT, 'data', 'internal-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function call<T>(urlPath: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}${urlPath}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-wca-token': internalToken(), ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`Không kết nối được server ${SERVER_URL} (đã chạy "npm run dev" chưa?): ${(err as Error).message}`, { cause: err });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function loadKlines(symbol: string, tf: string, limit: number, endTime?: number): Promise<KlinesResponse> {
  const params = new URLSearchParams({ symbol: normalizeSymbol(symbol), tf, limit: String(limit), closedOnly: 'true' });
  if (endTime) params.set('endTime', String(endTime));
  return call<KlinesResponse>(`/api/klines?${params}`);
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

// tf nhận cả chữ hoa (1D, 4H…) rồi chuẩn hoá; kiểm tra trong handler.
const tfArg = z.string().describe(`Khung thời gian: ${SUPPORTED_TFS.join(', ')}`);
const klineArgs = {
  symbol: z.string().optional().describe('Ví dụ BTCUSDT (bỏ trống = symbol của phân tích đang chạy)'),
  tf: tfArg,
  limit: z.number().int().max(1500).optional().describe(`Số nến đã đóng (mặc định ${DEFAULT_BARS}, tối thiểu ${MIN_BARS} — nhỏ hơn sẽ tự nâng)`),
  endTime: z.number().int().optional().describe('Unix giây: lấy các nến có open time ≤ endTime (xem lịch sử cũ hơn)'),
};

const server = new McpServer({ name: 'wyckoff', version: '0.1.0' });

server.registerTool(
  'get_analysis_request',
  {
    title: 'Yêu cầu phân tích',
    description: 'Lấy thông tin phân tích được giao: symbol, khung chính, thứ tự khung top-down (lớn → nhỏ) kèm vai trò, có ảnh chart hay không, giá đóng cửa gần nhất của khung chính (lastClose), R:R tối thiểu của setup (minRiskReward) và instrument (nguồn dữ liệu, volumeType: contract | tick).',
    inputSchema: { analysisId: z.string().optional().describe('Bỏ trống = phân tích đang chạy') },
  },
  async ({ analysisId: idArg }) => {
    try {
      const analysisId = resolveParam(idArg, 'analysisId');
      return text(JSON.stringify(await call(`/internal/analyses/${encodeURIComponent(analysisId)}/request`), null, 1));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'get_klines',
  {
    title: 'Dữ liệu nến',
    description:
      'OHLCV các nến ĐÃ ĐÓNG (crypto: Binance USDⓈ-M Futures; XAUUSD: OANDA, volume = tick volume) dạng CSV: i,time_utc,unix,open,high,low,close,volume. ' +
      'Dùng cột `unix` cho mọi trường time khi nộp kết quả. Cột `i` khớp với chỉ số trong get_features khi cùng symbol/tf/limit/endTime.',
    inputSchema: klineArgs,
  },
  async ({ symbol, tf: tfRaw, limit: limitRaw, endTime }) => {
    try {
      const { tf, limit, note } = resolveKlineArgs(tfRaw, limitRaw, DEFAULT_BARS);
      const res = await loadKlines(resolveParam(symbol, 'symbol'), tf, limit, endTime);
      return text(note + formatKlinesCsv(res));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'get_features',
  {
    title: 'Đặc trưng cấu trúc & Wyckoff',
    description:
      'Tính sẵn trên cùng tập nến với get_klines: ATR14, xu hướng Dow, swing high/low (fractal 2/2, nhãn HH/HL/LH/LL), BOS/CHoCH (theo giá đóng cửa), ' +
      'nến climax (volRatio = volume/SMA20, spreadAtr, closePosition 0=đóng đáy 1=đóng đỉnh, isExtreme), ứng viên Trading Range sau SC/BC ' +
      '(top/bottom, status, probesBelow/Above = ứng viên Spring/UT, volumeDryUpRatio). Đây là GỢI Ý cơ học, cần tự đánh giá lại.',
    inputSchema: klineArgs,
  },
  async ({ symbol, tf: tfRaw, limit: limitRaw, endTime }) => {
    try {
      const { tf, limit, note } = resolveKlineArgs(tfRaw, limitRaw, DEFAULT_BARS);
      const res = await loadKlines(resolveParam(symbol, 'symbol'), tf, limit, endTime);
      return text(note + JSON.stringify(computeFeatures(res.candles, tf)));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'get_chart_screenshot',
  {
    title: 'Ảnh chart',
    description: 'Ảnh PNG chart người dùng đang xem lúc bấm Analyze (nếu có). Chỉ để đối chiếu trực quan; toạ độ phải lấy từ get_klines.',
    inputSchema: { analysisId: z.string().optional().describe('Bỏ trống = phân tích đang chạy') },
  },
  async ({ analysisId: idArg }) => {
    try {
      const analysisId = resolveParam(idArg, 'analysisId');
      const res = await fetch(`${SERVER_URL}/internal/analyses/${encodeURIComponent(analysisId)}/screenshot`, {
        headers: { 'x-wca-token': internalToken() },
      });
      if (!res.ok) return fail('Không có ảnh chart cho phân tích này');
      const data = Buffer.from(await res.arrayBuffer()).toString('base64');
      return { content: [{ type: 'image' as const, data, mimeType: 'image/png' }] };
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'submit_analysis',
  {
    title: 'Nộp kết quả',
    description:
      'Nộp kết quả phân tích Wyckoff để vẽ lên chart. Server kiểm tra: topDown đủ mọi khung theo thứ tự lớn → nhỏ, time khớp nến thật, ' +
      'giá event nằm trong [low, high] của nến, tradePlan: setup LONG cần SL < entryLow, TP > entryHigh (SHORT ngược lại), R:R ≥ minRiskReward ' +
      '(setup sai hoặc R:R thấp bị bỏ, quyết định có thể bị hạ xuống WAIT_FOR_SETUP/STAND_ASIDE), STAND_ASIDE bắt buộc có reconsiderWhen. setup.refinedEntry (tuỳ chọn): SL tầng 2 trên khung nhỏ, estStopDistance ≥ 0.5 ATR khung đó và < SL cấu trúc. ' +
      'Server trả về TOÀN BỘ lỗi (kèm đường dẫn trường) trong một lần; sửa hết rồi nộp lại. Không nộp bản thử/placeholder. ' +
      'Bỏ trống analysisId khi người dùng yêu cầu trực tiếp trong Claude Code (sẽ tạo bản ghi mới và hiện lên UI).',
    // Union: client vẫn thấy schema đầy đủ (nhánh 1), nhưng object sai vẫn qua lớp MCP để server báo đủ mọi lỗi.
    // looseObject: gom trường kết quả nếu agent quên bọc trong `analysis`.
    inputSchema: z.looseObject({
      analysisId: z.string().optional(),
      analysis: z.union([analysisSubmissionSchema, z.record(z.string(), z.unknown())]).optional(),
    }),
  },
  async args => {
    const { analysisId: idArg, analysis: wrapped, ...rest } = args as { analysisId?: string; analysis?: unknown } & Record<string, unknown>;
    // Lượt chạy từ UI: luôn gắn vào phân tích đang chạy dù agent quên analysisId.
    const analysisId = idArg?.trim() || process.env[RUN_CONTEXT_ENV.analysisId] || undefined;
    const analysis = wrapped ?? (Object.keys(rest).length ? rest : undefined);
    if (!analysis) return fail('Thiếu `analysis`: truyền { analysisId, analysis: { ...toàn bộ kết quả... } }');
    try {
      const res = await call<{ ok: boolean; analysisId?: string; warnings?: string[]; errors?: string[] }>('/internal/submit', {
        method: 'POST',
        body: JSON.stringify({ analysisId, analysis }),
      });
      if (!res.ok) return fail(`Kết quả bị từ chối, hãy sửa rồi nộp lại:\n- ${(res.errors ?? []).join('\n- ')}`);
      const warn = res.warnings?.length ? `\nServer đã tự sửa:\n- ${res.warnings.join('\n- ')}` : '';
      return text(`Đã nộp thành công (analysisId=${res.analysisId}). Kết quả đang hiển thị trên UI.${warn}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

await server.connect(new StdioServerTransport());
