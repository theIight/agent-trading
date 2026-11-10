import { describe, expect, it } from 'vitest';
import { analysisSubmissionSchema, buildTfPlan, normalizeTfInput, SUBMISSION_EXAMPLE, type TfPlanEntry } from '@wca/shared';
import { MIN_BARS, resolveKlineArgs, resolveParam } from '../apps/mcp/src/format.ts';
import { buildAgyMcpConfig } from '../apps/server/src/runner/agyRunner.ts';
import { runContextEnv } from '../apps/server/src/runner/spawnAgent.ts';
import { describeToolUse } from '../apps/server/src/runner/streamParser.ts';
import { buildAgyAgentMarkdown, buildAgyPromptSuffix, SUBMIT_FORMAT_APPENDIX } from '../apps/server/src/runner/agyRunner.ts';
import { MIN_SUMMARY_CHARS } from '../apps/server/src/validate/index.ts';

describe('mẫu submit_analysis', () => {
  it('khớp analysisSubmissionSchema và qua ngưỡng chống placeholder', () => {
    const parsed = analysisSubmissionSchema.parse(SUBMISSION_EXAMPLE);
    expect(parsed.summary.length).toBeGreaterThanOrEqual(MIN_SUMMARY_CHARS);
    expect(parsed.topDown.every(t => t.note.length >= 15)).toBe(true);
    expect(parsed.tradePlan.reason.length).toBeGreaterThanOrEqual(20);
    expect(parsed.tradePlan.setups[0]!.refinedEntry).toBeDefined();
  });

  it('phụ lục agy chứa mẫu JSON, enum; file agent kèm phụ lục', () => {
    expect(SUBMIT_FORMAT_APPENDIX).toContain('"analysisId"');
    expect(SUBMIT_FORMAT_APPENDIX).toContain('"tradePlan"');
    expect(SUBMIT_FORMAT_APPENDIX).toContain('events[].type: PS, PSY, SC');
    expect(SUBMIT_FORMAT_APPENDIX).toContain('- analysis (cấp ngoài): symbol, primaryTf, schematic');
    expect(SUBMIT_FORMAT_APPENDIX).toContain('- scenarios[]: name, probability, bias, path, invalidation');
    expect(buildAgyAgentMarkdown('# A')).toContain('## Định dạng submit_analysis');
  });

  it('prompt agy nhắc symbol, primaryTf, đủ khung top-down, số nến', () => {
    const plan = (buildTfPlan('1h', ['1d', '1m']) as { ok: true; plan: TfPlanEntry[] }).plan;
    const s = buildAgyPromptSuffix({ analysisId: 'abc', symbol: 'BTCUSDT', primaryTf: '1h', plan, barsPerTf: 300 });
    const json = JSON.parse(s.slice(s.indexOf('```json') + 7, s.lastIndexOf('```')));
    expect(json).toMatchObject({ analysisId: 'abc', analysis: { symbol: 'BTCUSDT', primaryTf: '1h' } });
    expect(json.analysis.topDown.map((t: { tf: string; role: string }) => `${t.tf}:${t.role}`)).toEqual(['1d:HTF', '1h:PRIMARY', '1m:LTF']);
    expect(s).toContain('limit 300');
    expect(s).toMatch(/Checklist/);
  });
});

describe('chuẩn hoá tham số MCP', () => {
  it('limit < 100 tự nâng kèm ghi chú; mặc định dùng barsPerTf', () => {
    expect(resolveKlineArgs('1d', 20, 300)).toEqual({ tf: '1d', limit: MIN_BARS, note: '(đã nâng limit từ 20 lên 100)\n' });
    expect(resolveKlineArgs('1d', undefined, 300)).toMatchObject({ limit: 300, note: '' });
    expect(resolveKlineArgs('4H', 500, 300)).toMatchObject({ tf: '4h', limit: 500 });
    expect(() => resolveKlineArgs('1M', 300, 300)).toThrow(/tf không hợp lệ/);
    expect(() => resolveKlineArgs('2h', 300, 300)).toThrow(/tf không hợp lệ/);
  });

  it('normalizeTfInput đệ quy, không sửa object gốc', () => {
    const raw = { primaryTf: '1H', topDown: [{ tf: '1D' }], tradePlan: { setups: [{ tf: '5M', refinedEntry: { tf: '1M' } }] } };
    const out = normalizeTfInput(raw);
    expect(out).toEqual({ primaryTf: '1h', topDown: [{ tf: '1d' }], tradePlan: { setups: [{ tf: '5m', refinedEntry: { tf: '1M' } }] } });
    expect(raw.primaryTf).toBe('1H');
  });
});

describe('ngữ cảnh lượt chạy cho MCP', () => {
  const env = { WCA_ANALYSIS_ID: 'run-1', WCA_SYMBOL: 'BTCUSDT' };

  it('resolveParam: ưu tiên tham số agent, thiếu thì lấy env, không có env thì lỗi rõ ràng', () => {
    expect(resolveParam('ETHUSDT', 'symbol', env)).toBe('ETHUSDT');
    expect(resolveParam(undefined, 'symbol', env)).toBe('BTCUSDT');
    expect(resolveParam('  ', 'analysisId', env)).toBe('run-1');
    expect(() => resolveParam(undefined, 'symbol', {})).toThrow(/Thiếu tham số `symbol`/);
    expect(() => resolveParam(undefined, 'analysisId', {})).toThrow(/Thiếu tham số `analysisId`/);
  });

  it('runner truyền env ngữ cảnh; MCP config của agy chứa env đó', () => {
    const ctx = runContextEnv({ analysisId: 'run-1', symbol: 'BTCUSDT', primaryTf: '1h' });
    expect(ctx).toEqual({ WCA_ANALYSIS_ID: 'run-1', WCA_SYMBOL: 'BTCUSDT', WCA_PRIMARY_TF: '1h' });
    const cfg = buildAgyMcpConfig('/r', 'http://127.0.0.1:8787', ctx) as { mcpServers: { wyckoff: { env: Record<string, string> } } };
    expect(cfg.mcpServers.wyckoff.env).toEqual({ WCA_SERVER_URL: 'http://127.0.0.1:8787', ...ctx });
  });

  it('dòng tiến trình hiện số nến thực tế khi limit bị nâng', () => {
    expect(describeToolUse('get_klines', { tf: '1m', limit: 5 })).toBe('Đọc nến 1m (5 → 100 nến)');
    expect(describeToolUse('get_klines', { tf: '1h', limit: 300 })).toBe('Đọc nến 1h (300 nến)');
  });
});
