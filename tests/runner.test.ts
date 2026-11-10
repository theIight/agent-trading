import { describe, expect, it } from 'vitest';
import { parseStreamLine } from '../apps/server/src/runner/streamParser.ts';
import { buildClaudeArgs } from '../apps/server/src/runner/claudeCodeRunner.ts';
import { buildUserPrompt } from '../apps/server/src/runner/prompt.ts';

describe('parseStreamLine (claude -p stream-json)', () => {
  it('init: model + trạng thái MCP', () => {
    const items = parseStreamLine(
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', mcp_servers: [{ name: 'wyckoff', status: 'connected' }] }),
    );
    expect(items).toEqual([
      { kind: 'model', model: 'claude-opus-5-5' },
      { kind: 'step', message: 'Agent khởi động, MCP wyckoff đã kết nối' },
    ]);
  });

  it('assistant: text + tool_use → step mô tả tiếng Việt', () => {
    const items = parseStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Bắt đầu với khung 1D.' },
            { type: 'tool_use', id: 't1', name: 'mcp__wyckoff__get_klines', input: { symbol: 'BTCUSDT', tf: '1d', limit: 200 } },
            { type: 'tool_use', id: 't2', name: 'mcp__wyckoff__get_features', input: { tf: '5m' } },
          ],
        },
      }),
    );
    expect(items).toEqual([
      { kind: 'text', text: 'Bắt đầu với khung 1D.' },
      { kind: 'step', message: 'Đọc nến 1d (200 nến)' },
      { kind: 'step', message: 'Tính cấu trúc / climax / range 5m' },
    ]);
  });

  it('tool_result lỗi → step cảnh báo', () => {
    const items = parseStreamLine(
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'Kết quả bị từ chối' }] }] } }),
    );
    expect(items[0]).toEqual({ kind: 'step', message: 'Tool lỗi: Kết quả bị từ chối' });
  });

  it('result success / error', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'xong', total_cost_usd: 0.1, duration_ms: 5000 }))[0]).toEqual({
      kind: 'result', ok: true, text: 'xong', error: undefined, costUsd: 0.1, durationMs: 5000,
    });
    expect(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }))[0]).toMatchObject({ kind: 'result', ok: false });
  });

  it('bỏ qua dòng rác', () => {
    expect(parseStreamLine('not json')).toEqual([]);
    expect(parseStreamLine('{broken')).toEqual([]);
  });
});

describe('buildClaudeArgs', () => {
  it('chỉ cho phép MCP wyckoff, tắt tool có sẵn', () => {
    const args = buildClaudeArgs({ systemPrompt: 'SYS', model: 'claude-sonnet-5-5' });
    expect(args).toContain('-p');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__wyckoff__*');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
    expect(args[args.indexOf('--mcp-config') + 1]).toMatch(/\.mcp\.json$/);
  });
});

describe('buildUserPrompt', () => {
  it('nêu analysisId và thứ tự top-down', () => {
    const p = buildUserPrompt({
      analysisId: 'abc',
      symbol: 'BTCUSDT',
      primaryTf: '4h',
      plan: [
        { tf: '1d', role: 'HTF' },
        { tf: '4h', role: 'PRIMARY' },
        { tf: '5m', role: 'LTF' },
      ],
      barsPerTf: 300,
      hasScreenshot: false,
    });
    expect(p).toContain('analysisId: abc');
    expect(p).toContain('1D (1d, HTF) → 4H (4h, PRIMARY) → 5m (5m, LTF)');
  });
});
