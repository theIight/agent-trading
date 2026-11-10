# Plan — Chạy bằng pm2

## Approval Status

- [x] Đã duyệt (2026-11-11)

## 1. Requirements / Spec

Chạy app nền bằng pm2, giống các project khác trên máy: tự khởi động lại khi crash, xem log bằng `pm2 logs`, không cần giữ terminal `npm run dev`.

- 2 tiến trình:
  - `wca-server`: Fastify API ở `:8787`, chạy **không watch**.
  - `wca-web`: phục vụ bản build web tĩnh ở `:5173`, proxy `/api` sang server.
- Giữ nguyên URL đang dùng (`http://127.0.0.1:5173`). Vì vậy `.mcp.json`, `scripts/screenshot.ts` và runner không phải đổi.
- MCP server `wyckoff` **không** chạy bằng pm2: Claude Code/agy tự spawn qua stdio mỗi lần phân tích, như hiện tại.
- `npm run dev` vẫn dùng được cho phát triển. Lưu ý không chạy song song với pm2 vì trùng cổng.

## 2. Technical Design

- **`ecosystem.config.cjs`** ở thư mục gốc. Dùng `.cjs` vì package là `"type": "module"`.
  - `wca-server`:
    - `script: 'npm'`, `args: 'run start -w @wca/server'`. Script `start` đã có sẵn: `tsx --env-file-if-exists=../../.env`.
    - `cwd` là thư mục gốc. `autorestart`, `max_restarts: 10`, `restart_delay: 3000`, `kill_timeout: 5000` để server kịp đóng SQLite và tiến trình agent con.
    - `env.PATH` kế thừa từ shell lúc `pm2 start`. `claude` và `agy` nằm ở `~/.local/bin`; nếu không thấy thì đặt `CLAUDE_BIN`/`AGY_BIN` là đường dẫn tuyệt đối trong `.env`.
  - `wca-web`:
    - `script: 'npm'`, `args: 'run preview -w @wca/web'`.
  - Log: mặc định của pm2 (`~/.pm2/logs`). Không ghi log vào repo.
- **`apps/web/vite.config.ts`**: thêm `preview: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': apiTarget } }`. `vite preview` mặc định chạy cổng 4173 và cần có proxy riêng.
  - SSE (`/api/events`, `/api/analyses/:id/stream`) đi qua proxy như ở chế độ dev.
- **`package.json`** (gốc), thêm script:
  - `pm2:start`: `npm run build:web && pm2 start ecosystem.config.cjs`
  - `pm2:restart`: `npm run build:web && pm2 restart ecosystem.config.cjs`
  - `pm2:stop`: `pm2 stop ecosystem.config.cjs`
  - `pm2:logs`: `pm2 logs --lines 100 wca-server wca-web`
- **`README.md`**: thêm mục "Chạy bằng pm2": các lệnh trên, `pm2 save` và `pm2 startup` để tự chạy khi khởi động máy, cách xem log, lưu ý không chạy kèm `npm run dev`.
- Không đổi contract, server code hay quyền của agent headless.

## 3. Implementation Steps

1. Thêm `preview` vào `vite.config.ts`.
2. Tạo `ecosystem.config.cjs`.
3. Thêm script vào `package.json` và cập nhật README.
4. Kiểm chứng (bên dưới).

## 4. Tests / Acceptance

- `npm run typecheck`, `npm run lint`, `npm test` đều đạt.
- `npm run pm2:start` → `pm2 ls` có `wca-server` và `wca-web` ở trạng thái `online`.
- `curl http://127.0.0.1:5173/` trả 200 (HTML). `curl http://127.0.0.1:5173/api/analyses?symbol=BTCUSDT` trả 200 qua proxy.
- `pm2 restart wca-server` → server lên lại và UI tải được nến.
- Chụp ảnh UI bằng `scripts/screenshot.ts`: chart hiển thị, không có lỗi "HTTP 502".
- Chạy 1 lần phân tích từ UI dưới pm2 để xác nhận server spawn được `claude`, tức PATH đúng. Phần này cần bạn bấm Analyze, hoặc mình chạy nếu bạn cho phép, vì tốn quota agent.
- Trước khi `pm2:start` phải dừng `npm run dev` đang chạy (cổng 5173/8787).
