// Parse output `claude -p --output-format stream-json --verbose` (mỗi dòng một JSON) thành sự kiện tiến trình.

import { MIN_KLINE_BARS } from '@wca/shared';
import type { ParsedItem } from './types.ts';

export type { ParsedItem };

const MCP_PREFIX = 'mcp__wyckoff__';

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  content?: unknown;
  tool_use_id?: string;
}

/** "(300 nến)"; limit bị MCP nâng lên tối thiểu thì "(5 → 100 nến)". */
function limitText(limit: unknown): string {
  if (typeof limit !== 'number') return '';
  return limit < MIN_KLINE_BARS ? ` (${limit} → ${MIN_KLINE_BARS} nến)` : ` (${limit} nến)`;
}

export function describeToolUse(name: string, input: Record<string, unknown> = {}): string {
  const short = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
  const tf = typeof input.tf === 'string' ? input.tf : '';
  switch (short) {
    case 'get_analysis_request':
      return 'Đọc yêu cầu phân tích';
    case 'get_klines':
      return `Đọc nến ${tf}${limitText(input.limit)}`;
    case 'get_features':
      return `Tính cấu trúc / climax / range ${tf}`;
    case 'get_chart_screenshot':
      return 'Xem ảnh chart';
    case 'get_bookmap_images':
      return 'Xem ảnh Bookmap (order flow)';
    case 'get_orderflow':
      return 'Đọc order flow Binance';
    case 'submit_analysis':
      return 'Nộp kết quả phân tích';
    default:
      return `Gọi tool ${short}`;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('\n');
  }
  return '';
}

export function parseStreamLine(line: string): ParsedItem[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const items: ParsedItem[] = [];
  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        if (typeof msg.model === 'string') items.push({ kind: 'model', model: msg.model });
        const servers = (msg.mcp_servers as { name: string; status: string }[] | undefined) ?? [];
        const ours = servers.find(s => s.name === 'wyckoff');
        items.push({
          kind: 'step',
          message: ours?.status === 'connected' ? 'Agent khởi động, MCP wyckoff đã kết nối' : `MCP wyckoff: ${ours?.status ?? 'không tìm thấy'}`,
        });
      }
      break;
    }
    case 'assistant': {
      const content = ((msg.message as { content?: ContentBlock[] })?.content ?? []) as ContentBlock[];
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) items.push({ kind: 'text', text: block.text.trim() });
        if (block.type === 'tool_use' && block.name) items.push({ kind: 'step', message: describeToolUse(block.name, block.input) });
      }
      break;
    }
    case 'user': {
      const content = ((msg.message as { content?: ContentBlock[] })?.content ?? []) as ContentBlock[];
      for (const block of content) {
        if (block.type === 'tool_result' && block.is_error) {
          items.push({ kind: 'step', message: `Tool lỗi: ${toolResultText(block.content).slice(0, 300)}` });
        }
      }
      break;
    }
    case 'result': {
      const isError = Boolean(msg.is_error) || msg.subtype !== 'success';
      items.push({
        kind: 'result',
        ok: !isError,
        text: typeof msg.result === 'string' ? msg.result : undefined,
        error: isError ? String(msg.result ?? msg.subtype ?? 'unknown error') : undefined,
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
        durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
      });
      break;
    }
  }
  return items;
}
