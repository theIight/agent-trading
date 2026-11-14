import { normalizeSymbol, normalizeTfValue, isTimeframe, type Timeframe } from '@wca/shared';

// Phân tích cú pháp lệnh bot Telegram. Pure, không gọi mạng.

export interface CommandDefaults {
  primaryTf: Timeframe;
  contextTfs: Timeframe[];
}

export type BotCommand =
  | { cmd: 'analyze'; symbol: string; primaryTf: Timeframe; contextTfs: Timeframe[]; runner?: string; model?: string }
  | { cmd: 'last'; symbol?: string }
  | { cmd: 'status' }
  | { cmd: 'cancel' }
  | { cmd: 'help' }
  | { cmd: 'error'; error: string };

export const BOT_COMMANDS = [
  { command: 'analyze', description: 'Phân tích: /analyze BTCUSDT [khungChính] [khungPhụ...]' },
  { command: 'last', description: 'Gửi lại kết quả gần nhất: /last [SYMBOL]' },
  { command: 'status', description: 'Phân tích đang chạy / chờ' },
  { command: 'cancel', description: 'Huỷ phân tích do bot tạo trong chat này' },
  { command: 'help', description: 'Danh sách lệnh' },
];

export function helpText(d: CommandDefaults): string {
  const all = [d.primaryTf, ...d.contextTfs].join(' ');
  return [
    '<b>Lệnh bot Wyckoff</b>',
    `/analyze BTCUSDT — phân tích với bộ khung mặc định (${all}, khung chính ${d.primaryTf})`,
    '/analyze BTCUSDT 1h — khung chính 1h, khung phụ lấy từ bộ mặc định',
    '/analyze BTCUSDT 4h 1d 1h — khung chính + khung phụ tự chọn',
    '  thêm <code>runner=agy</code> / <code>model=...</code> để đổi agent',
    '/last [SYMBOL] — gửi lại kết quả gần nhất',
    '/status — phân tích đang chạy / chờ',
    '/cancel — huỷ phân tích do bot tạo trong chat này',
  ].join('\n');
}

const parseTf = (s: string): Timeframe | null => {
  const v = normalizeTfValue(s);
  return isTimeframe(v) ? v : null;
};

/**
 * Đọc lệnh từ tin nhắn. Không phải lệnh, lệnh lạ hoặc lệnh gửi cho bot khác (`/x@BotKhac`) → null.
 * `/analyze SYMBOL` → bộ mặc định; `/analyze SYMBOL tf` → khung phụ = bộ mặc định bỏ khung chính.
 */
export function parseCommand(text: string | undefined, botUsername: string | undefined, d: CommandDefaults): BotCommand | null {
  const m = /^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec((text ?? '').trim());
  if (!m) return null;
  const [, rawCmd, target, rest] = m;
  if (target && (!botUsername || target.toLowerCase() !== botUsername.toLowerCase())) return null;
  const args = (rest ?? '').split(/\s+/).filter(Boolean);
  switch (rawCmd!.toLowerCase()) {
    case 'analyze':
    case 'a':
      return parseAnalyze(args, d);
    case 'last': {
      if (!args[0]) return { cmd: 'last' };
      const symbol = normalizeSymbol(args[0]);
      return symbol ? { cmd: 'last', symbol } : { cmd: 'error', error: 'Symbol không hợp lệ' };
    }
    case 'status':
      return { cmd: 'status' };
    case 'cancel':
      return { cmd: 'cancel' };
    case 'help':
    case 'start':
      return { cmd: 'help' };
    default:
      return null;
  }
}

function parseAnalyze(args: string[], d: CommandDefaults): BotCommand {
  const [rawSymbol, ...rest] = args;
  if (!rawSymbol) return { cmd: 'error', error: 'Thiếu symbol. Ví dụ: /analyze BTCUSDT' };
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol || !/^[A-Z0-9._-]{2,30}$/.test(symbol)) return { cmd: 'error', error: 'Symbol không hợp lệ' };
  const tfs: Timeframe[] = [];
  let runner: string | undefined;
  let model: string | undefined;
  for (const a of rest) {
    const kv = /^(runner|model)=(.+)$/i.exec(a);
    if (kv) {
      if (kv[1]!.toLowerCase() === 'runner') runner = kv[2];
      else model = kv[2];
      continue;
    }
    const tf = parseTf(a);
    if (!tf) return { cmd: 'error', error: `Khung không hỗ trợ: ${a}` };
    tfs.push(tf);
  }
  let primaryTf: Timeframe;
  let contextTfs: Timeframe[];
  if (!tfs.length) {
    primaryTf = d.primaryTf;
    contextTfs = d.contextTfs.filter(tf => tf !== primaryTf);
  } else if (tfs.length === 1) {
    primaryTf = tfs[0]!;
    contextTfs = [...new Set([d.primaryTf, ...d.contextTfs])].filter(tf => tf !== primaryTf);
  } else {
    [primaryTf, ...contextTfs] = tfs as [Timeframe, ...Timeframe[]];
  }
  return { cmd: 'analyze', symbol, primaryTf, contextTfs, ...(runner ? { runner } : {}), ...(model ? { model } : {}) };
}
