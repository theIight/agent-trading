import { isRunnerId, isTimeframe, SUPPORTED_TFS, type RunnerId, type Timeframe } from '@wca/shared';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

function num(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) ? n : fallback;
}

function tfList(name: string, fallback: Timeframe[]): Timeframe[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(isTimeframe);
  return list.length ? list : fallback;
}

function runnerList(name: string, fallback: RunnerId[]): RunnerId[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const list = raw.split(',').map(s => s.trim()).filter(isRunnerId);
  return list.length ? list : fallback;
}

/** Giá trị số theo symbol từ env `<PREFIX><SYMBOL>`, gộp với mặc định; symbol khác chỉ lấy được qua env. */
function symbolNums(prefix: string, defaults: Record<string, number>): Record<string, number> {
  const out = { ...defaults };
  for (const [key, raw] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || !raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[key.slice(prefix.length).toUpperCase()] = n;
  }
  return out;
}

const defaultTf =(process.env.DEFAULT_TF ?? '4h').toLowerCase();

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: int('PORT', 8787),
  dbPath: process.env.DB_PATH ?? './data/app.db',
  marketProvider: process.env.MARKET_PROVIDER ?? 'binance-futures',
  defaultSymbol: process.env.DEFAULT_SYMBOL ?? 'BTCUSDT',
  defaultTf: (isTimeframe(defaultTf) ? defaultTf : '4h') as Timeframe,
  supportedTfs: tfList('SUPPORTED_TFS', [...SUPPORTED_TFS]),
  defaultContextTfs: tfList('DEFAULT_CONTEXT_TFS', ['1d', '5m']),
  agentMaxTfs: int('AGENT_MAX_TFS', 4),
  agentBarsPerTf: int('AGENT_BARS_PER_TF', 300),
  agentRunners: runnerList('AGENT_RUNNERS', ['claude-code', 'agy']),
  agentRunner: (isRunnerId(process.env.AGENT_RUNNER) ? process.env.AGENT_RUNNER : 'claude-code') as RunnerId,
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  agentModel: process.env.AGENT_MODEL || undefined,
  agyBin: process.env.AGY_BIN ?? 'agy',
  /** Gemini qua agy thường chậm hơn Claude Code. */
  agyTimeoutMs: int('AGY_TIMEOUT_MS', 600_000),
  /** Rỗng = mặc định của agy. */
  agyModel: process.env.AGY_MODEL === undefined ? 'gemini-4-argon-high' : process.env.AGY_MODEL || undefined,
  agentTimeoutMs: int('AGENT_TIMEOUT_MS', 300_000),
  /** R:R tối thiểu của trade setup (giữa vùng entry → TP xa nhất); thấp hơn thì bỏ setup. */
  setupMinRr: num('SETUP_MIN_RR', 2),
  /** OANDA v20 (XAUUSD…). Thiếu token → symbol OANDA báo lỗi rõ ràng. */
  oandaApiToken: process.env.OANDA_API_TOKEN || undefined,
  oandaEnv: (process.env.OANDA_ENV === 'live' ? 'live' : 'practice') as 'practice' | 'live',
  oandaPrice: (['M', 'B', 'A'].includes(process.env.OANDA_PRICE ?? '') ? process.env.OANDA_PRICE : 'M') as 'M' | 'B' | 'A',
  oandaSymbols: (process.env.OANDA_SYMBOLS ?? 'XAUUSD').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  /** Nguồn dữ liệu XAUUSD: tiingo-okx (giá Tiingo + volume OKX perp) | oanda | binance (dùng XAUUSDT). */
  xauusdSource: (['tiingo-okx', 'oanda', 'binance'].includes(process.env.XAUUSD_SOURCE ?? '') ? process.env.XAUUSD_SOURCE : 'tiingo-okx') as
    | 'tiingo-okx'
    | 'oanda'
    | 'binance',
  tiingoApiToken: process.env.TIINGO_API_TOKEN || undefined,
  /** symbol nội bộ → ticker Tiingo (mặc định chữ thường: XAUUSD → xauusd). */
  tiingoXauTicker: process.env.TIINGO_XAU_TICKER || 'xauusd',
  /** Giới hạn gói miễn phí Tiingo: 50/giờ, 1.000/ngày — chừa biên an toàn. */
  tiingoMaxPerHour: int('TIINGO_MAX_PER_HOUR', 45),
  tiingoMaxPerDay: int('TIINGO_MAX_PER_DAY', 950),
  okxVolumeInst: process.env.OKX_VOLUME_INST || 'XAU-USDT-SWAP',
  /** Chu kỳ poll realtime cho nguồn không có WebSocket (OANDA). */
  livePollMs: int('LIVE_POLL_MS', 2000),
  /** Symbol được gửi kèm ảnh Bookmap (order flow). */
  bookmapSymbols: (process.env.BOOKMAP_SYMBOLS ?? 'XAUUSD,BTCUSDT').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  /** Offset mặc định = giá Bookmap − giá app (vàng: GC futures cao hơn spot), theo `BOOKMAP_OFFSET_<SYMBOL>`. */
  bookmapOffsets: symbolNums('BOOKMAP_OFFSET_', { XAUUSD: 10, BTCUSDT: 0 }),
  /** Ngưỡng lệch offset (đơn vị giá) để cảnh báo ảnh cũ, theo `BOOKMAP_TOLERANCE_<SYMBOL>`. */
  bookmapTolerances: symbolNums('BOOKMAP_TOLERANCE_', { XAUUSD: 3, BTCUSDT: 60 }),
  /** Ảnh chụp cũ hơn số phút này so với lúc gửi → cảnh báo. */
  bookmapMaxAgeMin: int('BOOKMAP_MAX_AGE_MIN', 30),
  /** Cache klines trong bộ nhớ (ms) để tránh gọi Binance liên tục. */
  klineMemoryTtlMs: int('KLINE_MEMORY_TTL_MS', 5_000),
};

export type AppConfig = typeof config;
