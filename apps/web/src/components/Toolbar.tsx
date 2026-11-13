import { useState, type FormEvent } from 'react';
import { SUPPORTED_TFS, WATCHLIST, normalizeSymbol, tfLabel } from '@wca/shared';
import { useAppStore } from '../store/useAppStore.ts';
import { SettingsButton } from './SettingsButton.tsx';

export function Toolbar({ status }: { status: string }) {
  const { symbol, tf, theme, setSymbol, setTf, toggleTheme } = useAppStore();
  const [draft, setDraft] = useState(symbol);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = normalizeSymbol(draft);
    if (next) setSymbol(next);
    setDraft(next);
  };

  return (
    <header className="toolbar">
      <form onSubmit={submit} className="symbol-form">
        <input
          aria-label="Symbol"
          list="watchlist"
          value={draft}
          onChange={e => setDraft(e.target.value.toUpperCase())}
          spellCheck={false}
        />
        <datalist id="watchlist">
          {WATCHLIST.map(s => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </form>
      <div className="watchlist" role="group" aria-label="Danh sách theo dõi">
        {WATCHLIST.map(s => (
          <button
            key={s}
            type="button"
            className={s === symbol ? 'active' : ''}
            onClick={() => {
              setSymbol(s);
              setDraft(s);
            }}
          >
            {s === 'XAUUSD' ? 'XAUUSD' : s.replace(/USDT$/, '')}
          </button>
        ))}
      </div>
      <div className="tf-group" role="group" aria-label="Khung thời gian">
        {SUPPORTED_TFS.map(t => (
          <button key={t} type="button" className={t === tf ? 'active' : ''} onClick={() => setTf(t)}>
            {tfLabel(t)}
          </button>
        ))}
      </div>
      <div className="spacer" />
      <span className={`status ${status === 'Live' ? 'live' : ''}`}>{status}</span>
      <SettingsButton />
      <button type="button" className="icon-btn" onClick={toggleTheme} title="Đổi giao diện sáng/tối">
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </header>
  );
}
