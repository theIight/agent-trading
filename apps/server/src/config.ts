import { expandHome } from './analysis/bookmapSource.ts';
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

/** Danh sách id số (Telegram chat / user id, có thể âm), phân cách dấu phẩy. */
function idList(name: string): string[] {
  return (process.env[name] ?? '').split(',').map(s => s.trim()).filter(s => /^-?\d{1,20}$/.test(s));
}

function runnerList(name: string, fallback: RunnerId[]): RunnerId[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const list = raw.split(',').map(s => s.trim()).filter(isRunnerId);
  return list.length ? list : fallback;
}

/** Giá trị số theo symbol từ env `<PREFIX><SYMBOL>`, gộp với mặc định; symbol khác chỉ lấy được qua env. */
/** `ORDERFLOW_SOURCE_XAUUSD=futures:XAUUSDT` → `{ XAUUSD: { market: 'futures', symbol: 'XAUUSDT' } }`. */
type OrderflowSourceCfg = { market: 'spot' | 'futures'; symbol: string };
function orderflowSources(defaults: Record<string, OrderflowSourceCfg>): Record<string, OrderflowSourceCfg> {
  const out = { ...defaults };
  for (const [key, raw] of Object.entries(process.env)) {
    if (!key.startsWith('ORDERFLOW_SOURCE_') || !raw) continue;
    const m = /^(spot|futures):([A-Z0-9]+)$/i.exec(raw.trim());
    if (m) out[key.slice('ORDERFLOW_SOURCE_'.length).toUpperCase()] = { market: m[1]!.toLowerCase() as 'spot' | 'futures', symbol: m[2]!.toUpperCase() };
  }
  return out;
}

/** `LIQ_OKX_INST_BTCUSDT=BTC-USDT-SWAP:0.01`; giá trị rỗng = tắt OKX cho symbol. */
function liqOkxInst(defaults: Record<string, { instId: string; ctVal: number }>): Record<string, { instId: string; ctVal: number } | undefined> {
  const out: Record<string, { instId: string; ctVal: number } | undefined> = { ...defaults };
  for (const [key, raw] of Object.entries(process.env)) {
    if (!key.startsWith('LIQ_OKX_INST_') || raw === undefined) continue;
    const sym = key.slice('LIQ_OKX_INST_'.length).toUpperCase();
    const m = /^([A-Z0-9-]+):([\d.]+)$/i.exec(raw.trim());
    out[sym] = m && Number(m[2]) > 0 ? { instId: m[1]!.toUpperCase(), ctVal: Number(m[2]) } : undefined;
  }
  return out;
}

function symbolNums(prefix: string, defaults: Record<string, number>): Record<string, number> {
  const out = { ...defaults };
  for (const [key, raw] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || !raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[key.slice(prefix.length).toUpperCase()] = n;
  }
  return out;
}

/** `BOOKMAP_IMAGE_XAUUSD_HTF=~/ssd/live3.png` → `{ XAUUSD: { htf: '/Users/…/ssd/live3.png' } }`. */
function bookmapImagePaths(): Record<string, Partial<Record<'htf' | 'ltf', string>>> {
  const out: Record<string, Partial<Record<'htf' | 'ltf', string>>> = {};
  for (const [key, raw] of Object.entries(process.env)) {
    const m = /^BOOKMAP_IMAGE_([A-Z0-9]+)_(HTF|LTF)$/.exec(key);
    if (!m || !raw?.trim()) continue;
    (out[m[1]!] ??= {})[m[2]!.toLowerCase() as 'htf' | 'ltf'] = expandHome(raw.trim());
  }
  return out;
}

const defaultTf = (process.env.DEFAULT_TF ?? '4h').toLowerCase();

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
  /** Đường dẫn ảnh Bookmap theo symbol/khung: `BOOKMAP_IMAGE_<SYMBOL>_<HTF|LTF>` (hỗ trợ `~`). Symbol có path mới dùng được Bookmap. */
  bookmapImages: bookmapImagePaths(),
  /** Offset mặc định = giá Bookmap − giá app (vàng: GC futures cao hơn spot), theo `BOOKMAP_OFFSET_<SYMBOL>`. */
  bookmapOffsets: symbolNums('BOOKMAP_OFFSET_', { XAUUSD: 10, BTCUSDT: 0 }),
  /** Ngưỡng lệch offset (đơn vị giá) để cảnh báo ảnh cũ, theo `BOOKMAP_TOLERANCE_<SYMBOL>`. */
  bookmapTolerances: symbolNums('BOOKMAP_TOLERANCE_', { XAUUSD: 3, BTCUSDT: 60 }),
  /** Ảnh chụp cũ hơn số phút này so với lúc gửi → cảnh báo. */
  bookmapMaxAgeMin: int('BOOKMAP_MAX_AGE_MIN', 30),
  /** Order flow từ Binance (server tự ghi sổ lệnh qua WebSocket) cho các symbol chart này. Rỗng = tắt. */
  orderflowBinanceSymbols: (process.env.ORDERFLOW_BINANCE_SYMBOLS ?? 'BTCUSDT,XAUUSD').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  /** Nguồn Binance của symbol chart, theo `ORDERFLOW_SOURCE_<SYMBOL>=spot|futures:<SYMBOL_BINANCE>`; thiếu = spot cùng tên. */
  orderflowSources: orderflowSources({ BTCUSDT: { market: 'spot', symbol: 'BTCUSDT' }, XAUUSD: { market: 'futures', symbol: 'XAUUSDT' } }),
  /** Bucket giá khi gom sổ lệnh, theo `ORDERFLOW_BUCKET_<SYMBOL>`. */
  orderflowBuckets: symbolNums('ORDERFLOW_BUCKET_', { BTCUSDT: 10, XAUUSD: 1 }),
  /** Tổng lệnh chủ động cùng phía trong 1 giây ≥ khối lượng này (base) → lệnh lớn, theo `ORDERFLOW_BIG_TRADE_<SYMBOL>`.
   *  BTC spot: aggTrade đơn lẻ hiếm khi > 1 BTC; gộp theo giây ≥ 1 BTC ≈ vài chục lần/giờ. */
  orderflowBigTrade: symbolNums('ORDERFLOW_BIG_TRADE_', { BTCUSDT: 1, XAUUSD: 80 }),
  /** Tổng lệnh lớn chủ động tại một bucket (2 giờ) để xét hấp thụ, theo `ORDERFLOW_ABSORB_<SYMBOL>`. */
  orderflowAbsorb: symbolNums('ORDERFLOW_ABSORB_', { BTCUSDT: 8, XAUUSD: 300 }),
  /** Khối lượng tối thiểu để một mức tính là tường trong lịch sử tường trên chart, theo `ORDERFLOW_WALL_MIN_<SYMBOL>`. */
  orderflowWallMin: symbolNums('ORDERFLOW_WALL_MIN_', { BTCUSDT: 8, XAUUSD: 500 }),
  /** Offset dự phòng giá nguồn − giá chart khi chưa tính được basis (trung vị 60 phút), theo `ORDERFLOW_OFFSET_<SYMBOL>`. */
  orderflowOffsets: symbolNums('ORDERFLOW_OFFSET_', { BTCUSDT: 33, XAUUSD: 0 }),
  orderflowSampleSec: int('ORDERFLOW_SAMPLE_SEC', 10),
  orderflowRetainH: int('ORDERFLOW_RETAIN_H', 24),
  orderflowResyncMin: int('ORDERFLOW_RESYNC_MIN', 30),
  /** Giá còn cách mép vùng phủ snapshot < N% độ rộng phía đó → snapshot lại sớm (0 = tắt). */
  orderflowEdgeResyncPct: int('ORDERFLOW_EDGE_RESYNC_PCT', 35),
  /** Khoảng cách tối thiểu giữa 2 lần snapshot do chạm mép (giây). */
  orderflowEdgeResyncMinSec: int('ORDERFLOW_EDGE_RESYNC_MIN_SEC', 60),
  /** Chu kỳ snapshot lại theo symbol (`ORDERFLOW_RESYNC_MIN_<SYMBOL>`): futures chỉ chụp được 1000 mức nên chụp lại thường xuyên để vùng phủ theo giá. */
  orderflowResyncMinBySymbol: symbolNums('ORDERFLOW_RESYNC_MIN_', { XAUUSD: 5 }),
  /** Thanh lý (bong bóng thật Binance + OKX, heatmap ước tính từ OI Binance) cho các symbol Binance Futures này. Rỗng = tắt. */
  liqSymbols: (process.env.LIQ_SYMBOLS ?? 'BTCUSDT').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  /** `LIQ_OKX_INST_<SYMBOL>=BTC-USDT-SWAP:0.01` (instId:ctVal); rỗng = chỉ Binance. */
  liqOkxInst: liqOkxInst({ BTCUSDT: { instId: 'BTC-USDT-SWAP', ctVal: 0.01 } }),
  /** Ngưỡng cụm thanh lý (đồng gốc) ở khung 1m, khung lớn hơn × √(phút), theo `LIQ_MIN_QTY_<SYMBOL>`. */
  liqMinQty: symbolNums('LIQ_MIN_QTY_', { BTCUSDT: 0.5 }),
  /** Bucket giá heatmap, theo `LIQ_BUCKET_<SYMBOL>`. */
  liqBuckets: symbolNums('LIQ_BUCKET_', { BTCUSDT: 50 }),
  /** Phân bố đòn bẩy giả định `lev:weight,...`. */
  liqLeverage: process.env.LIQ_LEVERAGE,
  /** Ký quỹ duy trì giả định. */
  liqMmr: Number(process.env.LIQ_MMR) > 0 ? Number(process.env.LIQ_MMR) : 0.004,
  liqRetainH: int('LIQ_RETAIN_H', 72),
  /** Volume gộp (nến đã đóng): perp Binance Futures + OKX + Bybit, spot Binance. Rỗng = tắt. */
  volAggSymbols: (process.env.VOLAGG_SYMBOLS ?? 'BTCUSDT').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  /** Đột biến khi volume nhóm > hệ số này × trung vị 20 nến trước. */
  volAggSpikeX: Number(process.env.VOLAGG_SPIKE_X) > 1 ? Number(process.env.VOLAGG_SPIKE_X) : 3,
  /** Telegram: gửi ảnh chart khi phân tích kết thúc. Thiếu token hoặc chat id → tắt. */
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
  telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || undefined,
  /** Topic trong group (forum); rỗng = gửi thẳng vào chat. */
  telegramThreadId: Number.parseInt(process.env.TELEGRAM_THREAD_ID ?? '', 10) > 0 ? Number.parseInt(process.env.TELEGRAM_THREAD_ID!, 10) : undefined,
  /** `all` = mỗi khung của phân tích một ảnh; `primary` = chỉ khung chính. */
  telegramTfs: (process.env.TELEGRAM_TFS === 'primary' ? 'primary' : 'all') as 'all' | 'primary',
  telegramNotifyFailed: process.env.TELEGRAM_NOTIFY_FAILED !== '0',
  /** Bot nhận lệnh trong group (long polling). Cần token + chat id; `0` = chỉ gửi một chiều. */
  telegramBotCommands: process.env.TELEGRAM_BOT_COMMANDS !== '0',
  /** Chat id thêm được ra lệnh (ngoài TELEGRAM_CHAT_ID). */
  telegramAllowedChats: idList('TELEGRAM_ALLOWED_CHATS'),
  /** Giới hạn user id được ra lệnh; rỗng = mọi thành viên chat được phép. */
  telegramAllowedUsers: idList('TELEGRAM_ALLOWED_USERS'),
  /** Khung chính / khung phụ khi lệnh `/analyze` không nêu khung. */
  telegramBotDefaultTf: (isTimeframe(process.env.TELEGRAM_BOT_DEFAULT_TF?.trim().toLowerCase()) ? process.env.TELEGRAM_BOT_DEFAULT_TF!.trim().toLowerCase() : '4h') as Timeframe,
  telegramBotDefaultContext: tfList('TELEGRAM_BOT_DEFAULT_CONTEXT', ['1d', '1h', '1m']),
  /** Số phân tích bot tạo đang chờ/chạy tối đa mỗi chat. */
  telegramBotMaxPending: Math.max(1, int('TELEGRAM_BOT_MAX_PENDING', 2)),
  /** Web để Chrome headless mở trang `?snapshot=` (pm2: vite preview 5173). */
  snapshotWebUrl: (process.env.SNAPSHOT_WEB_URL || 'http://127.0.0.1:5173').replace(/\/+$/, ''),
  /** Channel Playwright: `chrome` = Chrome đã cài; rỗng = Chromium của Playwright. */
  snapshotChromeChannel: process.env.SNAPSHOT_CHROME_CHANNEL === undefined ? 'chrome' : process.env.SNAPSHOT_CHROME_CHANNEL || undefined,
  /** Canh giá chạm vùng entry của setup (crypto, phân tích mới nhất mỗi symbol); `0` = tắt. */
  priceAlerts: process.env.PRICE_ALERTS !== '0',
  /** Hạn alert khi setup không có `validUntil` (giờ). */
  priceAlertMaxAgeH: Math.max(1, int('PRICE_ALERT_MAX_AGE_H', 72)),
  /** Cache klines trong bộ nhớ (ms) để tránh gọi Binance liên tục. */
  klineMemoryTtlMs: int('KLINE_MEMORY_TTL_MS', 5_000),
};

export type AppConfig = typeof config;
