import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { SUPPORTED_TFS, WATCHLIST, normalizeSymbol, tfLabel } from '@wca/shared';
import { useAppStore } from '../store/useAppStore.ts';
import { useRecentSymbolsStore } from '../store/useRecentSymbolsStore.ts';
import { buildSuggestions } from '../store/recentSymbols.ts';
import { SettingsButton } from './SettingsButton.tsx';

export function Toolbar({ status }: { status: string }) {
  const { symbol, tf, theme, setSymbol, setTf, toggleTheme } = useAppStore();
  const [draft, setDraft] = useState(symbol);
  const { recent, remove: removeRecent } = useRecentSymbolsStore();
  const [open, setOpen] = useState(false);
  /** Người dùng đã gõ từ lúc focus → mới lọc gợi ý (focus lần đầu hiện đủ danh sách). */
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Đồng bộ ô nhập khi symbol đổi từ nơi khác (watchlist, chọn gợi ý rồi blur).
  useEffect(() => setDraft(symbol), [symbol]);

  const suggestions = buildSuggestions(recent, WATCHLIST, typed ? draft : '');

  // Toolbar có overflow-x → dropdown dùng position: fixed theo toạ độ ô nhập để không bị cắt.
  useEffect(() => {
    if (!open || !inputRef.current) return;
    const place = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 180) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  const choose = (value: string) => {
    const next = normalizeSymbol(value);
    if (next) setSymbol(next);
    setDraft(next || symbol);
    setOpen(false);
    setTyped(false);
    setActive(-1);
    inputRef.current?.blur();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const picked = open && active >= 0 ? suggestions[active] : undefined;
    choose(picked ? picked.symbol : draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      const n = suggestions.length;
      if (!n) return;
      setActive(i => (e.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n : i) - 1));
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
      setDraft(symbol);
      setTyped(false);
      inputRef.current?.blur();
    }
  };

  return (
    <header className="toolbar">
      <form onSubmit={submit} className="symbol-form">
        <input
          ref={inputRef}
          aria-label="Symbol"
          role="combobox"
          aria-expanded={open}
          aria-controls="symbol-suggest"
          autoComplete="off"
          value={draft}
          onFocus={e => {
            e.target.select();
            setOpen(true);
            setTyped(false);
            setActive(-1);
          }}
          onBlur={() => {
            setOpen(false);
            setTyped(false);
            setActive(-1);
            setDraft(symbol);
          }}
          onChange={e => {
            setDraft(e.target.value.toUpperCase());
            setTyped(true);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        {open && pos && suggestions.length > 0 && (
          <ul
            id="symbol-suggest"
            className="symbol-suggest"
            role="listbox"
            style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
            // Giữ focus ô nhập khi click gợi ý (blur sẽ đóng dropdown trước khi click kịp nhận).
            onMouseDown={e => e.preventDefault()}
          >
            {suggestions.map((sg, i) => (
              <li
                key={sg.symbol}
                role="option"
                aria-selected={i === active}
                className={`${i === active ? 'active' : ''} ${sg.symbol === symbol ? 'current' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(sg.symbol)}
              >
                <span className="sym">{sg.symbol}</span>
                {sg.recent && <span className="tag">Gần đây</span>}
                {sg.recent && (
                  <button
                    type="button"
                    className="remove"
                    title="Xoá khỏi gần đây"
                    aria-label={`Xoá ${sg.symbol} khỏi gần đây`}
                    onClick={e => {
                      e.stopPropagation();
                      removeRecent(sg.symbol);
                      setActive(-1);
                    }}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
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
