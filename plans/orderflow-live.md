# Order flow hiện sẵn trên chart (không cần chạy phân tích)

Kèm mục 10 của `plans/bookmap.md` (độ dày vạch theo khối lượng). Hai mục duyệt cùng nhau.

## Bối cảnh
Hiện order flow chỉ hiện trên chart sau khi chạy phân tích (vạch lấy từ kết quả). Người dùng muốn mở chart là thấy ngay.

## Requirements / Spec

1. **BTCUSDT (nguồn Binance):** mở chart là vẽ ngay tường thanh khoản (độ dày theo khối lượng, theo mục 10) và POC 24h. Dữ liệu lấy từ collector đang chạy ở server, **tự làm mới mỗi 15 giây**.
   - Cùng bộ lọc với phân tích: tường đứng đủ lâu (lọc spoof), ẩn tường < 40% tường lớn nhất, tối đa 3 mỗi phía.
   - Giá đã quy đổi spot → chart bằng basis đo lúc lấy.
   - Lịch sử sổ lệnh < 30 phút → vẫn vẽ, kèm dòng nhỏ ở góc chart "Order flow: lịch sử 12 phút".
   - Mất kết nối Binance → giữ vạch cũ, dòng góc chart báo "mất kết nối".
2. **XAUUSD: ngoài phạm vi** (người dùng chốt 2026-11-12: "chỉ áp dụng cho BTC, vàng tạm thời bỏ qua"). Vàng giữ nguyên như hiện tại: order flow chỉ hiện trên chart khi mở một phân tích có ảnh Bookmap.
3. **Layer:** toggle "Order flow" trên chart luôn hiện với symbol có collector Binance (BTC), không phụ thuộc đang mở phân tích nào; bật mặc định, nhớ trong localStorage.
4. **Khi đang xem một phân tích BTC:** chart vẫn vẽ order flow **hiện tại** (live), không vẽ thêm bản chụp lúc phân tích, để không ra hai bộ vạch trùng nhau. Bản chụp lúc phân tích vẫn xem ở panel kết quả như hiện nay.
5. Chỉ hiển thị, không ảnh hưởng agent, validator, entry/SL/TP.

## Technical Design

- **Server:**
  - `GET /api/orderflow/:symbol/levels` → `{source, asOf, historyMin, basis, connected, levels[]}`.
  - Binance: dùng lại `BinanceOrderflow.snapshot()`. Nến 1m spot 24h được cache trong bộ nhớ và chỉ tải thêm nến mới, để không gọi Binance 2 request mỗi 15 giây. Giá chart lấy từ `KlineService` (1m).
  - Symbol không bật collector Binance → 404 (web không poll).
- **Web:**
  - Store mới `useOrderflowStore`: poll 15 giây theo symbol đang xem; dừng khi đổi symbol.
  - `OverlayManager` nhận thêm `liveOrderflow`. `buildOverlayModel` lấy `orderflowLines` từ live thay vì từ `analysis.orderflow`. Vẽ được cả khi chưa có phân tích (model chỉ có order flow).
  - `LayerToggles` hiện "Order flow" khi có dữ liệu live. Dòng trạng thái nhỏ ở góc trên trái chart.
- **SPEC:** cập nhật mục API và mục Order flow trên chart.

## Implementation Steps
1. Mục 10 (độ dày vạch): `buildOrderflowLines` thêm `width`, `dashed` + test; primitive vẽ dải liền.
2. Cache nến spot 1m (incremental) + endpoint levels, có test.
3. Store poll + OverlayManager/model vẽ khi không có phân tích + toggle + dòng trạng thái.
4. SPEC/README; typecheck, lint, test; chụp ảnh chart BTC mới mở (chưa phân tích) và kiểm tra chart vàng không đổi.

## Tests / Acceptance
- Mở chart BTC, chưa phân tích: thấy vạch tường dày/mỏng theo khối lượng + POC, tự đổi sau ≤ 15 giây khi sổ lệnh đổi.
- Mở phân tích cũ: không bị hai bộ vạch.
- Vàng: hành vi không đổi (chỉ có vạch khi mở phân tích Bookmap).
- Server không gọi Binance klines quá 1 request mỗi 15 giây cho mỗi symbol khi đang poll.

## Mặc định đã chốt
- Chu kỳ làm mới 15 giây; ngưỡng ẩn tường giữ 40% (người dùng không yêu cầu đổi).

## Approval Status
Đã duyệt (2026-11-12, "ok").
