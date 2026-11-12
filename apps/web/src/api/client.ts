import type { AnalysisRecord, BookmapUiConfig, InstrumentInfo, KlinesResponse, OrderflowLevel, ProgressEvent, RunnerId, RunnerInfo, Timeframe, WallSegment } from '@wca/shared';

export interface ServerConfig {
  defaultSymbol: string;
  defaultTf: Timeframe;
  supportedTfs: Timeframe[];
  defaultContextTfs: Timeframe[];
  agentMaxTfs: number;
  bookmap?: BookmapUiConfig;
  orderflow?: { binanceSymbols: string[] };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export function fetchConfig(): Promise<ServerConfig> {
  return request('/api/config');
}

export function fetchKlines(symbol: string, tf: Timeframe, limit = 500, endTime?: number): Promise<KlinesResponse> {
  const params = new URLSearchParams({ symbol, tf, limit: String(limit) });
  if (endTime) params.set('endTime', String(endTime));
  return request(`/api/klines?${params}`);
}

export function fetchInstrument(symbol: string): Promise<InstrumentInfo> {
  return request(`/api/instruments/${encodeURIComponent(symbol)}`);
}

export function fetchRunners(): Promise<{ defaultRunner: RunnerId; runners: RunnerInfo[] }> {
  return request('/api/runners');
}

export function startAnalysis(body: {
  symbol: string;
  primaryTf: Timeframe;
  contextTfs: Timeframe[];
  screenshot?: string;
  runner?: RunnerId;
  model?: string;
  bookmap?: { offset?: number };
  orderflow?: boolean;
}): Promise<AnalysisRecord> {
  return request('/api/analyses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export interface BookmapImageStatus {
  role: 'htf' | 'ltf';
  available: boolean;
  mtime?: number;
  size?: number;
  error?: string;
}

/** Trạng thái file ảnh Bookmap (đường dẫn cấu hình ở server). */
export function fetchBookmapStatus(symbol: string): Promise<{ now: number; images: BookmapImageStatus[] }> {
  return request(`/api/bookmap/${encodeURIComponent(symbol)}`);
}

export interface OrderflowStatus {
  now: number;
  symbol: string;
  connected: boolean;
  synced: boolean;
  since: number | null;
  lastSampleAt: number | null;
  historyMin: number;
  spotPrice: number | null;
  error?: string;
}

/** Trạng thái collector order flow Binance của symbol. */
export function fetchOrderflowStatus(symbol: string): Promise<OrderflowStatus> {
  return request(`/api/orderflow/${encodeURIComponent(symbol)}`);
}

export interface LiveOrderflow {
  source: 'binance';
  symbol: string;
  asOf: number;
  historyMin: number;
  basis: number;
  connected: boolean;
  notes: string[];
  levels: OrderflowLevel[];
  /** Lịch sử tường 24h (giá đã quy đổi). */
  wallSegments?: WallSegment[];
}

/** Order flow hiện tại của symbol (vẽ sẵn trên chart). */
export function fetchLiveOrderflow(symbol: string): Promise<LiveOrderflow> {
  return request(`/api/orderflow/${encodeURIComponent(symbol)}/levels`);
}

export function cancelAnalysis(id: string): Promise<{ ok: boolean }> {
  return request(`/api/analyses/${id}/cancel`, { method: 'POST' });
}

export function fetchAnalysis(id: string): Promise<AnalysisRecord> {
  return request(`/api/analyses/${id}`);
}

export function fetchHistory(symbol?: string): Promise<AnalysisRecord[]> {
  return request(`/api/analyses${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`);
}

/** Đăng ký SSE; trả hàm đóng. EventSource tự kết nối lại khi rớt mạng. */
export function subscribeSse(url: string, onEvent: (e: ProgressEvent) => void): () => void {
  const es = new EventSource(url);
  es.onmessage = msg => {
    try {
      onEvent(JSON.parse(msg.data as string) as ProgressEvent);
    } catch {
      /* bỏ qua dòng lỗi */
    }
  };
  return () => es.close();
}
