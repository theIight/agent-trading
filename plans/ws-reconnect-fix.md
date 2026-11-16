# Sửa lỗi WebSocket không tự kết nối lại sau khi rớt mạng

## Hiện tượng (16/11/2026)
- 04:45 máy rớt mạng (`ENOTFOUND api.binance.com`, `ENETUNREACH`, Telegram cũng lỗi). Mạng có lại sau đó, REST Binance vẫn chạy (resync "định kỳ" log đều đặn).
- Tất cả collector order flow (BTC, vàng, 8 coin) và thanh lý (Binance, OKX) vẫn ở trạng thái "Mất kết nối — đang thử lại", mẫu cuối lúc 04:46. Tiến trình server không còn socket nào tới Binance, cũng không thử kết nối lại.

## Nguyên nhân (đã tái hiện)
- `WebSocket` có sẵn của Node v22.23.2: khi **mở kết nối thất bại** (DNS lỗi, mạng không tới được) chỉ bắn `error`, **không bắn `close`**, `readyState` kẹt ở 0 (CONNECTING) mãi.
- `orderflow/collector.ts` và `liquidation/collector.ts` chỉ lên lịch kết nối lại trong `close` → socket chết nằm lại trong `sockets`, không bao giờ kết nối lại.
- Gọi `ws.close()` trong `error` không cứu được: `error` bị bắn lặp liên tục và `close` vẫn không đến. `market/tiingoOkx.ts` đang làm đúng kiểu này (`onerror = () => ws.close()`), nên có thể quay vòng khi Tiingo rớt mạng.

## Requirements / Spec
1. Một socket bị coi là chết và được thay bằng socket mới (theo backoff hiện có: 1s → 60s, thanh lý / Tiingo giữ backoff riêng) khi xảy ra **bất kỳ** trường hợp nào sau:
   - nhận `close`;
   - nhận `error`;
   - sau 20 giây vẫn chưa `open` (timeout kết nối);
   - đã `open` nhưng 60 giây không có message nào (kết nối treo nửa vời sau khi mạng/Wi-Fi đổi hoặc máy ngủ). Futures depth@100ms, aggTrade, thanh lý Binance và OKX (đã có ping) đều có dữ liệu thường xuyên hơn mức này.
2. Mỗi socket chỉ kích hoạt kết nối lại **một lần**, kể cả khi `error` bắn lặp hoặc `close` đến sau `error`.
3. Socket cũ bị bỏ: gỡ khỏi map, bỏ qua mọi sự kiện đến sau, thử `close()` trong try/catch đúng một lần, không gọi lại trong handler `error`.
4. Socket depth bị bỏ → reset sổ lệnh như khi `close` hiện nay.
5. Log một dòng mỗi lần kết nối lại, kèm lý do (`error` / `close` / `timeout mở` / `im lặng 60s`). Log thêm khi kết nối lại thành công.

## Technical Design
- Helper dùng chung `apps/server/src/ws/resilientSocket.ts`: `watchSocket(ws, { openTimeoutMs, idleTimeoutMs, onDead(reason) })`.
  - Gắn listener `open` / `message` / `close` / `error` và các timer.
  - Gọi `onDead` đúng một lần, rồi dọn timer.
  - Thời gian lấy qua tham số `setTimer` / `now` để test được bằng fake timers.
- `orderflow/collector.ts`, `liquidation/collector.ts`: thay xử lý `close` hiện có bằng `onDead` gồm gỡ socket, reset sổ (nếu là depth) và `scheduleReconnect`.
- `market/tiingoOkx.ts`: bỏ `onerror = () => ws.close()`, dùng cùng helper (chỉ có timeout mở và error/close; không đặt timeout im lặng vì cuối tuần FX có thể không có quote).
- Không đổi contract, API hay UI.

## Implementation Steps
1. `resilientSocket.ts` + `tests/resilientSocket.test.ts` với fake WebSocket:
   - `error` không có `close` → kết nối lại;
   - `error` lặp → chỉ một lần;
   - `close` sau `error` → không kết nối lại 2 lần;
   - timeout mở;
   - im lặng 60s;
   - message giữ kết nối sống.
2. Tích hợp vào 3 chỗ trên. Test collector hiện có phải vẫn qua; thêm test "error trước khi open → kết nối lại".
3. `npm run typecheck`, `npm run lint`, `npm test`.
4. Kiểm thử thật: chạy collector trỏ tới host không phân giải được → thấy log thử lại theo backoff; đổi về URL thật → kết nối lại và có mẫu mới.
5. Restart `wca-server` (pm2). Lưu ý: bước này cũng nạp các thay đổi server order flow đang chưa commit trên nhánh (`binanceOrderflow.ts`, `calc.ts`).

## Tests / Acceptance
- Rớt mạng rồi có lại: trong ≤ 60s sau khi mạng có lại, order flow và thanh lý quay về "Đang ghi sổ lệnh", có mẫu mới.
- Không còn trạng thái kẹt "Mất kết nối" khi REST vẫn chạy.

## Ghi chú triển khai
- Helper đặt tên `apps/server/src/ws/watchSocket.ts` (plan ghi `resilientSocket.ts`).
- Thanh lý: ngưỡng im lặng OKX 60s (có `pong` mỗi 25s), Binance 300s. Plan ghi 60s cho tất cả; nới cho Binance vì `!forceOrder@arr` có thể im lâu khi thị trường yên, tránh kết nối lại vô ích.
- Tiingo: bỏ `onerror = () => ws.close()`, chỉ có timeout mở + error/close. Test Tiingo đổi fake sang `EventTarget`.
- Test: `tests/watchSocket.test.ts` (8), `tests/wsReconnect.test.ts` (3: BookCollector lỗi khi mở → backoff 1s/2s rồi đồng bộ; timeout mở 20s / im lặng 60s; thanh lý kết nối lại từng sàn).
- Kiểm thử thật (tsx, BookCollector BTCUSDT): 3 lần đầu trỏ tới host không phân giải được → mở lại sau 1s, 2s, 4s, chỉ 1 dòng log "mất (error)"; lần 4 URL thật → "đã kết nối lại", "đồng bộ sổ lệnh (kết nối)", status `connected: true, synced: true`.

## Approval Status
Đã duyệt (2026-11-16, "ok").
