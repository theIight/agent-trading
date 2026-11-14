# Alert khi giá chạm vùng entry của setup (crypto)

## Bối cảnh
Phân tích xong có setup chờ khớp (LIMIT/STOP) nhưng phải tự canh giá. Muốn server tự canh (kể cả khi đóng trình duyệt) và báo Telegram **một lần** khi giá chạm vùng entry của setup trong **phân tích mới nhất**. Chỉ áp dụng cho crypto (nguồn `binance-futures`); vàng / forex không xử lý.

## Requirements / Spec
1. **Đặt alert** khi phân tích chuyển `DONE` (mọi nguồn: web, bot, interactive) và symbol là crypto (`router.sourceOf(symbol) === 'binance-futures'`):
   - Phân tích mới nhất **theo từng symbol**: phân tích DONE mới của symbol → alert cũ của symbol đó chuyển `REPLACED` (không báo).
   - Mỗi setup của `tradePlan.setups` được đặt một alert, **mỗi setup báo tối đa 1 lần**. Bỏ qua:
     - `decision = STAND_ASIDE` (setup tham khảo);
     - setup `entryType = MARKET` khi `decision = ENTER` (đã vào ở giá hiện tại);
     - bản ghi cũ không có `tradePlan`.
   - Không có setup hợp lệ → không đặt alert, không báo gì thêm.
   - Toạ độ lấy từ kết quả đã qua `validateSubmission` (entryLow/entryHigh/SL/TP, R:R server).
2. **Kích hoạt** khi giá chạm vùng `[entryLow, entryHigh]` sau thời điểm đặt (`armedAt` = lúc DONE):
   - Nguồn chính: nến **1m đã đóng** của chart (Binance Futures) qua `KlineService`, kiểm tra mỗi phút (đóng nến + 3s): nến có `time ≥ floor(armedAt, 1m)` và `low ≤ entryHigh && high ≥ entryLow` → chạm. Dùng high/low nên không sót râu nến giữa hai lần kiểm.
   - Đường nhanh (tuỳ chọn, khi symbol có collector order flow Binance futures — xem `plans/orderflow-top-coins.md`): giá khớp aggTrade − basis chạm vùng → báo ngay (độ trễ ~1s). Nến 1m vẫn là lưới an toàn.
   - Lúc đặt mà giá hiện tại **đã nằm trong vùng** → báo ngay, ghi "đang ở trong vùng entry".
3. **Tự huỷ** (không báo):
   - Giá chạm SL trước khi chạm entry (high ≥ SL với SHORT / low ≤ SL với LONG ở nến chưa chạm entry) → `INVALIDATED`. Cùng một nến chạm cả entry lẫn SL → tính là chạm entry (entry luôn nằm giữa giá và SL nên giá đi qua entry trước), tin báo ghi thêm "đã chạm cả SL trong cùng nến".
   - Hết `setup.validUntil`; không có → `PRICE_ALERT_MAX_AGE_H` (mặc định 72h) → `EXPIRED`.
   - Có phân tích DONE mới cùng symbol → `REPLACED`.
4. **Báo Telegram** (cần `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`):
   - Gửi về chat của phân tích: phân tích do bot tạo → chat/topic đã ra lệnh; còn lại → `TELEGRAM_CHAT_ID`. Trả lời vào album kết quả của phân tích đó (lưu `message_id` khi gửi album; không có → gửi thường).
   - Nội dung: `🔔 BTCUSDT chạm entry ① SHORT LIMIT 1m · vùng 67,400–67,500 · giá 67,452 · SL 67,900 · TP 66,600 / 66,050 · R:R 4.11 · phân tích 12:34 14/11`.
   - Không chụp ảnh (giữ nhanh, nhẹ). Có thể thêm sau.
5. **Một lần, bền qua restart**: trạng thái lưu SQLite, đổi `ARMED → TRIGGERED` trong transaction trước khi gửi; gửi lỗi → log, không báo lại. Restart: nạp alert `ARMED`, kiểm tra bù nến 1m từ lần kiểm cuối (tối đa 6h) để không sót và không báo trùng.
6. **Web**: panel phân tích hiện trạng thái alert từng setup (🔔 đang canh / ✅ đã chạm hh:mm / ✖ huỷ — lý do). API chỉ đọc: `GET /api/analyses/:id/alerts`.
7. Bot: `/alerts` liệt kê alert đang canh; `/alerts off <SYMBOL>` tắt alert của symbol (chuyển `CANCELED`).
8. Bật/tắt: `PRICE_ALERTS=1` (mặc định bật). Không đổi contract agent (`analysis.ts`), prompt, validator, quyền runner.

## Technical Design
### Dữ liệu
Bảng `price_alerts`:
`id INTEGER PK, analysis_id, symbol, setup_index, direction, entry_type, entry_low, entry_high, stop_loss, take_profits JSON, risk_reward, valid_until, armed_at, checked_until (time nến 1m cuối đã kiểm), status (ARMED|TRIGGERED|INVALIDATED|EXPIRED|REPLACED|CANCELED), status_at, trigger_price, note`. Index `(status, symbol)`.
Bảng/ cột lưu `telegram_messages(analysis_id, chat_id, thread_id, message_id)` để trả lời vào album.

### Code
- `packages/shared/src/alerts.ts`: kiểu `PriceAlert`, `PriceAlertStatus` (contract cho UI).
- `apps/server/src/alerts/alertLogic.ts` (pure): `alertsFromRecord(rec, now)` (lọc setup theo luật 1), `evaluateCandles(alert, candles)` → `{ status, price?, at? }` theo luật 2–3, `formatAlert(alert, rec)`.
- `apps/server/src/alerts/alertRepo.ts`: CRUD + `replaceForSymbol`, `markTriggered` (transaction, chỉ khi còn ARMED).
- `apps/server/src/alerts/alertWatcher.ts`: nghe `result` → tạo alert; timer căn theo phút gọi `KlineService.getKlines({ symbol, tf: '1m', closedOnly: true, limit })` cho mỗi symbol có alert ARMED (gom theo symbol); đường nhanh qua hook giá của collector order flow nếu có; gửi qua `TelegramClient`.
- Notifier: lưu `message_id` trả về từ `sendPhoto`/`sendMediaGroup` (client trả `Message[]`).
- Bot: lệnh `/alerts`.
- Web: hiển thị trạng thái trong `AnalysisPanel` (gọi API khi mở phân tích + cập nhật qua SSE `alert`).

### Config
| Env | Mặc định | Ý nghĩa |
|---|---|---|
| `PRICE_ALERTS` | `1` | Bật canh entry |
| `PRICE_ALERT_MAX_AGE_H` | `72` | Hạn mặc định khi setup không có `validUntil` |

### SPEC.md
Thêm mục "Alert chạm entry".

## Implementation Steps
1. Contract `alerts.ts` + bảng DB + config.
2. `alertLogic.ts` + `tests/priceAlert.test.ts`.
3. `alertRepo.ts`, `alertWatcher.ts` (+ test với kline/clock/sender giả: chạm 1 lần, huỷ khi chạm SL trước, hết hạn, thay thế, bù sau restart, đang trong vùng lúc đặt).
4. Lưu `message_id` album; trả lời alert vào album.
5. Bot `/alerts`; API + panel web; SPEC.md.
6. `npm run typecheck`, `npm run lint`, `npm test`; ảnh panel bằng `scripts/screenshot.ts`; chạy thật với một phân tích crypto có setup gần giá (restart pm2 khi bạn đồng ý).

## Tests / Acceptance
- Unit: lọc setup (STAND_ASIDE / MARKET+ENTER / không tradePlan), chạm vùng theo high/low, SL trước entry → huỷ, cùng nến chạm cả hai, hết hạn, REPLACED, chỉ TRIGGERED một lần dù gọi đánh giá nhiều lần / restart.
- Thủ công: phân tích ETHUSDT có setup LIMIT → giá chạm vùng → Telegram nhận đúng 1 tin trả lời vào album; phân tích XAUUSD → không đặt alert.

## Mặc định đã chọn (bạn chưa trả lời — đổi được trước khi duyệt)
- "Phân tích sau cùng" tính **theo từng symbol**.
- **Mỗi setup báo 1 lần** (không huỷ setup khác khi một setup chạm).
- Lúc đặt mà giá đã trong vùng → **báo ngay**.

## Approval Status
Đã duyệt (2026-11-14, "hãy xử lý 4 plan đấy"). Nhánh `feat/alerts-orderflow-layout`.
