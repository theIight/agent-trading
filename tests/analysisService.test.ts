import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tfSeconds, type AnalysisSubmissionInput, type Candle, type ProgressEvent, type RunnerId } from '@wca/shared';
import { openDb } from '../apps/server/src/db/index.ts';
import { AnalysisRepo } from '../apps/server/src/analysis/repo.ts';
import { AnalysisService } from '../apps/server/src/analysis/service.ts';
import { KlineService } from '../apps/server/src/market/klineService.ts';
import type { FetchKlinesParams, MarketDataProvider } from '../apps/server/src/market/provider.ts';
import type { AgentRunHooks, AgentRunRequest, AgentRunner, AgentRunOutcome } from '../apps/server/src/runner/types.ts';

// Dữ liệu giả: nến kết thúc từ 1 ngày trước → mọi nến đều đã đóng.
const END = Math.floor(Date.now() / 1000) - 86400;
class FakeProvider implements MarketDataProvider {
  name = 'fake';
  maxLimit = 1500;
  async fetchKlines(p: FetchKlinesParams): Promise<Candle[]> {
    const step = tfSeconds(p.tf);
    const last = END - (END % step);
    return Array.from({ length: p.limit }, (_, i) => ({
      time: last - (p.limit - 1 - i) * step,
      open: 100, high: 110, low: 90, close: 100, volume: 1,
    }));
  }
}

type Behavior = (req: AgentRunRequest, hooks: AgentRunHooks, service: AnalysisService) => Promise<AgentRunOutcome>;

class FakeRunner implements AgentRunner {
  readonly label: string;
  readonly supportsScreenshot = true;
  service!: AnalysisService;
  lastReq: AgentRunRequest | null = null;
  constructor(
    private behavior: Behavior,
    readonly id: RunnerId = 'claude-code',
    private available = true,
  ) {
    this.label = `fake-${id}`;
  }
  availability() {
    return this.available ? { available: true } : { available: false, reason: 'không cài' };
  }
  async listModels() {
    return [{ id: 'm1', label: 'M1' }];
  }
  run(req: AgentRunRequest, hooks: AgentRunHooks) {
    this.lastReq = req;
    return this.behavior(req, hooks, this.service);
  }
}

function setup(behavior: Behavior) {
  const db = openDb(':memory:');
  const repo = new AnalysisRepo(db);
  const klines = new KlineService(db, new FakeProvider(), 0);
  const runner = new FakeRunner(behavior);
  const service = new AnalysisService(repo, klines, runner, {
    maxTfs: 4,
    barsPerTf: 300,
    screenshotDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wca-')),
    validationBars: 300,
  });
  runner.service = service;
  const events: ProgressEvent[] = [];
  service.subscribe(e => events.push(e));
  return { service, repo, events };
}

const lastH4 = () => {
  const s = tfSeconds('4h');
  return END - (END % s);
};

function submission(over: Partial<AnalysisSubmissionInput> = {}): AnalysisSubmissionInput {
  return {
    symbol: 'BTCUSDT', primaryTf: '4h', schematic: 'ACCUMULATION', currentPhase: 'C', bias: 'BULLISH', confidence: 0.7,
    summary: 'Tích luỹ 4H sau SC, Spring đã test với volume thấp; khung 1D vẫn trong range lớn, 5m xác nhận LPS.',
    topDown: [
      { tf: '1d', role: 'HTF', bias: 'BULLISH', note: 'Range lớn, đáy SC giữ vững' },
      { tf: '4h', role: 'PRIMARY', bias: 'BULLISH', note: 'Spring + test volume thấp' },
      { tf: '5m', role: 'LTF', bias: 'BULLISH', note: 'LPS với volume cạn dần' },
    ],
    events: [{ type: 'SC', tf: '4h', time: lastH4() - 20 * 14400, price: 90 }],
    tradePlan: {
      decision: 'ENTER',
      reason: 'LPS xác nhận trên khung 5m',
      setups: [{ name: 'Long LPS', direction: 'LONG', entryType: 'MARKET', tf: '5m', trigger: 'LPS', entryLow: 100, entryHigh: 100, stopLoss: 95, takeProfits: [110] }],
    },
    ...over,
  };
}

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 5));
  }
};

describe('AnalysisService', () => {
  it('từ chối lựa chọn khung không hợp lệ', () => {
    const { service } = setup(async () => ({ ok: true }));
    expect(() => service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: ['4h'] })).toThrow(/trùng/);
    expect(() => service.start({ symbol: 'BTCUSDT', primaryTf: '2h', contextTfs: [] })).toThrow(/không hỗ trợ/);
  });

  it('luồng đầy đủ: agent nộp sai → bị từ chối → nộp lại đúng → DONE + phát sự kiện', async () => {
    const { service, repo, events } = setup(async (req, hooks, svc) => {
      hooks.onStep('Đọc nến 1d');
      expect(req.plan.map(p => p.tf)).toEqual(['1d', '4h', '5m']);
      const info = await svc.getRequest(req.analysisId);
      expect(info).toMatchObject({ primaryTf: '4h', lastClose: 100, minRiskReward: 2 });
      const bad = await svc.submit(req.analysisId, submission({ topDown: [{ tf: '4h', role: 'PRIMARY', bias: 'BULLISH' }] }));
      expect(bad.ok).toBe(false);
      const good = await svc.submit(req.analysisId, submission());
      expect(good.ok).toBe(true);
      return { ok: true, costUsd: 0, durationMs: 1000 };
    });
    const rec = service.start({ symbol: 'btcusdt', primaryTf: '4h', contextTfs: ['5m', '1d'] });
    expect(rec.tfs).toEqual(['1d', '4h', '5m']);
    await waitFor(() => repo.get(rec.id)?.status === 'DONE');
    const done = repo.get(rec.id)!;
    expect(done.result?.action).toMatchObject({ type: 'LONG', riskReward: 2 });
    expect(done.result?.tradePlan).toMatchObject({ decision: 'ENTER', setups: [{ riskReward: 2 }] });
    expect(done.result?.asOf).toBe(lastH4()); // nến 4h cuối cùng đã đóng
    expect(events.some(e => e.kind === 'step' && e.message.includes('bị từ chối'))).toBe(true);
    expect(events.some(e => e.kind === 'result' && e.record.status === 'DONE')).toBe(true);
  });

  it('agent kết thúc mà không nộp → FAILED', async () => {
    const { service, repo } = setup(async () => ({ ok: true, resultText: 'Không đủ dữ liệu' }));
    const rec = service.start({ symbol: 'BTCUSDT', primaryTf: '1h', contextTfs: [] });
    await waitFor(() => repo.get(rec.id)?.status === 'FAILED');
    expect(repo.get(rec.id)!.error).toContain('chưa nộp');
  });

  it('chạy tuần tự và hủy được job đang chạy', async () => {
    const order: string[] = [];
    const { service, repo } = setup(async (req, hooks) => {
      order.push(req.analysisId);
      await new Promise<void>(resolve => hooks.signal.addEventListener('abort', () => resolve()));
      return { ok: false, error: 'Đã hủy' };
    });
    const a = service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [] });
    const b = service.start({ symbol: 'BTCUSDT', primaryTf: '1h', contextTfs: [] });
    await waitFor(() => order.length === 1);
    expect(service.cancel(b.id)).toBe(true); // hủy job đang chờ
    expect(repo.get(b.id)!.status).toBe('CANCELED');
    expect(service.cancel(a.id)).toBe(true); // hủy job đang chạy
    await waitFor(() => repo.get(a.id)?.status === 'CANCELED');
    expect(order).toEqual([a.id]);
  });

  it('nộp không kèm analysisId (Claude Code tương tác) → tạo bản ghi mới', async () => {
    const { service, repo } = setup(async () => ({ ok: true }));
    const res = await service.submit(undefined, submission());
    expect(res.ok).toBe(true);
    if (res.ok) {
      const rec = repo.get(res.analysisId)!;
      expect(rec.status).toBe('DONE');
      expect(rec.tfs).toEqual(['1d', '4h', '5m']);
    }
  });

  it('chọn runner theo request, ghi runner/model vào bản ghi; runner không bật / không khả dụng → lỗi', async () => {
    const db = openDb(':memory:');
    const repo = new AnalysisRepo(db);
    const klines = new KlineService(db, new FakeProvider(), 0);
    const done: Behavior = async () => ({ ok: false, error: 'stop' });
    const claude = new FakeRunner(done, 'claude-code');
    const agy = new FakeRunner(done, 'agy');
    const service = new AnalysisService(repo, klines, [claude, agy], {
      maxTfs: 4, barsPerTf: 300, screenshotDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wca-')), defaultRunner: 'agy',
    });
    expect(service.defaultRunnerId).toBe('agy');
    const rec = service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], model: 'gemini-4-argon-high' });
    await waitFor(() => repo.get(rec.id)?.status === 'FAILED');
    expect(repo.get(rec.id)).toMatchObject({ runner: 'agy', model: 'gemini-4-argon-high' });
    expect(agy.lastReq?.model).toBe('gemini-4-argon-high');
    expect(claude.lastReq).toBeNull();

    const rec2 = service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], runner: 'claude-code' });
    await waitFor(() => repo.get(rec2.id)?.status === 'FAILED');
    expect(claude.lastReq?.model).toBeUndefined();

    expect(() => service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], runner: 'gpt' })).toThrow(/không được bật/);
    expect(() => service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], model: 'x; rm -rf /' })).toThrow(/model không hợp lệ/);
    const off = new AnalysisService(repo, klines, [new FakeRunner(done, 'agy', false)], { maxTfs: 4, barsPerTf: 300, screenshotDir: os.tmpdir() });
    expect(() => off.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [] })).toThrow(/không khả dụng/);
    const infos = await service.runnerInfos();
    expect(infos.map(i => [i.id, i.available, i.models.length])).toEqual([['claude-code', true, 1], ['agy', true, 1]]);
  });

  it('có analysisId: thiếu symbol/primaryTf → server điền + warning; sai → lỗi; không có analysisId → lỗi', async () => {
    const { service, repo } = setup(async (req, _hooks, svc) => {
      const { symbol: _s, ...noSymbol } = submission();
      const wrong = await svc.submit(req.analysisId, { ...noSymbol, symbol: 'ETHUSDT' });
      expect(wrong.ok).toBe(false);
      const { primaryTf: _p, ...noBoth } = noSymbol;
      const res = await svc.submit(req.analysisId, noBoth);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.warnings[0]).toBe('Server điền symbol, primaryTf từ yêu cầu phân tích');
      return { ok: true, durationMs: 1 };
    });
    const rec = service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: ['1d', '5m'] });
    await waitFor(() => repo.get(rec.id)?.status === 'DONE');
    expect(repo.get(rec.id)?.result?.symbol).toBe('BTCUSDT');
    const { symbol: _s2, ...noSymbol } = submission();
    expect((await service.submit(undefined, noSymbol)).ok).toBe(false);
  });
});
