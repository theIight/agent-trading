import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BOOKMAP_IMAGE_ROLES,
  bookmapInstrumentLabel,
  buildTfPlan,
  isRunnerId,
  normalizeSymbol,
  normalizeTfInput,
  type RunnerId,
  type RunnerInfo,
  type InstrumentInfo,
  type AnalysisRecord,
  type AnalysisResult,
  type BookmapImageRole,
  type BookmapMeta,
  type Candle,
  type ProgressEvent,
  type TfPlanEntry,
  type Timeframe,
} from '@wca/shared';
import type { KlineService } from '../market/klineService.ts';
import type { AgentRunner } from '../runner/types.ts';
import { imageStatus, inspectImage, type BookmapImageFile, type BookmapImageStatus } from './bookmapSource.ts';
import { referencedTfs, validateSubmission } from '../validate/index.ts';
import type { AnalysisRepo } from './repo.ts';
import type { BinanceOrderflow } from '../orderflow/binanceOrderflow.ts';
import { cvdText, type BinanceOrderflowSnapshot } from '../orderflow/calc.ts';

export interface StartInput {
  symbol: string;
  primaryTf: unknown;
  contextTfs: unknown[];
  /** data URL PNG chụp từ UI (tùy chọn). */
  screenshot?: string;
  /** Agent chạy phân tích (mặc định: `defaultRunner`). */
  runner?: unknown;
  model?: string;
  /** Dùng ảnh Bookmap (đọc từ đường dẫn cấu hình ở server), chỉ cho symbol có cấu hình. */
  bookmap?: BookmapInput;
  /** Dùng order flow Binance (server tự tính), chỉ cho symbol bật collector. */
  orderflow?: boolean;
}

export interface BookmapInput {
  /** Giá Bookmap − giá app; thiếu → mặc định theo symbol. */
  offset?: number;
}

export interface BookmapOptions {
  /** Đường dẫn ảnh theo symbol / khung (đã mở rộng `~`). */
  images: Record<string, Partial<Record<BookmapImageRole, string>>>;
  offsets: Record<string, number>;
  tolerances: Record<string, number>;
  maxAgeMin: number;
}

export interface ServiceOptions {
  maxTfs: number;
  barsPerTf: number;
  screenshotDir: string;
  /** Số nến nạp khi validate (rộng hơn barsPerTf để chấp nhận event agent tìm được khi tự tải thêm). */
  validationBars?: number;
  /** R:R tối thiểu của trade setup (mặc định 2). */
  minRiskReward?: number;
  /** Runner mặc định khi request không chỉ định (mặc định: runner đầu tiên). */
  defaultRunner?: RunnerId;
  /** Thông tin nguồn dữ liệu của symbol (đưa vào prompt / get_analysis_request). */
  instrumentOf?: (symbol: string) => InstrumentInfo;
  /** Không có → không nhận ảnh Bookmap. */
  bookmap?: BookmapOptions;
  /** Không có → không có order flow Binance. */
  binanceOrderflow?: BinanceOrderflow;
}

/** Không có ngưỡng cho symbol → coi như không giới hạn (không cảnh báo lệch offset). */
const NO_TOLERANCE = 1e12;
const BOOKMAP_EXT = { png: 'png', jpeg: 'jpg' } as const;

interface PendingBookmap {
  offset: number;
  tolerance: number;
  instrument: string;
}

export type SubmitOutcome =
  | { ok: true; analysisId: string; warnings: string[] }
  | { ok: false; errors: string[] };

interface Job {
  id: string;
  runner: RunnerId;
  req: {
    symbol: string;
    primaryTf: Timeframe;
    plan: TfPlanEntry[];
    hasScreenshot: boolean;
    hasBookmap: boolean;
    hasBinanceOrderflow: boolean;
    model?: string;
  };
  /** Ảnh Bookmap được copy khi job bắt đầu chạy (ảnh mới nhất dù phải chờ hàng đợi). */
  bookmap?: PendingBookmap;
}

export class ServiceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Điều phối phân tích: tạo bản ghi, chạy agent tuần tự (1 job/lần), nhận kết quả từ MCP,
 * validate và phát sự kiện tiến trình (SSE).
 */
export class AnalysisService {
  private readonly bus = new EventEmitter();
  private readonly queue: Job[] = [];
  private current: { id: string; abort: AbortController } | null = null;
  private models = new Map<string, string>();
  private readonly runners = new Map<RunnerId, AgentRunner>();
  private readonly defaultRunner: RunnerId;

  constructor(
    private readonly repo: AnalysisRepo,
    private readonly klines: KlineService,
    runners: AgentRunner | AgentRunner[],
    private readonly opts: ServiceOptions,
  ) {
    const list = Array.isArray(runners) ? runners : [runners];
    if (!list.length) throw new Error('Cần ít nhất một agent runner');
    for (const r of list) this.runners.set(r.id, r);
    this.defaultRunner = opts.defaultRunner && this.runners.has(opts.defaultRunner) ? opts.defaultRunner : list[0]!.id;
    this.bus.setMaxListeners(100);
    fs.mkdirSync(opts.screenshotDir, { recursive: true });
  }

  // ---------- Sự kiện ----------
  subscribe(listener: (e: ProgressEvent) => void, analysisId?: string): () => void {
    const handler = (e: ProgressEvent) => {
      if (!analysisId || e.analysisId === analysisId) listener(e);
    };
    this.bus.on('event', handler);
    return () => this.bus.off('event', handler);
  }

  private emit(e: ProgressEvent): void {
    this.bus.emit('event', e);
  }

  // ---------- Runner ----------
  async runnerInfos(): Promise<RunnerInfo[]> {
    return Promise.all(
      [...this.runners.values()].map(async r => {
        const a = r.availability();
        return {
          id: r.id,
          label: r.label,
          available: a.available,
          reason: a.reason,
          defaultModel: r.defaultModel,
          models: a.available ? await r.listModels().catch(() => []) : [],
          supportsScreenshot: r.supportsScreenshot,
          supportsBookmap: r.supportsBookmap,
        };
      }),
    );
  }

  get defaultRunnerId(): RunnerId {
    return this.defaultRunner;
  }

  // ---------- Khởi chạy ----------
  start(input: StartInput): AnalysisRecord {
    const symbol = normalizeSymbol(input.symbol);
    if (!symbol) throw new ServiceError('Thiếu symbol');
    const runnerId = input.runner === undefined ? this.defaultRunner : input.runner;
    if (!isRunnerId(runnerId) || !this.runners.has(runnerId)) throw new ServiceError(`Agent không được bật: ${String(runnerId)}`);
    const runner = this.runners.get(runnerId)!;
    const avail = runner.availability();
    if (!avail.available) throw new ServiceError(`${runner.label} không khả dụng: ${avail.reason ?? 'không rõ'}`);
    const model = input.model?.trim() || undefined;
    if (model && !/^[\w.:/-]{1,80}$/.test(model)) throw new ServiceError('Tên model không hợp lệ');
    const planRes = buildTfPlan(input.primaryTf, input.contextTfs ?? [], this.opts.maxTfs);
    if (!planRes.ok) throw new ServiceError(planRes.error);
    const id = randomUUID();
    const primaryTf = input.primaryTf as Timeframe;
    if (input.bookmap && input.orderflow) throw new ServiceError('Chọn một nguồn order flow: ảnh Bookmap hoặc Binance');
    const bookmap = input.bookmap ? this.prepareBookmap(symbol, input.bookmap, runner) : null;
    const binanceOf = Boolean(input.orderflow);
    if (binanceOf && !this.opts.binanceOrderflow?.has(symbol)) {
      throw new ServiceError(`Chưa bật order flow Binance cho ${symbol} (ORDERFLOW_BINANCE_SYMBOLS)`);
    }

    let hasScreenshot = false;
    if (input.screenshot) {
      const m = /^data:image\/png;base64,(.+)$/.exec(input.screenshot);
      if (!m) throw new ServiceError('screenshot phải là data URL PNG');
      fs.writeFileSync(this.screenshotPath(id), Buffer.from(m[1]!, 'base64'));
      hasScreenshot = true;
    }

    const rec: AnalysisRecord = {
      id,
      symbol,
      primaryTf,
      tfs: planRes.plan.map(p => p.tf),
      status: 'RUNNING',
      createdAt: Date.now(),
      runner: runnerId,
      model,
      ...(bookmap ? { bookmap: true, orderflowSource: 'bookmap-image' as const } : {}),
      ...(binanceOf ? { orderflowSource: 'binance' as const } : {}),
    };
    this.repo.create(rec);
    this.queue.push({
      id,
      runner: runnerId,
      req: {
        symbol,
        primaryTf,
        plan: planRes.plan,
        hasScreenshot: hasScreenshot && runner.supportsScreenshot,
        hasBookmap: Boolean(bookmap),
        hasBinanceOrderflow: binanceOf,
        model,
      },
      ...(bookmap ? { bookmap } : {}),
    });
    if (this.current) this.emitStep(id, `Đang chờ: còn ${this.queue.length} phân tích phía trước`);
    void this.pump();
    return rec;
  }

  /** Symbol có cấu hình ít nhất một đường dẫn ảnh Bookmap (trừ symbol đã dùng order flow Binance). */
  get bookmapSymbols(): string[] {
    return Object.entries(this.opts.bookmap?.images ?? {})
      .filter(([sym, roles]) => Object.values(roles).some(Boolean) && !this.opts.binanceOrderflow?.has(sym))
      .map(([sym]) => sym);
  }

  /** Symbol bật order flow Binance. */
  get orderflowSymbols(): string[] {
    return this.opts.binanceOrderflow?.symbols ?? [];
  }

  orderflowStatus(symbol: string) {
    const st = this.opts.binanceOrderflow?.status(normalizeSymbol(symbol));
    if (!st) throw new ServiceError(`Chưa bật order flow Binance cho ${symbol}`, 404);
    return st;
  }

  orderflowSnapshotPath(id: string): string {
    return path.join(this.opts.screenshotDir, `${this.safeId(id)}-orderflow.json`);
  }

  readOrderflowSnapshot(id: string): BinanceOrderflowSnapshot | null {
    try {
      return JSON.parse(fs.readFileSync(this.orderflowSnapshotPath(id), 'utf8')) as BinanceOrderflowSnapshot;
    } catch {
      return null;
    }
  }

  /** Order flow Binance đã chụp lúc job bắt đầu (cho MCP get_orderflow). */
  orderflowSnapshot(id: string): BinanceOrderflowSnapshot {
    if (!this.repo.get(id)) throw new ServiceError('Không tìm thấy analysisId', 404);
    const snap = this.readOrderflowSnapshot(id);
    if (!snap) throw new ServiceError('Phân tích này không có order flow Binance', 404);
    return snap;
  }

  /** Lấy order flow Binance tại thời điểm job bắt đầu; basis tính theo giá chart (1m) hiện tại. */
  private async takeOrderflowSnapshot(id: string, symbol: string): Promise<BinanceOrderflowSnapshot> {
    const of = this.opts.binanceOrderflow;
    if (!of) throw new Error('Order flow Binance chưa bật');
    const appPrice = await this.klines
      .getKlines({ symbol, tf: '1m', limit: 2 })
      .then(res => res.candles.at(-1)?.close ?? null)
      .catch(() => null);
    const snap = await of.snapshot(symbol, appPrice);
    fs.writeFileSync(this.orderflowSnapshotPath(id), JSON.stringify(snap));
    return snap;
  }

  /** Trạng thái file ảnh Bookmap của symbol (cho panel xem trước). */
  bookmapStatus(symbol: string): BookmapImageStatus[] {
    const paths = this.opts.bookmap?.images[normalizeSymbol(symbol)];
    if (!paths) throw new ServiceError(`Chưa cấu hình ảnh Bookmap cho ${symbol}`, 404);
    return BOOKMAP_IMAGE_ROLES.filter(role => paths[role]).map(role => imageStatus(role, paths[role]));
  }

  /** File ảnh Bookmap hiện tại (cho ảnh xem trước). */
  bookmapPreview(symbol: string, role: string): BookmapImageFile {
    const paths = this.opts.bookmap?.images[normalizeSymbol(symbol)];
    const file = (BOOKMAP_IMAGE_ROLES as readonly string[]).includes(role) ? paths?.[role as BookmapImageRole] : undefined;
    if (!file) throw new ServiceError('Chưa cấu hình ảnh Bookmap này', 404);
    const r = inspectImage(file);
    if ('error' in r) throw new ServiceError(r.error, 404);
    return r;
  }

  private prepareBookmap(symbol: string, input: BookmapInput, runner: AgentRunner): PendingBookmap {
    const cfg = this.opts.bookmap;
    if (!cfg || !this.bookmapSymbols.includes(symbol)) {
      throw new ServiceError(`Chưa cấu hình ảnh Bookmap cho ${symbol} (BOOKMAP_IMAGE_${symbol}_HTF / _LTF)`);
    }
    if (!runner.supportsBookmap) throw new ServiceError(`${runner.label} không nhận được ảnh Bookmap`);
    return {
      offset: Number.isFinite(input.offset) ? input.offset! : (cfg.offsets[symbol] ?? 0),
      tolerance: cfg.tolerances[symbol] ?? NO_TOLERANCE,
      instrument: bookmapInstrumentLabel(symbol),
    };
  }

  /** Copy ảnh Bookmap tại thời điểm job bắt đầu; capturedAt = mtime cũ nhất. Lỗi → Error (job FAILED). */
  private snapshotBookmap(id: string, symbol: string, pending: PendingBookmap): BookmapMeta {
    const paths = this.opts.bookmap?.images[symbol] ?? {};
    const images: BookmapImageRole[] = [];
    const mtimes: number[] = [];
    const errors: string[] = [];
    for (const role of BOOKMAP_IMAGE_ROLES) {
      const src = paths[role];
      if (!src) continue;
      const r = inspectImage(src);
      if ('error' in r) {
        errors.push(r.error);
        continue;
      }
      fs.copyFileSync(src, this.bookmapImagePath(id, role, r.ext.slice(1)));
      images.push(role);
      mtimes.push(r.mtime);
    }
    if (!images.length) throw new Error(`Không đọc được ảnh Bookmap: ${errors.join('; ') || 'chưa cấu hình'}`);
    const now = Math.floor(Date.now() / 1000);
    const meta: BookmapMeta = { images, capturedAt: Math.min(now, ...mtimes), submittedAt: now, ...pending };
    fs.writeFileSync(this.bookmapMetaPath(id), JSON.stringify(meta));
    if (errors.length) this.emitStep(id, `Bỏ qua ảnh Bookmap lỗi: ${errors.join('; ')}`);
    return meta;
  }

  private safeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9-]/g, '');
  }

  bookmapMetaPath(id: string): string {
    return path.join(this.opts.screenshotDir, `${this.safeId(id)}-bookmap.json`);
  }

  bookmapImagePath(id: string, role: BookmapImageRole, ext: string): string {
    return path.join(this.opts.screenshotDir, `${this.safeId(id)}-bookmap-${role}.${ext}`);
  }

  readBookmapMeta(id: string): BookmapMeta | null {
    try {
      return JSON.parse(fs.readFileSync(this.bookmapMetaPath(id), 'utf8')) as BookmapMeta;
    } catch {
      return null;
    }
  }

  /** Meta ảnh Bookmap kèm giá app lúc chụp (close nến 1m chứa capturedAt; lấy một lần rồi lưu lại). */
  async bookmapContext(id: string, symbol: string): Promise<BookmapMeta | null> {
    const meta = this.readBookmapMeta(id);
    if (!meta || meta.refPrice !== undefined) return meta;
    try {
      const res = await this.klines.getKlines({ symbol, tf: '1m', limit: 5, endTime: meta.capturedAt });
      const bar = res.candles.find(c => c.time <= meta.capturedAt && meta.capturedAt < c.time + 60);
      meta.refPrice = bar?.close ?? null;
      fs.writeFileSync(this.bookmapMetaPath(id), JSON.stringify(meta));
    } catch {
      // Lỗi tạm thời (mạng / quota): không lưu, lần sau thử lại.
      return { ...meta, refPrice: null };
    }
    return meta;
  }

  /** Ảnh Bookmap (base64) + meta cho MCP. */
  async bookmapImages(id: string) {
    const rec = this.repo.get(id);
    if (!rec) throw new ServiceError('Không tìm thấy analysisId', 404);
    const meta = await this.bookmapContext(id, rec.symbol);
    if (!meta) throw new ServiceError('Phân tích này không có ảnh Bookmap', 404);
    const images = meta.images.flatMap(role => {
      for (const [mime, ext] of Object.entries(BOOKMAP_EXT)) {
        const file = this.bookmapImagePath(id, role, ext);
        if (fs.existsSync(file)) return [{ role, mimeType: `image/${mime}`, data: fs.readFileSync(file).toString('base64') }];
      }
      return [];
    });
    return { symbol: rec.symbol, meta, images };
  }

  cancel(id: string): boolean {
    if (this.current?.id === id) {
      this.current.abort.abort();
      return true;
    }
    const idx = this.queue.findIndex(j => j.id === id);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.finish(id, 'CANCELED', { error: 'Đã hủy' });
      return true;
    }
    return false;
  }

  isBusy(): boolean {
    return Boolean(this.current) || this.queue.length > 0;
  }

  private async pump(): Promise<void> {
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) return;
    const abort = new AbortController();
    this.current = { id: job.id, abort };
    const runner = this.runners.get(job.runner)!;
    const modelLabel = job.req.model ?? runner.defaultModel ?? 'model mặc định';
    this.emit({ kind: 'status', analysisId: job.id, status: 'RUNNING', message: `Khởi chạy ${runner.label} · ${modelLabel}` });
    this.models.set(job.id, `${runner.id} · ${modelLabel}`);
    try {
      if (job.bookmap) {
        const meta = this.snapshotBookmap(job.id, job.req.symbol, job.bookmap);
        this.emitStep(job.id, `Đã lấy ảnh Bookmap (${meta.images.join(', ')}), chụp lúc ${new Date(meta.capturedAt * 1000).toLocaleTimeString('vi-VN')}`);
      }
      if (job.req.hasBinanceOrderflow) {
        const snap = await this.takeOrderflowSnapshot(job.id, job.req.symbol);
        const walls = snap.walls.length;
        this.emitStep(job.id, `Đã lấy order flow Binance: ${walls} tường, lịch sử sổ lệnh ${Math.round(snap.historyMin)} phút, basis ${snap.basis}`);
        for (const n of snap.notes) this.emitStep(job.id, n);
      }
      const outcome = await runner.run(
        { analysisId: job.id, ...job.req, barsPerTf: this.opts.barsPerTf, instrument: this.opts.instrumentOf?.(job.req.symbol) },
        {
          signal: abort.signal,
          onStep: msg => this.emitStep(job.id, msg),
          onText: text => this.emit({ kind: 'text', analysisId: job.id, text: text.slice(0, 2000), at: Date.now() }),
          onModel: model => this.models.set(job.id, `${runner.id} · ${model}`),
        },
      );
      const rec = this.repo.get(job.id);
      if (rec?.status === 'RUNNING') {
        // Agent kết thúc mà chưa nộp kết quả hợp lệ.
        const canceled = abort.signal.aborted;
        this.finish(job.id, canceled ? 'CANCELED' : 'FAILED', {
          error: outcome.error ?? (outcome.resultText ? `Agent kết thúc mà chưa nộp kết quả: ${outcome.resultText.slice(0, 500)}` : 'Agent kết thúc mà chưa nộp kết quả'),
        });
      } else if (outcome.durationMs !== undefined) {
        this.emitStep(job.id, `Hoàn tất trong ${Math.round((outcome.durationMs ?? 0) / 1000)}s`);
      }
    } catch (err) {
      this.finish(job.id, 'FAILED', { error: (err as Error).message });
    } finally {
      this.current = null;
      this.models.delete(job.id);
      void this.pump();
    }
  }

  private emitStep(analysisId: string, message: string): void {
    this.emit({ kind: 'step', analysisId, message, at: Date.now() });
  }

  private finish(id: string, status: 'DONE' | 'FAILED' | 'CANCELED', payload: { result?: AnalysisResult; error?: string }): void {
    this.repo.finish(id, status, payload);
    const record = this.repo.get(id);
    this.emit({ kind: 'status', analysisId: id, status, message: payload.error });
    if (record) this.emit({ kind: 'result', analysisId: id, record });
  }

  // ---------- Dành cho MCP ----------
  async getRequest(id: string) {
    const rec = this.repo.get(id);
    if (!rec) throw new ServiceError('Không tìm thấy analysisId', 404);
    const planRes = buildTfPlan(rec.primaryTf, rec.tfs.filter(tf => tf !== rec.primaryTf));
    if (!planRes.ok) throw new ServiceError(planRes.error, 500);
    return {
      analysisId: rec.id,
      symbol: rec.symbol,
      primaryTf: rec.primaryTf,
      status: rec.status,
      topDownOrder: planRes.plan,
      barsPerTf: this.opts.barsPerTf,
      hasScreenshot: fs.existsSync(this.screenshotPath(rec.id)),
      lastClose: await this.lastClose(rec.symbol, rec.primaryTf as Timeframe),
      instrument: this.opts.instrumentOf?.(rec.symbol),
      minRiskReward: this.opts.minRiskReward ?? 2,
      bookmap: await this.bookmapRequestInfo(rec.id, rec.symbol),
      orderflow: this.orderflowRequestInfo(rec.id),
    };
  }

  private orderflowRequestInfo(id: string) {
    const snap = this.readOrderflowSnapshot(id);
    if (!snap) return null;
    return {
      source: 'binance',
      venue: snap.venue,
      asOf: new Date(snap.asOf * 1000).toISOString(),
      note: 'Gọi get_orderflow. Giá trong đó đã quy đổi về giá chart; chỉ nộp orderflow.summary + cvd, server tự gắn levels.',
    };
  }

  private async bookmapRequestInfo(id: string, symbol: string) {
    const meta = await this.bookmapContext(id, symbol);
    if (!meta) return null;
    return {
      images: meta.images,
      instrument: meta.instrument,
      offset: meta.offset,
      capturedAt: new Date(meta.capturedAt * 1000).toISOString(),
      refPrice: meta.refPrice ?? null,
      note: 'Gọi get_bookmap_images. Ghi bookmapPrice đúng như trên ảnh; server tự quy đổi giá app = bookmapPrice − offset.',
    };
  }

  private async lastClose(symbol: string, tf: Timeframe): Promise<number | null> {
    try {
      const res = await this.klines.getKlines({ symbol, tf, limit: 2, closedOnly: true });
      return res.candles.at(-1)?.close ?? null;
    } catch {
      return null;
    }
  }

  screenshotPath(id: string): string {
    return path.join(this.opts.screenshotDir, `${this.safeId(id)}.png`);
  }

  /**
   * Nhận kết quả agent. Có `analysisId` → gắn vào phân tích đang chạy.
   * Không có → (Claude Code tương tác) tạo bản ghi mới từ khung trong `topDown`.
   */
  async submit(analysisId: string | undefined, raw: unknown): Promise<SubmitOutcome> {
    raw = normalizeTfInput(raw);
    const filled: string[] = [];
    let rec: AnalysisRecord | null;
    let plan: TfPlanEntry[];
    const sub = (raw ?? {}) as { symbol?: string; primaryTf?: unknown; topDown?: { tf?: unknown }[] };

    if (analysisId) {
      rec = this.repo.get(analysisId);
      if (!rec) return { ok: false, errors: ['analysisId không tồn tại'] };
      if (rec.status !== 'RUNNING') return { ok: false, errors: [`Phân tích đã ở trạng thái ${rec.status}, không nhận thêm kết quả`] };
      const p = buildTfPlan(rec.primaryTf, rec.tfs.filter(tf => tf !== rec!.primaryTf));
      if (!p.ok) return { ok: false, errors: [p.error] };
      plan = p.plan;
      // symbol / primaryTf thừa khi đã có analysisId: thiếu thì điền từ yêu cầu (model nhỏ hay bỏ sót). Sai thì vẫn báo lỗi.
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        const missing = (['symbol', 'primaryTf'] as const).filter(k => obj[k] === undefined || obj[k] === null || obj[k] === '');
        if (missing.length) {
          raw = { ...obj, ...(missing.includes('symbol') ? { symbol: rec.symbol } : {}), ...(missing.includes('primaryTf') ? { primaryTf: rec.primaryTf } : {}) };
          filled.push(`Server điền ${missing.join(', ')} từ yêu cầu phân tích`);
        }
      }
    } else {
      const ctxTfs = (sub.topDown ?? []).map(t => t.tf).filter(tf => tf !== sub.primaryTf);
      const p = buildTfPlan(sub.primaryTf, ctxTfs, this.opts.maxTfs);
      if (!p.ok) return { ok: false, errors: [`topDown/primaryTf: ${p.error}`] };
      plan = p.plan;
      rec = null;
    }

    const symbol = rec?.symbol ?? normalizeSymbol(String(sub.symbol ?? ''));
    const primaryTf = (rec?.primaryTf ?? sub.primaryTf) as Timeframe;
    const tfs = new Set<Timeframe>([...plan.map(p => p.tf), ...referencedTfs(raw)]);
    const candlesByTf: Partial<Record<Timeframe, Candle[]>> = {};
    try {
      await Promise.all(
        [...tfs].map(async tf => {
          const res = await this.klines.getKlines({ symbol, tf, limit: this.opts.validationBars ?? 1500, closedOnly: true });
          candlesByTf[tf] = res.candles;
        }),
      );
    } catch (err) {
      return { ok: false, errors: [`Không tải được dữ liệu nến để kiểm tra: ${(err as Error).message}`] };
    }

    const bmMeta = analysisId ? await this.bookmapContext(analysisId, symbol) : null;
    const bookmap = bmMeta ? { ...bmMeta, maxAgeSec: (this.opts.bookmap?.maxAgeMin ?? 30) * 60 } : undefined;
    const ofSnap = analysisId ? this.readOrderflowSnapshot(analysisId) : null;
    const binance = ofSnap ? { snapshot: ofSnap, cvdText: cvdText(ofSnap.cvd, ofSnap.unit) } : undefined;
    const outcome = validateSubmission(raw, { symbol, primaryTf, plan, candlesByTf, minRiskReward: this.opts.minRiskReward, bookmap, binance });
    if (!outcome.ok) {
      if (analysisId) this.emitStep(analysisId, `Kết quả bị từ chối (${outcome.errors.length} lỗi), agent đang sửa`);
      return outcome;
    }

    const id = analysisId ?? randomUUID();
    if (!rec) {
      this.repo.create({ id, symbol, primaryTf, tfs: plan.map(p => p.tf), status: 'RUNNING', createdAt: Date.now(), runner: 'interactive' });
    }
    const result: AnalysisResult = {
      ...outcome.value,
      id,
      createdAt: Date.now(),
      tfs: plan.map(p => p.tf),
      asOf: candlesByTf[primaryTf]?.at(-1)?.time ?? Math.floor(Date.now() / 1000),
      model: this.models.get(id) ?? (analysisId ? rec?.runner : 'agent tương tác (Claude Code / agy)'),
      warnings: [...filled, ...outcome.warnings],
    };
    this.finish(id, 'DONE', { result });
    return { ok: true, analysisId: id, warnings: [...filled, ...outcome.warnings] };
  }
}
