import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import { clampMenuPosition } from '../chart/copyPrice.ts';

interface Props {
  containerRef: RefObject<HTMLDivElement | null>;
  controllerRef: RefObject<ChartController | null>;
  /** Đổi symbol/khung → đóng menu. */
  resetKey: string;
}

interface MenuState {
  x: number;
  y: number;
  price: string;
  close: string | null;
}

/** Ghi clipboard; ngoài secure context (mở qua IP LAN) dùng execCommand dự phòng. */
async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

/** Menu chuột phải trên chart: copy giá tại con trỏ / giá đóng nến dưới con trỏ. */
export function ChartContextMenu({ containerRef, controllerRef, resetKey }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const at = controllerRef.current?.priceAt(x, y) ?? null;
      setPos(null);
      setMenu(at ? { x, y, ...at } : null);
    };
    el.addEventListener('contextmenu', onContext);
    return () => el.removeEventListener('contextmenu', onContext);
  }, [containerRef, controllerRef]);

  useEffect(() => setMenu(null), [resetKey]);

  // Đóng khi click ngoài menu, Esc, cuộn/zoom chart, đổi kích thước cửa sổ.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  // Đo menu sau khi render rồi lật vào trong khung chart.
  useLayoutEffect(() => {
    const box = containerRef.current;
    const m = menuRef.current;
    if (!menu || !box || !m) return;
    setPos(clampMenuPosition(menu.x, menu.y, m.offsetWidth, m.offsetHeight, box.clientWidth, box.clientHeight));
  }, [menu, containerRef]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 1500);
    return () => clearTimeout(id);
  }, [toast]);

  const copy = async (text: string) => {
    setMenu(null);
    try {
      await writeClipboard(text);
      setToast({ text: `Đã copy ${text}`, error: false });
    } catch {
      setToast({ text: 'Không copy được', error: true });
    }
  };

  return (
    <>
      {menu && (
        <div
          ref={menuRef}
          className="chart-menu"
          role="menu"
          style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
          onContextMenu={e => e.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => void copy(menu.price)}>
            Copy giá <b>{menu.price}</b>
          </button>
          {menu.close !== null && (
            <button type="button" role="menuitem" onClick={() => void copy(menu.close!)}>
              Copy giá đóng <b>{menu.close}</b>
            </button>
          )}
        </div>
      )}
      {toast && <div className={`chart-toast${toast.error ? ' error' : ''}`}>{toast.text}</div>}
    </>
  );
}
