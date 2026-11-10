import { describe, expect, it } from 'vitest';
import {
  AGY_AGENT_NAME,
  buildAgyAgentMarkdown,
  buildAgyArgs,
  buildAgyMcpConfig,
  buildAgySettings,
  parseAgyMcpList,
  parseAgyModels,
} from '../apps/server/src/runner/agyRunner.ts';
import { createAgyParser } from '../apps/server/src/runner/agyStreamParser.ts';

describe('agy runner: khoá quyền', () => {
  it('settings chỉ allow mcp(wyckoff/*), deny shell / ghi file / MCP khác; không dùng mcp(*)', () => {
    const s = JSON.parse(buildAgySettings(['crawl4ai', 'stitch', 'wyckoff']));
    expect(s.toolPermission).toBe('request-review');
    expect(s.allowNonWorkspaceAccess).toBe(false);
    expect(s.permissions.allow).toEqual(['mcp(wyckoff/*)']);
    expect(s.permissions.deny).toEqual(['command(*)', 'write_file(*)', 'mcp(crawl4ai/*)', 'mcp(stitch/*)']);
    expect(s.permissions.deny).not.toContain('mcp(*)');
  });

  it('args: custom agent, stream-json, settings, model tuỳ chọn', () => {
    const args = buildAgyArgs({ prompt: 'P', settings: '{}', model: 'gemini-4-argon-high' });
    expect(args.slice(0, 4)).toEqual(['-p', 'P', '--agent', AGY_AGENT_NAME]);
    expect(args).toContain('--disable-slash-commands');
    expect(args.slice(-2)).toEqual(['--model', 'gemini-4-argon-high']);
    expect(buildAgyArgs({ prompt: 'P', settings: '{}' })).not.toContain('--model');
  });

  it('file agent: không tool mặc định, chỉ MCP; prompt hạ cấp heading dưới 1 H1', () => {
    const md = buildAgyAgentMarkdown('# Vai trò\nabc\n## Con\nx');
    expect(md).toMatch(/^---\nname: wyckoff-analyst\n/);
    expect(md).toContain('excludeDefaultComponents: true');
    expect(md).toContain('inheritMcp: true');
    expect(md).toContain('tools: [view_file]');
    expect(md.match(/^# /gm)).toHaveLength(1);
    expect(md).toContain('## Vai trò\nabc\n### Con');
  });

  it('MCP config dùng đường dẫn tuyệt đối tới tsx loader và apps/mcp', () => {
    const cfg = buildAgyMcpConfig('/a b/root', 'http://127.0.0.1:8787') as {
      mcpServers: { wyckoff: { args: string[]; env: Record<string, string> } };
    };
    expect(cfg.mcpServers.wyckoff.args).toEqual(['--import', 'file:///a%20b/root/node_modules/tsx/dist/loader.mjs', '/a b/root/apps/mcp/src/index.ts']);
    expect(cfg.mcpServers.wyckoff.env).toEqual({ WCA_SERVER_URL: 'http://127.0.0.1:8787' });
  });

  it('parse `agy models` và `agy mcp list`', () => {
    expect(parseAgyModels('Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n')).toEqual([
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
      { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
    ]);
    expect(parseAgyMcpList('NAME      TYPE   STATUS   COMMAND/URL\ncrawl4ai  stdio  enabled  /x\nwyckoff   stdio  enabled  node\n')).toEqual(['crawl4ai', 'wyckoff']);
  });
});

describe('agy stream parser', () => {
  const line = (o: object) => JSON.stringify(o);

  it('init → model + bước khởi động; tool wyckoff → mô tả tiếng Việt; tool lỗi; text gom theo bước', () => {
    const parse = createAgyParser();
    expect(parse(line({ event: 'init', init: { model: 'gemini-4-argon-high', tools: [] } }))).toEqual([
      { kind: 'model', model: 'gemini-4-argon-high' },
      { kind: 'step', message: 'Antigravity khởi động' },
    ]);
    expect(
      parse(line({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'wyckoff', ToolName: 'get_klines', Arguments: { tf: '1d', limit: 300 } } } } })),
    ).toEqual([{ kind: 'step', message: 'Đọc nến 1d (300 nến)' }]);
    expect(parse(line({ event: 'step_update', step_update: { step_index: 5, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'read_file' } } }))).toEqual([
      { kind: 'step', message: 'Đọc schema tool MCP' },
    ]);
    // Bước DONE của tool không sinh thêm sự kiện.
    expect(parse(line({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_info: { name: 'call_mcp_tool' } } }))).toEqual([]);
    expect(
      parse(line({ event: 'step_update', step_update: { step_index: 3, state: 'ERROR', step_type: 'tool', tool_info: { name: 'call_mcp_tool', error: { message: 'Input validation error\nchi tiết' } } } })),
    ).toEqual([{ kind: 'step', message: 'Tool lỗi: Input validation error' }]);
    expect(parse(line({ event: 'step_update', step_update: { step_index: 4, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Đã ' } }))).toEqual([]);
    expect(parse(line({ event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'nộp.\n' } }))).toEqual([
      { kind: 'text', text: 'Đã nộp.' },
    ]);
  });

  it('result SUCCESS → ok; finished_reason / lỗi → không ok; dòng ngoài JSON → bước cảnh báo', () => {
    const parse = createAgyParser();
    expect(parse(line({ event: 'result', result: { status: 'SUCCESS', response: 'OK', duration_seconds: 12.5 } }))).toEqual([
      { kind: 'result', ok: true, text: 'OK', error: undefined, durationMs: 12500 },
    ]);
    const [cut] = parse(line({ event: 'result', result: { status: 'SUCCESS', response: '', finished_reason: 'print_timeout' } }));
    expect(cut).toMatchObject({ kind: 'result', ok: false });
    expect((cut as { error: string }).error).toMatch(/print_timeout/);
    expect(parse('jetski: no output produced — a tool required the "read_file" permission')[0]).toMatchObject({ kind: 'step' });
    expect(parse('')).toEqual([]);
  });
});
