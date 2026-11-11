import { useEffect, useState } from 'react';
import {
  BOOKMAP_IMAGE_ROLES,
  bookmapInstrumentLabel,
  bookmapSizeUnit,
  ORDERFLOW_KIND_LABELS,
  SUPPORTED_TFS,
  sortTopDown,
  tfLabel,
  type AnalysisRecord,
  type AnalysisResult,
  type BookmapImageRole,
  type Orderflow,
  type Timeframe,
  type TradePlan,
  type TradeSetup,
} from '@wca/shared';
import { chartRegistry } from '../chart/chartRegistry.ts';
import {
  bookmapOffsetOf,
  bookmapSupported,
  readImageFile,
  useAnalysisStore,
  type StepLog,
} from '../store/useAnalysisStore.ts';
import { useAppStore } from '../store/useAppStore.ts';

const MAX_TFS = 4;
/** Model nhỏ / effort thấp: hay nộp sai định dạng, phân tích nông. */
const WEAK_MODEL_RE = /flash|-low$|haiku/i;

const fmtPrice = (p?: number) => (p === undefined ? '—' : p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 1 : 6 }));
const fmtDateTime = (sec: number) =>
  new Date(sec * 1000).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const BIAS_LABEL = { BULLISH: 'Tăng', BEARISH: 'Giảm', NEUTRAL: 'Trung lập' } as const;
const biasClass = (b: string) => (b === 'BULLISH' ? 'up' : b === 'BEARISH' ? 'down' : 'muted');

const ROLE_LABEL: Record<BookmapImageRole, string> = { htf: 'Khung lớn', ltf: 'Khung bé' };

/** Ô chọn ảnh Bookmap: bấm chọn file, kéo thả, hoặc dán (Cmd+V) khi ô đang focus. */
function BookmapSlot({ symbol, role, disabled }: { symbol: string; role: BookmapImageRole; disabled: boolean }) {
  const img = useAnalysisStore(s => s.bookmapImages[symbol]?.[role]);
  const setBookmapImage = useAnalysisStore(s => s.setBookmapImage);
  const [err, setErr] = useState<string | null>(null);
  const take = (file: File | null | undefined) => {
    if (!file) return;
    readImageFile(file).then(
      i => {
        setErr(null);
        setBookmapImage(symbol, role, i);
      },
      (e: Error) => setErr(e.message),
    );
  };
  const id = `bm-${role}`;
  return (
    <div
      className={`bm-slot ${img ? 'has' : ''}`}
      tabIndex={0}
      onPaste={e => take([...e.clipboardData.files][0])}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        e.preventDefault();
        take(e.dataTransfer.files[0]);
      }}
    >
      <div className="bm-slot-head">
        <b>{ROLE_LABEL[role]}</b>
        {img && (
          <button type="button" className="preset-x" disabled={disabled} onClick={() => setBookmapImage(symbol, role, null)} title="Bỏ ảnh">
            ×
          </button>
        )}
      </div>
      {img ? (
        <>
          <img src={img.dataUrl} alt={`Bookmap ${ROLE_LABEL[role]}`} />
          <div className="muted bm-meta">
            {img.name} · {new Date(img.lastModified).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </>
      ) : (
        <label htmlFor={id} className="muted bm-empty">
          Chọn / kéo thả / dán ảnh
        </label>
      )}
      <input id={id} type="file" accept="image/png,image/jpeg" hidden disabled={disabled} onChange={e => take(e.target.files?.[0])} />
      {err && <div className="down bm-meta">{err}</div>}
    </div>
  );
}

function BookmapControls({ symbol, disabled }: { symbol: string; disabled: boolean }) {
  const state = useAnalysisStore();
  const { useBookmap, setUseBookmap, setBookmapOffset, runners, runner } = state;
  const runnerInfo = runners.find(r => r.id === runner);
  if (!bookmapSupported(state, symbol)) return null;
  const unsupported = runnerInfo ? !runnerInfo.supportsBookmap : false;
  const offset = bookmapOffsetOf(state, symbol);
  const defaultOffset = state.bookmapConfig?.offsets[symbol] ?? 0;
  return (
    <div className="bookmap">
      <label className="check">
        <input type="checkbox" checked={useBookmap && !unsupported} disabled={unsupported || disabled} onChange={e => setUseBookmap(e.target.checked)} />
        Dùng ảnh Bookmap
        {unsupported && <span className="muted"> (agent này không nhận ảnh Bookmap)</span>}
      </label>
      {useBookmap && !unsupported && (
        <>
          <div className="muted bm-meta">Bookmap: {bookmapInstrumentLabel(symbol)}</div>
          <div className="bm-slots">
            {BOOKMAP_IMAGE_ROLES.map(role => (
              <BookmapSlot key={role} symbol={symbol} role={role} disabled={disabled} />
            ))}
          </div>
          <label className="model-select">
            <span className="muted">Offset</span>
            <input
              type="number"
              step="0.1"
              value={offset}
              disabled={disabled}
              onChange={e => setBookmapOffset(symbol, e.target.value === '' ? null : Number(e.target.value))}
              title="Giá Bookmap − giá trên chart app"
            />
            {offset !== defaultOffset && (
              <button type="button" className="chip ghost" disabled={disabled} onClick={() => setBookmapOffset(symbol, null)}>
                Mặc định {defaultOffset}
              </button>
            )}
          </label>
          <div className="muted bm-meta">Giá app = giá Bookmap − offset</div>
        </>
      )}
    </div>
  );
}

function Controls() {
  const tf = useAppStore(s => s.tf);
  const { contextTfs, toggleContextTf, presets, applyPreset, savePreset, deletePreset, attachScreenshot, setAttachScreenshot, run, analyze, cancel } =
    useAnalysisStore();
  const { runners, runner, runnerModels, loadRunners, loadConfig, setRunner, setRunnerModel } = useAnalysisStore();
  const symbol = useAppStore(s => s.symbol);
  useEffect(() => {
    void loadRunners();
    void loadConfig();
  }, [loadRunners, loadConfig]);
  const runnerInfo = runners.find(r => r.id === runner);
  const ctx = contextTfs.filter(t => t !== tf);
  const order = sortTopDown([tf, ...ctx]);
  const full = ctx.length >= MAX_TFS - 1;

  return (
    <section className="panel-section">
      <div className="field-label">
        Khung chính <b>{tfLabel(tf)}</b> <span className="muted">(= khung đang xem)</span>
      </div>
      <div className="field-label">Khung phụ (tối đa {MAX_TFS - 1})</div>
      <div className="chips">
        {SUPPORTED_TFS.map(t => {
          const isPrimary = t === tf;
          const on = ctx.includes(t);
          return (
            <button
              key={t}
              type="button"
              className={`chip ${on ? 'on' : ''} ${isPrimary ? 'primary' : ''}`}
              disabled={isPrimary || (!on && full) || Boolean(run)}
              onClick={() => toggleContextTf(t, MAX_TFS)}
              title={isPrimary ? 'Khung chính' : on ? 'Bỏ chọn' : 'Chọn làm khung phụ'}
            >
              {tfLabel(t)}
            </button>
          );
        })}
      </div>
      <div className="order">
        Thứ tự phân tích: {order.map((t, i) => (
          <span key={t}>
            {i > 0 && ' → '}
            <b className={t === tf ? 'accent' : ''}>{tfLabel(t)}</b>
          </span>
        ))}
      </div>

      <div className="field-label">Preset</div>
      <div className="chips">
        {presets.map(p => (
          <span key={p.name} className="preset">
            <button type="button" className="chip" disabled={Boolean(run)} onClick={() => applyPreset(p)} title={sortTopDown([p.primary, ...p.context]).join(' → ')}>
              {p.name} <span className="muted">{tfLabel(p.primary)}</span>
            </button>
            <button type="button" className="preset-x" onClick={() => deletePreset(p.name)} title="Xoá preset">
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className="chip ghost"
          onClick={() => {
            const name = window.prompt('Tên preset (lưu khung chính + khung phụ hiện tại):');
            if (name) savePreset(name);
          }}
        >
          + Lưu
        </button>
      </div>

      <div className="field-label">Agent</div>
      <div className="chips" role="radiogroup" aria-label="Agent phân tích">
        {runners.map(r => (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={runner === r.id}
            className={`chip ${runner === r.id ? 'on' : ''}`}
            disabled={!r.available || Boolean(run)}
            title={r.available ? r.label : `Không khả dụng: ${r.reason ?? ''}`}
            onClick={() => setRunner(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {runnerInfo && (
        <label className="model-select">
          <span className="muted">Model</span>
          <select
            value={runnerModels[runnerInfo.id] ?? ''}
            disabled={Boolean(run)}
            onChange={e => setRunnerModel(runnerInfo.id, e.target.value)}
          >
            <option value="">Mặc định{runnerInfo.defaultModel ? ` (${runnerInfo.defaultModel})` : ''}</option>
            {runnerInfo.models.map(m => (
              <option key={m.id} value={m.id}>
                {m.label}
                {WEAK_MODEL_RE.test(m.id) ? ' — nhanh, kém chính xác' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="check">
        <input
          type="checkbox"
          checked={attachScreenshot && (runnerInfo?.supportsScreenshot ?? true)}
          disabled={runnerInfo ? !runnerInfo.supportsScreenshot : false}
          onChange={e => setAttachScreenshot(e.target.checked)}
        />
        Gửi kèm ảnh chart cho agent
        {runnerInfo && !runnerInfo.supportsScreenshot && <span className="muted"> (agent này không nhận ảnh)</span>}
      </label>

      <BookmapControls symbol={symbol} disabled={Boolean(run)} />

      {run ? (
        <button type="button" className="btn danger" onClick={() => void cancel()}>
          Hủy phân tích
        </button>
      ) : (
        <button type="button" className="btn primary" onClick={() => void analyze()}>
          Analyze
        </button>
      )}
    </section>
  );
}

function Progress({ steps, startedAt }: { steps: StepLog[]; startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <section className="panel-section">
      <div className="section-title">
        Agent đang phân tích… <span className="muted">{Math.round((now - startedAt) / 1000)}s</span>
      </div>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={i} className={s.kind}>
            {s.message}
          </li>
        ))}
      </ol>
    </section>
  );
}

export const DECISION_LABEL = { ENTER: 'VÀO LỆNH', WAIT_FOR_SETUP: 'CHỜ SETUP', STAND_ASIDE: 'ĐỨNG NGOÀI' } as const;
const ENTRY_TYPE_LABEL = { MARKET: 'Vào ngay', LIMIT: 'Chờ hồi về', STOP: 'Chờ phá vỡ' } as const;

const RUNNER_LABEL: Record<string, string> = { 'claude-code': 'Claude', agy: 'agy', interactive: 'tương tác' };
const runnerLabel = (h: AnalysisRecord) => `${RUNNER_LABEL[h.runner ?? 'claude-code'] ?? h.runner}${h.model ? ` ${h.model}` : ''}`;

/** Nhãn ngắn cho danh sách lịch sử: quyết định (+ chiều setup chính). */
function decisionSummary(r: AnalysisResult): string {
  const p = r.tradePlan;
  if (!p) return r.action.type;
  const main = p.setups[0];
  return p.decision === 'STAND_ASIDE' || !main ? DECISION_LABEL[p.decision] : `${DECISION_LABEL[p.decision]} ${main.direction}`;
}

function TradePlanCard({ plan }: { plan: TradePlan }) {
  const { selectedSetup, selectSetup, showReferenceSetups, setShowReferenceSetups } = useAnalysisStore();
  const main = plan.setups[0];
  const tone = plan.decision === 'STAND_ASIDE' ? 'aside' : plan.decision === 'WAIT_FOR_SETUP' ? 'wait' : main?.direction.toLowerCase();
  const reference = plan.decision === 'STAND_ASIDE';
  return (
    <div className="trade-plan">
      <div className={`action-card ${tone ?? ''}`}>
        <div>
          <span className={`badge decision ${tone ?? ''}`}>{DECISION_LABEL[plan.decision]}</span>
        </div>
        <div className="note">{plan.reason}</div>
        {plan.reconsiderWhen && (
          <div className="note">
            <b>Xem lại khi:</b> {plan.reconsiderWhen}
          </div>
        )}
      </div>
      {reference && plan.setups.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={showReferenceSetups} onChange={e => setShowReferenceSetups(e.target.checked)} />
          Hiện setup tham khảo trên chart
        </label>
      )}
      {plan.setups.map((st, i) => (
        <button
          type="button"
          key={i}
          className={`setup-card ${st.direction.toLowerCase()} ${reference ? 'reference' : ''} ${selectedSetup === i ? 'selected' : ''}`}
          onClick={() => selectSetup(i)}
          title={selectedSetup === i ? 'Bấm để vẽ tất cả setup' : 'Bấm để chỉ vẽ setup này'}
        >
          <div className="setup-head">
            <b className={st.direction === 'LONG' ? 'up' : 'down'}>{st.direction}</b> <b>{st.name}</b>
            <span className="muted">
              {' '}
              · {i === 0 ? 'chính' : 'phương án B'}
              {reference && ' · tham khảo'}
            </span>
          </div>
          <div className="note">
            {ENTRY_TYPE_LABEL[st.entryType]} · {tfLabel(st.tf)} · kích hoạt <b>{st.trigger}</b>
            {st.triggerNote && <>: {st.triggerNote}</>}
          </div>
          <div className="levels">
            Entry <b>{st.entryLow === st.entryHigh ? fmtPrice(st.entryLow) : `${fmtPrice(st.entryLow)}–${fmtPrice(st.entryHigh)}`}</b> · SL{' '}
            <b className="down">{fmtPrice(st.stopLoss)}</b> · TP <b className="up">{st.takeProfits.map(fmtPrice).join(' / ')}</b>
          </div>
          <div className="note">
            {st.riskReward !== undefined && <>R:R {st.riskReward.toFixed(2)}</>}
            {st.riskRewardTp1 !== undefined && <> (TP1 {st.riskRewardTp1.toFixed(2)})</>} · tin cậy {Math.round(st.confidence * 100)}%
            {st.validUntil && <> · hết hạn {fmtDateTime(st.validUntil)}</>}
            {st.scenario && <> · kịch bản {st.scenario}</>}
          </div>
          {st.rationale && <div className="note">{st.rationale}</div>}
          {st.refinedEntry && <RefinedEntryBlock setup={st} />}
        </button>
      ))}
    </div>
  );
}

/** SL tầng 2: entry tinh chỉnh trên khung nhỏ (ước lượng). */
function RefinedEntryBlock({ setup }: { setup: TradeSetup }) {
  const ref = setup.refinedEntry!;
  const atrMult = ref.atr ? ` (${(ref.estStopDistance / ref.atr).toFixed(1)} ATR ${tfLabel(ref.tf)})` : '';
  return (
    <div className="refined">
      <div>
        <b>Entry tinh chỉnh {tfLabel(ref.tf)}</b> · kích hoạt <b>{ref.trigger}</b>
      </div>
      {ref.condition && <div className="note">{ref.condition}</div>}
      {ref.stopRule && <div className="note">SL: {ref.stopRule}</div>}
      <div className="levels">
        SL ≈ <b className="down">{fmtPrice(Number(ref.estStopDistance.toPrecision(4)))}</b> giá{atrMult}
        {ref.riskReward !== undefined && (
          <>
            {' '}
            → R:R ≈ <b className="up">{ref.riskReward.toFixed(2)}</b>
            {ref.riskRewardTp1 !== undefined && <span className="muted"> (TP1 {ref.riskRewardTp1.toFixed(2)})</span>}
          </>
        )}
      </div>
    </div>
  );
}

/** Bản ghi cũ chưa có tradePlan. */
function LegacyAction({ a }: { a: AnalysisResult }) {
  const act = a.action;
  return (
    <div className={`action-card ${act.type.toLowerCase()}`}>
      <div>
        <b>{act.type === 'WAIT' ? 'ĐỨNG NGOÀI / CHỜ' : act.type}</b>
        {act.riskReward !== undefined && <span className="muted"> · R:R {act.riskReward.toFixed(2)}</span>}
      </div>
      {(act.entry || act.stopLoss || act.takeProfits.length > 0) && (
        <div className="levels">
          Entry <b>{fmtPrice(act.entry)}</b> · SL <b className="down">{fmtPrice(act.stopLoss)}</b> · TP{' '}
          <b className="up">{act.takeProfits.map(fmtPrice).join(' / ') || '—'}</b>
          {act.type === 'WAIT' && <span className="muted"> (dự kiến)</span>}
        </div>
      )}
      {act.condition && <div className="note">{act.condition}</div>}
    </div>
  );
}

function OrderflowCard({ of, symbol }: { of: Orderflow; symbol: string }) {
  const unit = bookmapSizeUnit(symbol);
  const drift = of.measuredOffset !== undefined && of.offset !== undefined ? of.measuredOffset - of.offset : undefined;
  return (
    <div className="orderflow">
      <p className="note">{of.summary}</p>
      {of.cvd && (
        <div className="note">
          <b>CVD:</b> {of.cvd}
        </div>
      )}
      {of.levels.length > 0 && (
        <ul className="events">
          {of.levels.map((lv, i) => (
            <li key={i}>
              <b>{ORDERFLOW_KIND_LABELS[lv.kind]}</b> {fmtPrice(lv.price)} <span className="muted">(Bookmap {fmtPrice(lv.bookmapPrice)} · {ROLE_LABEL[lv.image].toLowerCase()})</span>
              {lv.size !== undefined && (
                <span>
                  {' '}
                  · {Number(lv.size.toFixed(2))} {unit} <span className="muted">{lv.sizeSource}</span>
                </span>
              )}
              {lv.note && <div className="note">{lv.note}</div>}
            </li>
          ))}
        </ul>
      )}
      <div className="muted note">
        Offset dùng {of.offset ?? '—'}
        {of.measuredOffset !== undefined && (
          <>
            {' '}
            · đo được {of.measuredOffset}
            {drift !== undefined && Math.abs(drift) > 0 && <> (lệch {drift > 0 ? '+' : ''}{Number(drift.toFixed(2))})</>}
          </>
        )}
      </div>
    </div>
  );
}

function Result({ a, record }: { a: AnalysisResult; record: AnalysisRecord | null }) {
  return (
    <section className="panel-section result">
      <div className="result-head">
        <span className={`badge ${biasClass(a.bias)}`}>{BIAS_LABEL[a.bias]}</span>
        <b>{a.schematic}</b>
        {a.currentPhase && <span>· Phase {a.currentPhase}</span>}
        <span className="muted">· tin cậy {Math.round(a.confidence * 100)}%</span>
      </div>
      <p className="summary">{a.summary}</p>

      <div className="section-title">Top-down</div>
      <ol className="topdown">
        {a.topDown.map(t => (
          <li key={t.tf}>
            <b>{tfLabel(t.tf)}</b> <span className="muted">{t.role}</span>{' '}
            <span className={biasClass(t.bias)}>{BIAS_LABEL[t.bias]}</span>
            {t.phase && <span className="muted"> · Phase {t.phase}</span>}
            {t.schematic !== 'UNCLEAR' && <span className="muted"> · {t.schematic}</span>}
            {t.note && <div className="note">{t.note}</div>}
          </li>
        ))}
      </ol>

      <div className="section-title">Setup</div>
      {a.tradePlan ? <TradePlanCard plan={a.tradePlan} /> : <LegacyAction a={a} />}

      {a.orderflow && (
        <>
          <div className="section-title">Order flow (Bookmap)</div>
          <OrderflowCard of={a.orderflow} symbol={a.symbol} />
        </>
      )}

      {a.scenarios.length > 0 && (
        <>
          <div className="section-title">Kịch bản</div>
          <ul className="scenarios">
            {a.scenarios.map(s => (
              <li key={s.name}>
                <span className={biasClass(s.bias)}>●</span> <b>{s.name}</b> <span className="muted">{Math.round(s.probability * 100)}%</span>
                <div className="note">
                  {s.trigger && <>Kích hoạt: {s.trigger}. </>}Vô hiệu: {fmtPrice(s.invalidation)}
                  {s.note && <> · {s.note}</>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {a.events.length > 0 && (
        <>
          <div className="section-title">Sự kiện ({a.events.length})</div>
          <ul className="events">
            {a.events.map((e, i) => (
              <li key={i}>
                <button type="button" onClick={() => chartRegistry.scrollTo(e.time)} title="Cuộn chart tới nến này">
                  <b>{e.type}</b> <span className="muted">{tfLabel(e.tf)}</span> {fmtDateTime(e.time)} @ {fmtPrice(e.price)}
                </button>
                {e.note && <div className="note">{e.note}</div>}
              </li>
            ))}
          </ul>
        </>
      )}

      {a.tfConflicts.length > 0 && (
        <>
          <div className="section-title">Mâu thuẫn giữa các khung</div>
          <ul className="warnings">{a.tfConflicts.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </>
      )}
      {a.warnings.length > 0 && (
        <>
          <div className="section-title">Validator đã sửa</div>
          <ul className="warnings">{a.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </>
      )}
      <div className="meta muted">
        {a.symbol} · {a.tfs.map(t => tfLabel(t as Timeframe)).join(' → ')} · dữ liệu tới {fmtDateTime(a.asOf)} · {a.model ?? 'claude-code'}
        {record?.finishedAt && record.createdAt && <> · {Math.round((record.finishedAt - record.createdAt) / 1000)}s</>}
      </div>
    </section>
  );
}

function History() {
  const { history, loadHistory, openAnalysis, current } = useAnalysisStore();
  const symbol = useAppStore(s => s.symbol);
  useEffect(() => {
    void loadHistory();
  }, [symbol, loadHistory]);
  if (!history.length) return <p className="muted panel-section">Chưa có phân tích nào cho {symbol}.</p>;
  return (
    <ul className="history">
      {history.map(h => (
        <li key={h.id} className={current?.id === h.id ? 'active' : ''}>
          <button type="button" onClick={() => void openAnalysis(h.id)} disabled={h.status !== 'DONE'}>
            <div>
              <b>{new Date(h.createdAt).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</b>{' '}
              <span className="muted">{h.tfs.map(t => tfLabel(t as Timeframe)).join(' → ')}</span>{' '}
              <span className="muted">· {runnerLabel(h)}</span>
              {h.bookmap && (
                <span className="badge bm" title="Có dùng ảnh Bookmap">
                  BM
                </span>
              )}
            </div>
            {h.result ? (
              <div>
                <span className={biasClass(h.result.bias)}>{BIAS_LABEL[h.result.bias]}</span> · {h.result.schematic}
                {h.result.currentPhase && ` · ${h.result.currentPhase}`} · {decisionSummary(h.result)}
              </div>
            ) : (
              <div className="muted">
                {h.status}
                {h.error ? `: ${h.error.slice(0, 80)}` : ''}
              </div>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AnalysisPanel() {
  const [tab, setTab] = useState<'analysis' | 'history'>('analysis');
  const { current, currentRecord, run, lastError, setCurrent } = useAnalysisStore();

  return (
    <aside className="panel">
      <div className="tabs">
        <button type="button" className={tab === 'analysis' ? 'active' : ''} onClick={() => setTab('analysis')}>
          Phân tích
        </button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          Lịch sử
        </button>
        {current && (
          <button type="button" className="clear" onClick={() => setCurrent(null)} title="Xoá overlay khỏi chart">
            Xoá overlay
          </button>
        )}
      </div>
      <div className="panel-body">
        {tab === 'analysis' ? (
          <>
            <Controls />
            {lastError && <div className="error-box">{lastError}</div>}
            {run && <Progress steps={run.steps} startedAt={run.startedAt} />}
            {current && <Result a={current} record={currentRecord} />}
          </>
        ) : (
          <History />
        )}
      </div>
    </aside>
  );
}
