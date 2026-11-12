# Đếm ngược đóng nến trên chart

## Requirements / Spec
1. Giống TradingView: ngay **dưới nhãn giá hiện tại trên trục giá bên phải**, hiện thời gian còn lại tới khi nến đang chạy của khung đang xem đóng.
   - Định dạng: `mm:ss` khi < 1 giờ (vd `00:42`, `03:17`); `hh:mm:ss` khi < 1 ngày (vd `02:15:09`); khung 1D/1W: `1d 04:12` hoặc `04:12:30`.
   - Cùng màu nền với nhãn giá (xanh nến tăng / đỏ nến giảm), chữ nhỏ hơn một chút.
2. Cập nhật mỗi giây. Mốc đóng = `time` của nến cuối + độ dài khung (1W theo nến của sàn, mở thứ Hai).
3. Ẩn khi: nến cuối đã đóng mà chưa có nến mới (thị trường vàng đóng cửa cuối tuần, mất kết nối lâu), hoặc chart chưa có dữ liệu.
4. Áp dụng mọi symbol và khung.
5. Đồng hồ: dùng giờ máy; nếu nguồn realtime có giờ sàn (Binance gửi `E` = giờ sự kiện) thì hiệu chỉnh lệch giờ để đếm khớp sàn (lệch > 1 giây mới hiệu chỉnh).

## Technical Design
- **Pure** `apps/web/src/chart/countdown.ts`: `closeTime(lastCandle, tf)`, `formatCountdown(secLeft, tf)`, test trong `tests/`.
- **Vẽ**: primitive nhỏ gắn vào `candleSeries` (`priceAxisViews`): một nhãn trên trục giá đặt ngay dưới nhãn giá cuối (`priceToCoordinate(close) + chiều cao nhãn`), nền theo màu nến cuối. `setInterval` 1 giây gọi `requestUpdate`; dừng khi destroy.
- **Lệch giờ**: `liveFeed` truyền thêm `E` (ms) cho ChartController khi có; lưu `skew = E − Date.now()` (làm mượt, bỏ khi |skew| < 1s). SSE vàng không có giờ sàn → dùng giờ máy.
- SPEC mục chart cập nhật.

## Implementation Steps
1. `countdown.ts` + test (định dạng theo khung, mốc đóng 1m/5m/1h/4h/1d/1w, ẩn khi quá hạn).
2. Primitive nhãn trục giá + timer + skew.
3. typecheck, lint, test; chụp ảnh BTC 1m và 4H, vàng.

## Tests / Acceptance
- BTC 1m: nhãn đếm `00:59 → 00:00` rồi quay lại `00:59` khi nến mới tới; nằm ngay dưới nhãn giá, không đè.
- 4H hiện `hh:mm:ss`; 1D hiện số giờ còn lại.
- Vàng cuối tuần (không có nến mới): không hiện nhãn.

## Ghi chú triển khai
- API nhãn trục giá của lightweight-charts không cho đổi cỡ chữ từng nhãn → nhãn đếm cùng cỡ chữ với nhãn giá.
- Đã chụp: BTC 1m `00:27 → 00:25`, BTC 4H `03:14:19`, vàng 1H `14:10`.

## Approval Status
Đã duyệt (2026-11-12, "ok").
