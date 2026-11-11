import type { AnalysisRecord, BookmapUiConfig, InstrumentInfo, KlinesResponse, ProgressEvent, RunnerId, RunnerInfo, Timeframe } from '@wca/shared';

export interface ServerConfig {
  defaultSymbol: string;
  defaultTf: Timeframe;
  supportedTfs: Timeframe[];
  defaultContextTfs: Timeframe[];
  agentMaxTfs: number;
  bookmap?: BookmapUiConfig;
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
  bookmap?: { htf?: string; ltf?: string; capturedAt?: number; offset?: number };
}): Promise<AnalysisRecord> {
  return request('/api/analyses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
