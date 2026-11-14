import { create } from 'zustand';
import { sortTopDown, type AnalysisRecord, type BookmapUiConfig, type AnalysisResult, type PriceAlert, type ProgressEvent, type RunnerId, type RunnerInfo, type Timeframe } from '@wca/shared';
import { cancelAnalysis, fetchAnalysis, fetchConfig, fetchHistory, fetchRunners, startAnalysis, subscribeSse } from '../api/client.ts';
import { chartRegistry } from '../chart/chartRegistry.ts';
import { ALL_LAYERS_ON, type LayerKey, type LayerVisibility } from '../overlays/model.ts';
import { useAppStore } from './useAppStore.ts';

export interface Preset {
  name: string;
  primary: Timeframe;
  context: Timeframe[];
}

export const DEFAULT_PRESETS: Preset[] = [
  { name: 'Swing', primary: '4h', context: ['1d', '5m'] },
  { name: 'Intraday', primary: '1h', context: ['4h', '15m'] },
  { name: 'Position', primary: '1d', context: ['1w', '4h'] },
  { name: 'Scalp', primary: '15m', context: ['1h', '1m'] },
];

const PRESET_KEY = 'wca:presets';
const CONTEXT_KEY = 'wca:contextTfs';
const RUNNER_KEY = 'wca:runner';
const MODELS_KEY = 'wca:runnerModels';
const USE_BOOKMAP_KEY = 'wca:useBookmap';
const BOOKMAP_OFFSETS_KEY = 'wca:bookmapOffsets';
const USE_ORDERFLOW_KEY = 'wca:useBinanceOrderflow';
const LAYER_ORDERFLOW_KEY = 'wca:layerOrderflow';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

export interface StepLog {
  at: number;
  message: string;
  kind: 'step' | 'text' | 'status';
}

interface RunState {
  id: string;
  startedAt: number;
  steps: StepLog[];
  unsubscribe: () => void;
}

interface AnalysisState {
  current: AnalysisResult | null;
  currentRecord: AnalysisRecord | null;
  layers: LayerVisibility;
  /** Chỉ vẽ setup có chỉ số này trên chart (null = tất cả). */
  selectedSetup: number | null;
  /** Khi đứng ngoài: vẫn vẽ setup tham khảo. */
  showReferenceSetups: boolean;
  contextTfs: Timeframe[];
  presets: Preset[];
  attachScreenshot: boolean;
  /** Cấu hình Bookmap từ server (symbol hỗ trợ, offset mặc định). */
  bookmapConfig: BookmapUiConfig | null;
  /** Checkbox "Dùng ảnh Bookmap". */
  useBookmap: boolean;
  /** Symbol có order flow Binance (server tự tính). */
  orderflowSymbols: string[];
  /** Symbol bật thanh lý (bong bóng + heatmap). */
  liquidationSymbols: string[];
  /** Symbol bật volume gộp nhiều sàn. */
  volumeAggSymbols: string[];
  /** Checkbox "Dùng order flow Binance". */
  useOrderflow: boolean;
  /** Offset người dùng sửa theo symbol (không có = mặc định server). */
  bookmapOffsets: Record<string, number>;
  /** Agent khả dụng (từ server). */
  runners: RunnerInfo[];
  /** Agent đang chọn (null = mặc định của server). */
  runner: RunnerId | null;
  /** Model chọn theo agent ('' = mặc định). */
  runnerModels: Partial<Record<RunnerId, string>>;
  run: RunState | null;
  lastError: string | null;
  history: AnalysisRecord[];
  setCurrent: (a: AnalysisResult | null) => void;
  toggleLayer: (key: LayerKey) => void;
  selectSetup: (i: number) => void;
  setShowReferenceSetups: (v: boolean) => void;
  toggleContextTf: (tf: Timeframe, maxTotal: number) => void;
  setAttachScreenshot: (v: boolean) => void;
  loadConfig: () => Promise<void>;
  setUseBookmap: (v: boolean) => void;
  setUseOrderflow: (v: boolean) => void;
  setBookmapOffset: (symbol: string, offset: number | null) => void;
  loadRunners: () => Promise<void>;
  setRunner: (r: RunnerId) => void;
  setRunnerModel: (r: RunnerId, model: string) => void;
  applyPreset: (p: Preset) => void;
  savePreset: (name: string) => void;
  deletePreset: (name: string) => void;
  analyze: () => Promise<void>;
  cancel: () => Promise<void>;
  loadHistory: () => Promise<void>;
  openAnalysis: (id: string) => Promise<void>;
  /** Nhận sự kiện từ SSE chung (kết quả từ Claude Code tương tác). */
  onGlobalEvent: (e: ProgressEvent) => void;
}

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  current: null,
  currentRecord: null,
  layers: { ...ALL_LAYERS_ON, orderflow: load<boolean>(LAYER_ORDERFLOW_KEY, true) },
  selectedSetup: null,
  showReferenceSetups: false,
  contextTfs: load<Timeframe[]>(CONTEXT_KEY, ['1d', '5m']),
  presets: load<Preset[]>(PRESET_KEY, DEFAULT_PRESETS),
  attachScreenshot: false,
  bookmapConfig: null,
  useBookmap: load<boolean>(USE_BOOKMAP_KEY, false),
  orderflowSymbols: [],
  liquidationSymbols: [],
  volumeAggSymbols: [],
  useOrderflow: load<boolean>(USE_ORDERFLOW_KEY, true),
  bookmapOffsets: load<Record<string, number>>(BOOKMAP_OFFSETS_KEY, {}),
  runners: [],
  runner: load<RunnerId | null>(RUNNER_KEY, null),
  runnerModels: load<Partial<Record<RunnerId, string>>>(MODELS_KEY, {}),
  run: null,
  lastError: null,
  history: [],

  setCurrent: current => set({ current, selectedSetup: null }),
  selectSetup: i => set(s => ({ selectedSetup: s.selectedSetup === i ? null : i })),
  setShowReferenceSetups: showReferenceSetups => set({ showReferenceSetups }),
  toggleLayer: key => {
    const layers = { ...get().layers, [key]: !get().layers[key] };
    set({ layers });
    if (key === 'orderflow') save(LAYER_ORDERFLOW_KEY, layers.orderflow);
  },

  toggleContextTf: (tf, maxTotal) => {
    const { contextTfs } = get();
    const primary = useAppStore.getState().tf;
    if (tf === primary) return;
    let next = contextTfs.includes(tf) ? contextTfs.filter(t => t !== tf) : [...contextTfs, tf];
    next = next.filter(t => t !== primary);
    if (next.length > maxTotal - 1) return;
    set({ contextTfs: next });
    save(CONTEXT_KEY, next);
  },

  setAttachScreenshot: attachScreenshot => set({ attachScreenshot }),

  loadConfig: async () => {
    try {
      const cfg = await fetchConfig();
      set({ bookmapConfig: cfg.bookmap ?? null, orderflowSymbols: cfg.orderflow?.binanceSymbols ?? [], liquidationSymbols: cfg.liquidation?.symbols ?? [], volumeAggSymbols: cfg.volumeAgg?.symbols ?? [] });
    } catch {
      /* server chưa chạy */
    }
  },

  setUseBookmap: useBookmap => {
    set({ useBookmap });
    save(USE_BOOKMAP_KEY, useBookmap);
  },

  setUseOrderflow: useOrderflow => {
    set({ useOrderflow });
    save(USE_ORDERFLOW_KEY, useOrderflow);
  },

  setBookmapOffset: (symbol, offset) => {
    const next = { ...get().bookmapOffsets };
    if (offset === null || !Number.isFinite(offset)) delete next[symbol];
    else next[symbol] = offset;
    set({ bookmapOffsets: next });
    save(BOOKMAP_OFFSETS_KEY, next);
  },

  loadRunners: async () => {
    try {
      const { defaultRunner, runners } = await fetchRunners();
      const cur = get().runner;
      const valid = runners.find(r => r.id === cur && r.available);
      set({ runners, runner: valid ? cur : (runners.find(r => r.id === defaultRunner && r.available) ?? runners.find(r => r.available))?.id ?? null });
    } catch (err) {
      set({ lastError: `Không tải được danh sách agent: ${(err as Error).message}` });
    }
  },

  setRunner: runner => {
    set({ runner });
    save(RUNNER_KEY, runner);
  },

  setRunnerModel: (r, model) => {
    const runnerModels = { ...get().runnerModels, [r]: model };
    set({ runnerModels });
    save(MODELS_KEY, runnerModels);
  },

  applyPreset: p => {
    useAppStore.getState().setTf(p.primary);
    set({ contextTfs: p.context });
    save(CONTEXT_KEY, p.context);
  },

  savePreset: name => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const p: Preset = { name: trimmed, primary: useAppStore.getState().tf, context: get().contextTfs };
    const presets = [...get().presets.filter(x => x.name !== trimmed), p];
    set({ presets });
    save(PRESET_KEY, presets);
  },

  deletePreset: name => {
    const presets = get().presets.filter(x => x.name !== name);
    set({ presets });
    save(PRESET_KEY, presets);
  },

  analyze: async () => {
    if (get().run) return;
    const { symbol, tf } = useAppStore.getState();
    const contextTfs = get().contextTfs.filter(t => t !== tf);
    set({ lastError: null });
    try {
      const { runner, runners, runnerModels } = get();
      const info = runners.find(r => r.id === runner);
      const screenshot = get().attachScreenshot && (info?.supportsScreenshot ?? true) ? chartRegistry.screenshot() : undefined;
      const model = runner ? runnerModels[runner] || undefined : undefined;
      // Ảnh Bookmap do server đọc từ đường dẫn cấu hình, lúc job bắt đầu chạy.
      const bookmap = bookmapEnabled(get(), symbol, info) ? { offset: bookmapOffsetOf(get(), symbol) } : undefined;
      // Mỗi phân tích một nguồn order flow: symbol có cả hai (vàng) → ảnh Bookmap được chọn thì ưu tiên ảnh.
      const orderflow = (!bookmap && orderflowEnabled(get(), symbol)) || undefined;
      const rec = await startAnalysis({ symbol, primaryTf: tf, contextTfs, screenshot, runner: runner ?? undefined, model, bookmap, orderflow });
      const order = sortTopDown(rec.tfs as Timeframe[]).join(' → ');
      const who = `${info?.label ?? rec.runner ?? 'agent'} · ${model ?? info?.defaultModel ?? 'model mặc định'}`;
      const steps: StepLog[] = [{ at: Date.now(), kind: 'status', message: `Bắt đầu: ${rec.symbol} · ${order} · ${who}` }];
      const unsubscribe = subscribeSse(`/api/analyses/${rec.id}/stream`, e => {
        const run = get().run;
        if (!run || run.id !== rec.id) return;
        if (e.kind === 'step' || e.kind === 'text') {
          set({ run: { ...run, steps: [...run.steps, { at: e.at, kind: e.kind, message: e.kind === 'step' ? e.message : e.text }] } });
        } else if (e.kind === 'result') {
          run.unsubscribe();
          const r = e.record;
          set({
            run: null,
            lastError: r.status === 'DONE' ? null : `${r.status === 'CANCELED' ? 'Đã hủy' : 'Thất bại'}: ${r.error ?? ''}`,
            ...(r.result ? { current: r.result, currentRecord: r, selectedSetup: null } : {}),
          });
          void get().loadHistory();
        }
      });
      set({ run: { id: rec.id, startedAt: Date.now(), steps, unsubscribe } });
    } catch (err) {
      set({ lastError: (err as Error).message });
    }
  },

  cancel: async () => {
    const run = get().run;
    if (!run) return;
    try {
      await cancelAnalysis(run.id);
    } catch (err) {
      set({ lastError: (err as Error).message });
    }
  },

  loadHistory: async () => {
    try {
      set({ history: await fetchHistory(useAppStore.getState().symbol) });
    } catch {
      /* server chưa chạy */
    }
  },

  openAnalysis: async id => {
    try {
      const rec = await fetchAnalysis(id);
      if (!rec.result) {
        set({ lastError: rec.error ?? `Phân tích ${rec.status}, không có kết quả` });
        return;
      }
      const app = useAppStore.getState();
      if (app.symbol !== rec.symbol) app.setSymbol(rec.symbol);
      if (app.tf !== rec.primaryTf) app.setTf(rec.primaryTf as Timeframe);
      set({ current: rec.result, currentRecord: rec, lastError: null, selectedSetup: null });
    } catch (err) {
      set({ lastError: (err as Error).message });
    }
  },

  onGlobalEvent: e => {
    if (e.kind === 'alert') {
      for (const l of alertListeners) l(e.alert);
      return;
    }
    if (e.kind !== 'result' || e.record.status !== 'DONE' || !e.record.result) return;
    const run = get().run;
    if (run && run.id === e.analysisId) return; // đã xử lý qua stream riêng
    void get().loadHistory();
    // Kết quả từ Claude Code tương tác cho symbol đang xem → hiển thị luôn.
    if (e.record.symbol === useAppStore.getState().symbol && !run) {
      void get().openAnalysis(e.analysisId);
    }
  },
}));

const alertListeners = new Set<(a: PriceAlert) => void>();

/** Nghe alert chạm entry đổi trạng thái (từ SSE chung); trả hàm huỷ. */
export function onAlertEvent(listener: (a: PriceAlert) => void): () => void {
  alertListeners.add(listener);
  return () => alertListeners.delete(listener);
}

/** Dùng order flow Binance khi symbol có collector + tick bật. */
export function orderflowEnabled(s: Pick<AnalysisState, 'orderflowSymbols' | 'useOrderflow'>, symbol: string): boolean {
  return s.orderflowSymbols.includes(symbol) && s.useOrderflow;
}

/** Symbol có hỗ trợ Bookmap (theo cấu hình server). */
export function bookmapSupported(s: Pick<AnalysisState, 'bookmapConfig'>, symbol: string): boolean {
  return Boolean(s.bookmapConfig?.symbols.includes(symbol));
}

/** Gửi ảnh Bookmap khi: symbol hỗ trợ + tick bật + agent nhận được ảnh Bookmap. */
export function bookmapEnabled(s: Pick<AnalysisState, 'bookmapConfig' | 'useBookmap'>, symbol: string, runner?: RunnerInfo): boolean {
  return bookmapSupported(s, symbol) && s.useBookmap && (runner?.supportsBookmap ?? true);
}

export function bookmapOffsetOf(s: Pick<AnalysisState, 'bookmapConfig' | 'bookmapOffsets'>, symbol: string): number {
  return s.bookmapOffsets[symbol] ?? s.bookmapConfig?.offsets[symbol] ?? 0;
}
