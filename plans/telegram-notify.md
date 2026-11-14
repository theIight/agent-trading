# Gửi ảnh chart kết quả phân tích sang Telegram

## Bối cảnh
Hiện kết quả phân tích chỉ xem được trên web. Muốn khi phân tích xong (kể cả lúc đã đóng trình duyệt) server tự chụp chart **đã vẽ kết quả** và gửi vào Telegram kèm tóm tắt ngắn. Đây là bước 1 (thông báo một chiều); bot nhận lệnh (`/analyze …`) là plan sau.

## Requirements / Spec
1. Bật khi có `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` (env / `.env`). Thiếu một trong hai → tính năng tắt, không lỗi, không log ồn. Token không bao giờ ghi vào log, DB, SSE hay response API.
2. Mỗi phân tích kết thúc gửi **đúng một lần** (theo `analysisId`, chống trùng trong bộ nhớ):
   - `DONE` → album ảnh (`sendMediaGroup`), mỗi khung trong `result.tfs` một ảnh, thứ tự top-down (khung lớn → nhỏ); `TELEGRAM_TFS=primary` → chỉ khung chính. Caption gắn vào ảnh đầu.
   - `FAILED` → một tin nhắn chữ: symbol, khung, lỗi (cắt 300 ký tự). `TELEGRAM_NOTIFY_FAILED=0` để tắt.
   - `CANCELED` → không gửi.
   - Áp dụng cho mọi nguồn kết quả: runner headless và kết quả tương tác (`runner: 'interactive'`).
3. Caption (≤ 1024 ký tự, tiếng Việt, HTML mode, escape nội dung agent):
   ```
   BTCUSDT · 4h (1d → 4h → 1h) · BULLISH 70%
   Pha C · Accumulation
   Quyết định: WAIT_FOR_SETUP
   ① LONG LIMIT 1h · Entry 94,200–94,500 · SL 93,600 · TP 96,000 / 97,500 · R:R 2.8
   ② …
   <tóm tắt cắt cho vừa>
   claude-code · opus · 12:34 14/11
   ```
   R:R lấy từ kết quả đã qua validator (`riskReward` server tính), không dùng số agent tự tính. Bản ghi cũ không có `tradePlan` → dùng `action`.
4. Ảnh chụp đúng giao diện chart của web (nến + lớp kết quả theo cài đặt lớp mặc định), theme tối, kích thước 1600×900, không có toolbar / panel. Nến hiển thị là dữ liệu hiện tại lúc chụp (có thể có nến đang chạy — chỉ là ảnh hiển thị, agent không dùng).
5. Lỗi chụp / gửi không ảnh hưởng phân tích: thử lại tối đa 2 lần (cách 5s, tôn trọng `retry_after` khi Telegram trả 429), sau đó chỉ log. Chụp ảnh lỗi → vẫn gửi tin nhắn chữ với caption.
6. Gửi chạy tuần tự (hàng đợi riêng của notifier), không chặn hàng đợi phân tích.
7. Không đổi contract agent (`analysis.ts`), prompt, validator, quyền runner.

## Technical Design

### Config (`apps/server/src/config.ts`)
| Env | Mặc định | Ý nghĩa |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Token bot (BotFather) |
| `TELEGRAM_CHAT_ID` | — | Chat / group / channel nhận |
| `TELEGRAM_TFS` | `all` | `all` \| `primary` |
| `TELEGRAM_NOTIFY_FAILED` | `1` | Gửi khi FAILED |
| `SNAPSHOT_WEB_URL` | `http://127.0.0.1:5173` | Web để Chrome headless mở |
| `SNAPSHOT_CHROME_CHANNEL` | `chrome` | Channel Playwright (`chrome` = Chrome đã cài; rỗng = Chromium của Playwright) |

Cập nhật `.env.example`.

### Web: chế độ snapshot
- URL `/?snapshot=<analysisId>&tf=<tf>`:
  - `App` thấy `snapshot` → chỉ render `ChartView` toàn màn hình (không Toolbar, AnalysisPanel, SSE chung), theme tối, không ghi localStorage (symbol/tf/lớp không ghi đè cài đặt người dùng).
  - Tải `GET /api/analyses/:id` → set symbol = record.symbol, tf = `tf` param, `current = record.result`.
  - Lớp hiển thị: dùng mặc định của store (không đọc localStorage) để ảnh ổn định; không bật heatmap / order flow live.
  - Khi nến đã tải và overlay đã vẽ (sau 2 frame) → `document.body.dataset.snapshot = 'ready'`; lỗi → `'error'` + `data-snapshot-error`.
- Pure helper `apps/web/src/snapshotMode.ts`: `parseSnapshotParams(search)` → `{ id, tf } | null` (kiểm tra id `^[\w-]{1,64}$`, tf hợp lệ).

### Server
- `apps/server/src/notify/telegramFormat.ts` (pure): `formatCaption(record)`, `formatFailure(record)`, `escapeHtml`, `fitCaption(text, 1024)`, `snapshotTfs(result, mode)`.
- `apps/server/src/notify/telegramClient.ts`: `sendMediaGroup(chatId, photos[], caption)`, `sendMessage(chatId, text)` qua `fetch` (multipart, không thêm thư viện); nhận `fetchImpl` để test; xử lý 429 `retry_after`. Lỗi trả về không chứa token (che URL).
- `apps/server/src/notify/chartSnapshot.ts`: `captureCharts(id, tfs)` → `Buffer[]`. Dùng `playwright-core` (chuyển từ devDependency sang dependency, hoặc thêm `playwright-core` cùng phiên bản), một browser mở theo nhu cầu, đóng sau 60s không dùng. Mỗi tf: page mới 1600×900, `deviceScaleFactor: 1`, đợi `body[data-snapshot=ready]` tối đa 20s, chụp phần tử `.chart-wrap` (gồm legend symbol/khung).
- `apps/server/src/notify/telegramNotifier.ts`: `start(service)` đăng ký `service.subscribe(e => …)` với `e.kind === 'result'`, chống trùng theo id, xếp hàng, gọi capture + client. **Không sửa** luồng `finish()` của `AnalysisService`.
- `app.ts`: tạo notifier nếu cấu hình đủ, dừng (đóng browser) khi app close.
- Bảo mật: web snapshot chỉ đọc API công khai sẵn có (`/api/analyses/:id`), không thêm endpoint. Chrome headless chỉ mở `SNAPSHOT_WEB_URL` (localhost).

### SPEC.md
Thêm mục "Thông báo Telegram": env, khi nào gửi, nội dung caption, chế độ `?snapshot=`.

## Implementation Steps
1. Config + `.env.example`.
2. `telegramFormat.ts` + `tests/telegramFormat.test.ts`.
3. `telegramClient.ts` + test với `fetchImpl` giả (multipart đúng field, 429 retry, lỗi không lộ token).
4. Web: `snapshotMode.ts` + test; nhánh snapshot trong `App`/`ChartView`, cờ `data-snapshot`.
5. `chartSnapshot.ts`, `telegramNotifier.ts` (+ test notifier với capture/client giả: DONE gửi album, FAILED gửi chữ, CANCELED bỏ, không gửi trùng, chụp lỗi → gửi chữ).
6. Nối vào `app.ts`; SPEC.md.
7. `npm run typecheck`, `npm run lint`, `npm test`; chụp ảnh trang `?snapshot=` (dark) bằng dev server tạm; chạy thử gửi thật vào chat Telegram của bạn với một phân tích DONE có sẵn trong DB (script `scripts/telegram-test.ts <analysisId>`), không đụng pm2 tới khi bạn bảo restart.

## Tests / Acceptance
- Unit: caption đủ dòng, escape HTML, cắt ≤ 1024 giữ phần đầu; bản ghi cũ dùng `action`; `snapshotTfs` top-down / primary; client multipart + retry 429; notifier gửi đúng một lần, bỏ CANCELED, FAILED theo cờ.
- Thủ công: phân tích BTC 4h xong → Telegram nhận album 2–4 ảnh có vùng/entry/SL/TP vẽ đúng, caption đúng số; đóng tab web vẫn nhận; tắt env → không gửi, không lỗi.

## Ngoài phạm vi (plan sau)
- Bot nhận lệnh (`/analyze`, `/last`, nút chọn khung) qua long polling, whitelist `chat_id`.
- Nhiều chat / lọc theo symbol / chỉ gửi khi `ENTER`.

## Ghi chú triển khai
- Không cần chặn ghi localStorage ở web: mỗi ảnh dùng browser context mới của Playwright (trống, tách khỏi Chrome của người dùng) → ảnh luôn dùng lớp/cài đặt mặc định.
- Chế độ snapshot rẽ nhánh ở `main.tsx` (`SnapshotApp`), không gọi `/api/config` nên tự không có lớp order flow / thanh lý / volume gộp.
- `sendMediaGroup` cần ≥ 2 ảnh → 1 ảnh dùng `sendPhoto`.
- Đo thật (server + vite tạm, bản sao DB): BTC 4 khung (1d/4h/1h/1m) chụp ~8s, mỗi ảnh 70–95 KB; id không tồn tại → lỗi "Trang snapshot lỗi (4h): Không tìm thấy".
- Ảnh dùng khung nhìn mặc định của web (nến gần nhất); ở khung 1h/4h vùng kết quả nằm sát mép phải và khá nhỏ — có thể zoom vào vùng phân tích ở plan sau.

## Approval Status
Đã duyệt (2026-11-14, "ok"). Nhánh `feat/telegram-notify` tách từ `feat/book-heatmap`.
