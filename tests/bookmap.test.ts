import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analysisSubmissionSchema,
  checkStaleness,
  tfSeconds,
  toAppPrice,
  type AnalysisSubmissionInput,
  type Candle,
  type Orderflow,
} from '@wca/shared';
import { openDb } from '../apps/server/src/db/index.ts';
import { AnalysisRepo } from '../apps/server/src/analysis/repo.ts';
import { AnalysisService } from '../apps/server/src/analysis/service.ts';
import { KlineService } from '../apps/server/src/market/klineService.ts';
import type { FetchKlinesParams, MarketDataProvider } from '../apps/server/src/market/provider.ts';
import type { AgentRunHooks, AgentRunRequest, AgentRunner, AgentRunOutcome } from '../apps/server/src/runner/types.ts';
import { validateOrderflow, type OrderflowContext } from '../apps/server/src/validate/orderflow.ts';
import { buildUserPrompt } from '../apps/server/src/runner/prompt.ts';
import { buildAgyPromptSuffix, SUBMIT_FORMAT_APPENDIX } from '../apps/server/src/runner/agyFormat.ts';

const PNG = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
const JPG = 'data:image/jpeg;base64,' + Buffer.from('fake-jpg').toString('base64');

describe('quy đổi & kiểm tra ảnh cũ', () => {
  it('giá app = giá Bookmap − offset', () => {
    expect(toAppPrice(4078, 10)).toBe(4068);
    expect(toAppPrice(4061.5, 10)).toBe(4051.5);
    expect(toAppPrice(73000, 0)).toBe(73000);
  });

  const base = { offset: 10, tolerance: 3, capturedAt: 1000, submittedAt: 1060, maxAgeSec: 1800 };

  it('vàng lệch offset 2 → không cảnh báo; lệch 15 → cảnh báo ảnh cũ', () => {
    const ok = checkStaleness({ ...base, refPrice: 4049.5, lastPrices: [{ image: 'ltf', bookmapPrice: 4061.5 }] });
    expect(ok.warnings).toEqual([]);
    expect(ok.measuredOffset).toBe(12);
    const stale = checkStaleness({ ...base, refPrice: 4036.5, lastPrices: [{ image: 'htf', bookmapPrice: 4061.5 }] });
    expect(stale.warnings).toHaveLength(1);
    expect(stale.warnings[0]).toMatch(/có thể đã cũ/);
    expect(stale.measuredOffset).toBe(25);
  });

  it('ưu tiên ảnh khung bé khi tính measuredOffset; ảnh quá 30 phút → cảnh báo', () => {
    const r = checkStaleness({
      ...base,
      submittedAt: 1000 + 3600,
      refPrice: 4050,
      lastPrices: [{ image: 'htf', bookmapPrice: 4061 }, { image: 'ltf', bookmapPrice: 4060.5 }],
    });
    expect(r.measuredOffset).toBe(10.5);
    expect(r.warnings).toEqual(['Ảnh Bookmap chụp cách lúc gửi 60 phút — có thể đã cũ']);
  });

  it('thiếu giá cuối hoặc thiếu giá app → cảnh báo không kiểm tra được', () => {
    expect(checkStaleness({ ...base, refPrice: 4050, lastPrices: [] }).warnings[0]).toMatch(/không đọc được giá cuối/);
    expect(checkStaleness({ ...base, refPrice: null, lastPrices: [{ image: 'ltf', bookmapPrice: 4060 }] }).warnings[0]).toMatch(/Không có giá app/);
  });
});

describe('validateOrderflow', () => {
  const candles: Candle[] = Array.from({ length: 50 }, (_, i) => ({ time: i * 60, open: 4050, high: 4055, low: 4045, close: 4050, volume: 1 }));
  const primary = { candles, atr: 10 }; // vùng hợp lệ (đã quy đổi): [4045 − 30, 4055 + 30] = [4015, 4085]
  const ctx: OrderflowContext = {
    images: ['htf', 'ltf'], capturedAt: 1000, submittedAt: 1060, offset: 10, tolerance: 3, instrument: 'GC', refPrice: 4051.5, maxAgeSec: 1800,
  };
  const of = (over: Partial<Orderflow> = {}): Orderflow => ({
    lastPrices: [{ image: 'ltf', bookmapPrice: 4061.5 }],
    summary: 'Bán mạnh ở đáy bị hấp thụ, CVD quay lên.',
    cvd: '',
    levels: [
      { kind: 'ASK_WALL', image: 'htf', bookmapPrice: 4078, size: 77, sizeSource: 'COB', strength: 0.8, note: '', price: 1 },
      { kind: 'POC', image: 'ltf', bookmapPrice: 4054.5, size: 8135, sizeSource: 'SVP', strength: 0.7, note: '' },
    ],
    offset: 999,
    ...over,
  });

  it('server tự quy đổi price, ghi đè offset agent gửi, tính measuredOffset', () => {
    const r = validateOrderflow(of(), ctx, primary);
    expect(r.warnings).toEqual([]);
    expect(r.orderflow?.levels.map(l => [l.kind, l.price, l.size])).toEqual([['ASK_WALL', 4068, 77], ['POC', 4044.5, 8135]]);
    expect(r.orderflow).toMatchObject({ offset: 10, measuredOffset: 10 });
  });

  it('bỏ mức ngoài vùng giá, mức của ảnh không gửi, size thiếu nguồn', () => {
    const r = validateOrderflow(
      of({
        levels: [
          { kind: 'BID_WALL', image: 'ltf', bookmapPrice: 3900, strength: 0.5, note: '' },
          { kind: 'HVN', image: 'ltf', bookmapPrice: 4060, size: 12, strength: 0.5, note: '' },
        ],
      }),
      { ...ctx, images: ['ltf'] },
      primary,
    );
    expect(r.orderflow?.levels).toEqual([{ kind: 'HVN', image: 'ltf', bookmapPrice: 4060, price: 4050, strength: 0.5, note: '' }]);
    expect(r.warnings.some(w => w.includes('ngoài vùng giá'))).toBe(true);
    expect(r.warnings.some(w => w.includes('thiếu sizeSource'))).toBe(true);
  });

  it('setup dùng giá Bookmap chưa quy đổi làm TP → cảnh báo; giá đã quy đổi → không', () => {
    const setup = (tp: number) => ({
      name: 'Long LPS', direction: 'LONG' as const, entryType: 'LIMIT' as const, tf: '1h' as const, trigger: 'LPS' as const, triggerNote: '',
      entryLow: 4022, entryHigh: 4032, stopLoss: 4005, takeProfits: [tp], confidence: 0.5, rationale: '',
    });
    const bad = validateOrderflow(of(), ctx, primary, [setup(4078)]);
    expect(bad.warnings).toEqual([expect.stringContaining('TP1 = 4078 trùng giá Bookmap CHƯA quy đổi của mức ASK_WALL (4078); trên chart mức này ở 4068')]);
    expect(validateOrderflow(of(), ctx, primary, [setup(4066)]).warnings).toEqual([]);
    expect(validateOrderflow(of(), { ...ctx, offset: 0.3 }, primary, [setup(4078)]).warnings.some(w => w.includes('CHƯA quy đổi'))).toBe(false);
  });

  it('không có ảnh mà vẫn nộp → bỏ; có ảnh mà không nộp → cảnh báo', () => {
    expect(validateOrderflow(of(), undefined, primary)).toEqual({ warnings: ['Bỏ orderflow: phân tích này không có ảnh Bookmap'] });
    expect(validateOrderflow(undefined, ctx, primary)).toEqual({ warnings: ['Có ảnh Bookmap nhưng agent không nộp orderflow'] });
  });
});

// ---------- Tích hợp AnalysisService ----------

const END = Math.floor(Date.now() / 1000) - 86400;
class FakeProvider implements MarketDataProvider {
  name = 'fake';
  maxLimit = 1500;
  async fetchKlines(p: FetchKlinesParams): Promise<Candle[]> {
    const step = tfSeconds(p.tf);
    const last = END - (END % step);
    return Array.from({ length: p.limit }, (_, i) => ({ time: last - (p.limit - 1 - i) * step, open: 100, high: 110, low: 90, close: 100, volume: 1 }));
  }
}

type Behavior = (req: AgentRunRequest, hooks: AgentRunHooks, service: AnalysisService) => Promise<AgentRunOutcome>;

class FakeRunner implements AgentRunner {
  readonly id = 'claude-code' as const;
  readonly label = 'fake';
  readonly supportsScreenshot = true;
  service!: AnalysisService;
  lastReq: AgentRunRequest | null = null;
  constructor(
    private behavior: Behavior,
    readonly supportsBookmap = true,
  ) {}
  availability() {
    return { available: true };
  }
  async listModels() {
    return [];
  }
  run(req: AgentRunRequest, hooks: AgentRunHooks) {
    this.lastReq = req;
    return this.behavior(req, hooks, this.service);
  }
}

function setup(behavior: Behavior, supportsBookmap = true) {
  const db = openDb(':memory:');
  const repo = new AnalysisRepo(db);
  const runner = new FakeRunner(behavior, supportsBookmap);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-bm-'));
  const service = new AnalysisService(repo, new KlineService(db, new FakeProvider(), 0), runner, {
    maxTfs: 4,
    barsPerTf: 300,
    screenshotDir: dir,
    validationBars: 300,
    bookmap: { symbols: ['XAUUSD', 'BTCUSDT'], offsets: { BTCUSDT: 10 }, tolerances: { BTCUSDT: 3 }, maxAgeMin: 30 },
  });
  runner.service = service;
  return { service, repo, runner, dir };
}

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 5));
  }
};

const lastH4 = () => END - (END % tfSeconds('4h'));

function submission(over: Partial<AnalysisSubmissionInput> = {}): AnalysisSubmissionInput {
  return {
    symbol: 'BTCUSDT', primaryTf: '4h', schematic: 'ACCUMULATION', currentPhase: 'C', bias: 'BULLISH', confidence: 0.7,
    summary: 'Tích luỹ 4H sau SC, Spring đã test với volume thấp; khung 1D vẫn trong range lớn, 5m xác nhận LPS.',
    topDown: [{ tf: '4h', role: 'PRIMARY', bias: 'BULLISH', note: 'Spring + test volume thấp' }],
    events: [{ type: 'SC', tf: '4h', time: lastH4() - 20 * 14400, price: 90 }],
    tradePlan: { decision: 'STAND_ASIDE', reason: 'Chờ LPS xác nhận trên khung nhỏ', reconsiderWhen: 'LPS trên 95 với volume thấp' },
    ...over,
  };
}

describe('AnalysisService + Bookmap', () => {
  it('symbol ngoài danh sách / thiếu ảnh / sai định dạng / runner không hỗ trợ → lỗi', () => {
    const { service } = setup(async () => ({ ok: true }));
    expect(() => service.start({ symbol: 'ETHUSDT', primaryTf: '4h', contextTfs: [], bookmap: { htf: PNG } })).toThrow(/chỉ hỗ trợ XAUUSD, BTCUSDT/);
    expect(() => service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], bookmap: {} })).toThrow(/ít nhất 1 ảnh/);
    expect(() => service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], bookmap: { htf: 'data:image/gif;base64,AAAA' } })).toThrow(/PNG hoặc JPEG/);
    const { service: s2 } = setup(async () => ({ ok: true }), false);
    expect(() => s2.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], bookmap: { htf: PNG } })).toThrow(/không nhận được ảnh Bookmap/);
  });

  it('lưu ảnh + meta, request/MCP có bookmap, submit quy đổi giá + cảnh báo ảnh cũ', async () => {
    const { service, repo, runner, dir } = setup(async (req, _hooks, svc) => {
      expect(req.hasBookmap).toBe(true);
      const info = await svc.getRequest(req.analysisId);
      expect(info.bookmap).toMatchObject({ images: ['htf', 'ltf'], offset: 10, refPrice: 100 });
      const imgs = await svc.bookmapImages(req.analysisId);
      expect(imgs.images.map(i => [i.role, i.mimeType])).toEqual([['htf', 'image/png'], ['ltf', 'image/jpeg']]);
      const res = await svc.submit(
        req.analysisId,
        submission({
          orderflow: {
            lastPrices: [{ image: 'ltf', bookmapPrice: 125 }], // quy đổi 115, giá app 100 → ảnh cũ
            summary: 'Tường bán dày phía trên, CVD đi ngang.',
            levels: [{ kind: 'ASK_WALL', image: 'htf', bookmapPrice: 120, size: 5, sizeSource: 'COB' }],
          },
        }),
      );
      expect(res.ok).toBe(true);
      return { ok: true, durationMs: 1 };
    });
    const rec = service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], bookmap: { htf: PNG, ltf: JPG, capturedAt: END } });
    expect(rec.bookmap).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual([`${rec.id}-bookmap-htf.png`, `${rec.id}-bookmap-ltf.jpg`, `${rec.id}-bookmap.json`].sort());
    await waitFor(() => repo.get(rec.id)?.status === 'DONE');
    const done = repo.get(rec.id)!;
    expect(done.bookmap).toBe(true);
    expect(repo.list().find(r => r.id === rec.id)?.bookmap).toBe(true);
    expect(done.result?.orderflow).toMatchObject({ offset: 10, measuredOffset: 25, levels: [{ price: 110, size: 5 }] });
    expect(done.result?.warnings.some(w => w.includes('có thể đã cũ: giá cuối 125'))).toBe(true);
    expect(done.result?.warnings.some(w => w.includes('chụp cách lúc gửi'))).toBe(true); // capturedAt = END (1 ngày trước)
    expect(runner.lastReq?.hasBookmap).toBe(true);
  });

  it('offset người dùng nhập ghi đè mặc định; không có Bookmap → orderflow bị bỏ', async () => {
    const { service, repo } = setup(async (req, _hooks, svc) => {
      const info = await svc.getRequest(req.analysisId);
      if (req.hasBookmap) expect(info.bookmap?.offset).toBe(4);
      else expect(info.bookmap).toBeNull();
      const res = await svc.submit(req.analysisId, submission({ orderflow: { summary: 'x', levels: [] } }));
      expect(res.ok).toBe(true);
      return { ok: true, durationMs: 1 };
    });
    const a = service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [], bookmap: { ltf: PNG, offset: 4 } });
    const b = service.start({ symbol: 'BTCUSDT', primaryTf: '4h', contextTfs: [] });
    await waitFor(() => repo.get(b.id)?.status === 'DONE');
    expect(repo.get(a.id)?.result?.orderflow?.offset).toBe(4);
    expect(repo.get(b.id)?.bookmap).toBeUndefined();
    expect(repo.get(b.id)?.result?.orderflow).toBeUndefined();
    expect(repo.get(b.id)?.result?.warnings).toContain('Bỏ orderflow: phân tích này không có ảnh Bookmap');
  });
});

describe('prompt & định dạng', () => {
  const plan = [{ tf: '4h' as const, role: 'PRIMARY' as const }];
  const req = { analysisId: 'abc', symbol: 'XAUUSD', primaryTf: '4h' as const, plan, barsPerTf: 300, hasScreenshot: false };

  it('prompt nhắc get_bookmap_images chỉ khi có ảnh; skeleton agy có orderflow', () => {
    expect(buildUserPrompt({ ...req, hasBookmap: true })).toContain('get_bookmap_images');
    expect(buildUserPrompt(req)).not.toContain('get_bookmap_images');
    expect(buildAgyPromptSuffix({ ...req, hasBookmap: true })).toContain('"orderflow"');
    expect(buildAgyPromptSuffix(req)).not.toContain('"orderflow"');
    expect(SUBMIT_FORMAT_APPENDIX).toContain('ASK_WALL');
  });

  it('schema chấp nhận orderflow tối thiểu', () => {
    const r = analysisSubmissionSchema.safeParse({ ...submission(), orderflow: { summary: 'Hấp thụ ở đáy' } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.orderflow).toMatchObject({ lastPrices: [], levels: [], cvd: '' });
  });
});
