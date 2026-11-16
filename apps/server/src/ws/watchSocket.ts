// Theo dõi một WebSocket client và báo "chết" đúng một lần để caller kết nối lại.
//
// Lý do: WebSocket có sẵn của Node 22 khi MỞ kết nối thất bại (DNS lỗi, mất mạng) chỉ bắn `error`,
// KHÔNG bắn `close`, readyState kẹt ở CONNECTING mãi → code chỉ kết nối lại trong `close` sẽ kẹt vĩnh viễn.
// Gọi `close()` trong handler `error` làm `error` bắn lặp lại liên tục (đã tái hiện), nên không dựa vào nó.

export type SocketDeadReason = 'close' | 'error' | 'timeout mở' | 'im lặng';

export interface WatchSocketOptions {
  /** Chưa `open` sau khoảng này → chết. */
  openTimeoutMs: number;
  /** Đã `open` mà không có message nào trong khoảng này → chết (kết nối treo). Bỏ trống = không kiểm tra. */
  idleTimeoutMs?: number;
  onOpen?: () => void;
  onMessage?: (ev: MessageEvent) => void;
  /** Gọi đúng một lần cho mỗi socket. */
  onDead: (reason: SocketDeadReason) => void;
  now?: () => number;
}

export interface SocketWatch {
  /** Ngừng theo dõi (khi chủ động dừng): dọn timer, bỏ qua mọi sự kiện sau đó, không gọi `onDead`. */
  dispose(): void;
}

const OPEN = 1;

export function watchSocket(ws: WebSocket, o: WatchSocketOptions): SocketWatch {
  const now = o.now ?? Date.now;
  let done = false;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = now();

  const clearTimers = () => {
    clearTimeout(openTimer);
    clearTimeout(idleTimer);
    openTimer = idleTimer = undefined;
  };

  const kill = (reason: SocketDeadReason) => {
    if (done) return;
    done = true;
    clearTimers();
    // Đóng một lần (giải phóng TCP khi treo); lỗi/sự kiện phát sinh từ close() đều bị bỏ qua vì `done`.
    try {
      ws.close();
    } catch {
      /* socket hỏng */
    }
    o.onDead(reason);
  };

  const armIdle = (ms: number) => {
    if (!o.idleTimeoutMs) return;
    idleTimer = setTimeout(() => {
      const quiet = now() - lastActivity;
      if (quiet >= o.idleTimeoutMs!) kill('im lặng');
      else armIdle(o.idleTimeoutMs! - quiet);
    }, ms);
    idleTimer.unref?.();
  };

  const opened = () => {
    clearTimeout(openTimer);
    openTimer = undefined;
    lastActivity = now();
    armIdle(o.idleTimeoutMs ?? 0);
  };

  ws.addEventListener('open', () => {
    if (done) return;
    opened();
    o.onOpen?.();
  });
  ws.addEventListener('message', ev => {
    if (done) return;
    lastActivity = now();
    o.onMessage?.(ev as MessageEvent);
  });
  ws.addEventListener('close', () => kill('close'));
  ws.addEventListener('error', () => kill('error'));

  if (ws.readyState === OPEN) opened();
  else {
    openTimer = setTimeout(() => kill('timeout mở'), o.openTimeoutMs);
    openTimer.unref?.();
  }

  return {
    dispose() {
      done = true;
      clearTimers();
    },
  };
}
