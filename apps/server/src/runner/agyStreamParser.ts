// Parse output `agy -p --output-format stream-json` (NDJSON: init / step_update / result) thành sự kiện tiến trình.
import { describeToolUse } from './streamParser.ts';
import type { ParsedItem } from './types.ts';

interface ToolInfo {
  name?: string;
  parameters?: { ServerName?: string; ToolName?: string; Arguments?: Record<string, unknown> } & Record<string, unknown>;
  error?: { message?: string };
}

interface StepUpdate {
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: ToolInfo;
}

function describeAgyTool(info: ToolInfo | undefined, fallbackName = 'tool'): string {
  const p = info?.parameters;
  if (info?.name === 'call_mcp_tool' && p?.ToolName) {
    return p.ServerName === 'wyckoff' ? describeToolUse(p.ToolName, p.Arguments) : `Gọi MCP ${p.ServerName}/${p.ToolName}`;
  }
  const name = info?.name ?? fallbackName;
  // Agent chỉ được xem file schema MCP (mọi file khác bị từ chối).
  if (name === 'read_file' || name === 'view_file') return 'Đọc schema tool MCP';
  return `Gọi tool ${name}`;
}

/** Tạo parser có trạng thái (gom text_delta theo từng bước trả lời). */
export function createAgyParser(): (line: string) => ParsedItem[] {
  const textBuf = new Map<number, string>();

  return (line: string): ParsedItem[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith('{')) {
      // Thông báo ngoài JSON của agy, vd quyền bị tự động từ chối hoặc AGY_ERROR.
      return [{ kind: 'step', message: `agy: ${trimmed.slice(0, 300)}` }];
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return [];
    }
    const items: ParsedItem[] = [];
    switch (msg.event) {
      case 'init': {
        const init = (msg.init ?? {}) as { model?: string };
        if (init.model) items.push({ kind: 'model', model: init.model });
        items.push({ kind: 'step', message: 'Antigravity khởi động' });
        break;
      }
      case 'step_update': {
        const s = (msg.step_update ?? {}) as StepUpdate;
        const idx = s.step_index ?? -1;
        if (s.step_type === 'tool') {
          if (s.state === 'ACTIVE') items.push({ kind: 'step', message: describeAgyTool(s.tool_info, s.tool_name) });
          else if (s.state === 'ERROR') {
            items.push({ kind: 'step', message: `Tool lỗi: ${(s.tool_info?.error?.message ?? 'không rõ').split('\n')[0]!.slice(0, 300)}` });
          }
        } else if (s.step_type === 'agent_response') {
          if (s.text_delta) textBuf.set(idx, (textBuf.get(idx) ?? '') + s.text_delta);
          if (s.state === 'DONE') {
            const text = (textBuf.get(idx) ?? '').trim();
            textBuf.delete(idx);
            if (text) items.push({ kind: 'text', text });
          }
        }
        break;
      }
      case 'result': {
        const r = (msg.result ?? {}) as { status?: string; response?: string; finished_reason?: string; duration_seconds?: number };
        const ok = r.status === 'SUCCESS' && !r.finished_reason;
        items.push({
          kind: 'result',
          ok,
          text: r.response,
          error: ok ? undefined : `agy kết thúc: ${r.finished_reason ?? r.status ?? 'lỗi không rõ'}${r.response ? ` — ${r.response.slice(0, 300)}` : ''}`,
          durationMs: typeof r.duration_seconds === 'number' ? Math.round(r.duration_seconds * 1000) : undefined,
        });
        break;
      }
    }
    return items;
  };
}
