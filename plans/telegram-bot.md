# Bot Telegram nhận lệnh phân tích trong group

## Bối cảnh
Bước 1 (`plans/telegram-notify.md`) đã gửi một chiều: phân tích xong → album ảnh chart + caption vào `TELEGRAM_CHAT_ID`. Bước này cho phép **gõ lệnh trong group** để bot tự chạy phân tích (runner headless sẵn có), rồi gửi ảnh kết quả về đúng group đó. Đồng thời: ảnh của **khung lớn** (khung context lớn hơn khung chính) **tắt lớp Setup và lớp Mức giá** để ảnh gọn, chỉ giữ bối cảnh (range, phase, sự kiện, dự đoán).

## Requirements / Spec
1. **Bật** khi có `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` và `TELEGRAM_BOT_COMMANDS=1` (mặc định `1` khi đủ token/chat). Nhận lệnh bằng **long polling** (`getUpdates`, timeout 30s) — không cần webhook / mở cổng.
2. **Chỉ nhận lệnh từ chat trong whitelist**: `TELEGRAM_CHAT_ID` + `TELEGRAM_ALLOWED_CHATS` (danh sách id, phân cách dấu phẩy). Chat khác → bỏ qua im lặng (không trả lời, không log nội dung). Nếu cấu hình `TELEGRAM_THREAD_ID` thì chỉ nhận lệnh trong topic đó.
   - Tuỳ chọn `TELEGRAM_ALLOWED_USERS` (user id): rỗng = mọi thành viên group được dùng.
3. **Lệnh** (chấp nhận cả dạng `/lenh@TenBot` trong group):
   - `/analyze <SYMBOL> [khungChính] [khungPhụ...]` — ví dụ `/analyze BTCUSDT 4h 1d 1h`. Không nêu khung → khung chính `TELEGRAM_BOT_DEFAULT_TF` (mặc định `4h`) + khung phụ `TELEGRAM_BOT_DEFAULT_CONTEXT` (mặc định `1d,1h,1m`) → phân tích `1d → 4h → 1h → 1m`. Chỉ nêu khung chính → khung phụ = bộ mặc định `1m,1h,4h,1d` bỏ khung chính (vẫn ≤ `AGENT_MAX_TFS`). Khung phụ trùng / sai / quá `AGENT_MAX_TFS` → trả lỗi của `buildTfPlan`.
   - Runner / model: mặc định của server (`AGENT_RUNNER`); tuỳ chọn cờ `runner=agy` / `model=...` (đi qua cùng validate của `service.start`).
   - `/last [SYMBOL]` — gửi lại ảnh + caption của phân tích `DONE` gần nhất (lọc theo symbol nếu có), không chạy phân tích mới.
   - `/status` — phân tích đang chạy / đang chờ trong hàng đợi.
   - `/cancel` — huỷ phân tích do bot khởi tạo đang chạy (chỉ các phân tích bot tạo).
   - `/help` — danh sách lệnh.
   - Không hỗ trợ ảnh Bookmap / order flow Binance qua bot ở bước này.
4. **Luồng `/analyze`**:
   - Gọi `service.start(...)` (không thêm đường tắt quyền; runner giữ nguyên khoá `mcp__wyckoff__*`). Lỗi validate → trả lời ngắn lỗi đó (reply vào tin nhắn lệnh).
   - Thành công → trả lời `⏳ Đang phân tích BTCUSDT 4h (1d → 4h → 1h)… #<id 8 ký tự>` (reply tin lệnh); nếu hàng đợi đang bận → kèm "xếp hàng thứ N".
   - Khi phân tích kết thúc, notifier hiện có gửi album ảnh **về chat đã ra lệnh** (reply vào tin lệnh), thay vì chỉ `TELEGRAM_CHAT_ID`. Phân tích khởi tạo từ web vẫn gửi về `TELEGRAM_CHAT_ID` như cũ. Không gửi trùng (một phân tích → một album).
   - `FAILED` của phân tích do bot tạo luôn trả lời lỗi (bất kể `TELEGRAM_NOTIFY_FAILED`), `CANCELED` → trả lời "Đã huỷ".
5. **Chống lạm dụng**: mỗi chat tối đa `TELEGRAM_BOT_MAX_PENDING` (mặc định 2) phân tích do bot tạo đang chờ/chạy; vượt → trả lời từ chối. Lệnh cũ hơn 2 phút lúc server khởi động (backlog `getUpdates`) → bỏ qua, không chạy lại.
6. **Ảnh khung lớn tắt Setup + Mức giá** (áp dụng cho mọi ảnh gửi Telegram, kể cả phân tích từ web):
   - Khung có vai trò `HTF` (lớn hơn `primaryTf`) → ẩn lớp `action` (Setup / position tool) và `levels` (vạch Mức giá: support/resistance/creek/ice…).
   - Khung chính và khung nhỏ (`LTF`) giữ đủ lớp như hiện tại.
   - Lớp `orderflow` không đổi (snapshot vốn không có order flow live).
7. Token không xuất hiện trong log / lỗi / DB / response. Lỗi Telegram / polling không ảnh hưởng server: polling lỗi → chờ lùi dần (5s → 60s) rồi thử lại.
8. Không đổi contract agent (`analysis.ts`), prompt, validator, quyền runner.

## Technical Design

### Config (`apps/server/src/config.ts`, `.env.example`)
| Env | Mặc định | Ý nghĩa |
|---|---|---|
| `TELEGRAM_BOT_COMMANDS` | `1` | Bật nhận lệnh (cần token + chat id) |
| `TELEGRAM_ALLOWED_CHATS` | — | Chat id thêm được ra lệnh (ngoài `TELEGRAM_CHAT_ID`) |
| `TELEGRAM_ALLOWED_USERS` | — | Giới hạn user id (rỗng = mọi người trong chat được phép) |
| `TELEGRAM_BOT_DEFAULT_TF` | `4h` | Khung chính khi lệnh không nêu |
| `TELEGRAM_BOT_DEFAULT_CONTEXT` | `1d,1h,1m` | Khung phụ khi lệnh không nêu khung nào |
| `TELEGRAM_BOT_MAX_PENDING` | `2` | Số phân tích bot tạo đang chờ/chạy tối đa mỗi chat |

### Web: snapshot ẩn lớp theo vai trò khung
- `snapshotMode.ts`: `parseSnapshotParams` đọc thêm `hide=action,levels` (chỉ nhận `LayerKey` hợp lệ) → `SnapshotParams.hide: LayerKey[]`. Pure, có test.
- `SnapshotApp`: set `useAnalysisStore.layers` = mặc định với các lớp trong `hide` = false trước khi `setCurrent`.
- Server quyết định ẩn gì (web không tự suy vai trò) → giữ web đơn giản.

### Server
- `notify/telegramFormat.ts` (pure): thêm `snapshotLayersHidden(tf, primaryTf)` → `['action','levels']` nếu `roleOf === 'HTF'`, ngược lại `[]`.
- `notify/chartSnapshot.ts`: `CaptureFn` nhận `{ tf, hide }[]` (thay `tfs: string[]`), thêm `hide` vào URL.
- `notify/telegramCommands.ts` (pure): `parseCommand(text, botUsername)` → `{ cmd: 'analyze', symbol, primaryTf, contextTfs, runner?, model? } | { cmd: 'last', symbol? } | { cmd: 'status' | 'cancel' | 'help' } | { error } | null`. Viết hoa symbol, dùng `normalizeSymbol`, kiểm tra khung bằng `isTimeframe`.
- `notify/telegramClient.ts`: thêm `getUpdates(offset, timeoutSec)` (signal timeout > long-poll timeout), `getMe()`, tham số `replyTo` (`reply_parameters`, `allow_sending_without_reply`) và `threadId` theo từng lần gửi cho `sendMessage` / `sendPhotos`.
- `notify/telegramBot.ts`: vòng long polling + định tuyến lệnh.
  - Giữ map `analysisId → { chatId, threadId?, replyTo }` (trong bộ nhớ, tối đa 500) cho phân tích bot tạo; `pendingByChat` đếm theo chat.
  - Gọi `service.start` / `service.cancel` / đọc `repo` cho `/last`, `/status`.
  - Offset `getUpdates` lưu bộ nhớ; lúc khởi động bỏ update có `date` cũ hơn 2 phút.
- `notify/telegramNotifier.ts`: thêm `route(rec) → { chatId, threadId?, replyTo? } | null` (do bot cung cấp; null → mặc định `TELEGRAM_CHAT_ID`); FAILED/CANCELED của phân tích bot tạo luôn trả lời. Hàm gửi album dùng chung cho `/last`.
- `app.ts`: tạo bot nếu bật, `stop()` (abort polling) khi app close.
- Bảo mật: không thêm endpoint HTTP; whitelist chat/user kiểm tra trước mọi xử lý; bot chỉ gọi API service sẵn có như web.

### SPEC.md
Cập nhật mục "Thông báo Telegram": lệnh bot, whitelist, env mới, quy tắc ẩn lớp ở ảnh khung lớn, tham số `hide` của `?snapshot=`.

## Implementation Steps
1. Config + `.env.example`.
2. `telegramCommands.ts` + `tests/telegramCommands.test.ts`; `snapshotLayersHidden` + test.
3. Web: `parseSnapshotParams` đọc `hide` (+ test), `SnapshotApp` áp lớp.
4. `chartSnapshot.ts` nhận `{tf, hide}`; notifier định tuyến + test (route về chat lệnh, reply, FAILED/CANCELED bot luôn báo, không trùng).
5. `telegramClient.ts`: `getUpdates`, `getMe`, reply/thread per call + test với `fetchImpl` giả.
6. `telegramBot.ts` + test với client/service giả (whitelist, backlog cũ bị bỏ, giới hạn pending, `/analyze` lỗi validate, `/last`, `/cancel`).
7. Nối `app.ts`; SPEC.md.
8. `npm run typecheck`, `npm run lint`, `npm test`; chụp ảnh `?snapshot=…&hide=action,levels` bằng `scripts/screenshot.ts`; chạy thử thật trong group của bạn (server tạm, không đụng pm2 tới khi bạn bảo restart).

## Tests / Acceptance
- Unit: parse lệnh (có/không `@bot`, không nêu khung → 4h + 1d,1h,1m; chỉ nêu khung chính → bộ mặc định bỏ khung chính, khung sai, cờ runner/model); whitelist chat/user/thread; bỏ backlog cũ; giới hạn pending; notifier route + reply; ảnh HTF có `hide=action,levels`, primary/LTF không.
- Thủ công: gõ `/analyze BTCUSDT` trong group → bot trả "Đang phân tích… (1d → 4h → 1h → 1m)" → vài phút sau album 4 ảnh reply vào lệnh; ảnh 1d không có position tool / vạch mức giá, ảnh 4h/1h/1m đủ; chat ngoài whitelist gõ lệnh → không phản hồi; `/last BTCUSDT` gửi lại album.

## Đã xác nhận (2026-11-14)
- "Vạch giá" = lớp **Mức giá** (`levels`); ở khung lớn chỉ ẩn `action` + `levels`, không ẩn thêm lớp nào.
- Bộ khung mặc định: `1m 1h 4h 1d` (khung chính `4h`).

## Ngoài phạm vi
- Nút inline chọn khung / runner; ảnh Bookmap / order flow qua bot; webhook; lưu map lệnh qua restart.

## Ghi chú triển khai
- `SendOptions.threadId = null` → không gửi vào topic (chat phụ không có topic không bị gắn topic mặc định của chat chính).
- `AnalysisService.queueSnapshot()` (mới) cho `/status` và vị trí hàng đợi.
- Đã chụp thật (web dev tạm 5174 + server pm2 chỉ đọc), phân tích BTCUSDT khung chính 1m: ảnh 1d/4h/1h không còn Setup / Mức giá, ảnh 1m đủ. Vạch tường order flow đã lưu trong phân tích (lớp `orderflow`) vẫn hiện ở mọi khung (đúng phạm vi đã chốt).
- Chưa chạy thử bot thật trong group: cần restart server pm2 (chưa đụng).

## Approval Status
Đã duyệt (2026-11-14, "ok"). Làm trên nhánh `feat/telegram-notify`.
