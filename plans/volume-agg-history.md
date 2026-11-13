# Volume nhiều sàn phủ hết lịch sử nến đang xem trên chart

## Bối cảnh
- Người dùng (2026-11-12): ở nguồn "Tổng 4 sàn", volume bị giới hạn so với khi chọn Binance Futures hoặc "Gộp perp + spot".
- Nguyên nhân:
  - Chart tải 800 nến lúc đầu, mỗi lần kéo sang trái tải thêm 800 nến.
  - Volume nhiều sàn chỉ có cho **1000 nến đã đóng gần nhất**: web gửi `limit = min(số nến, 1000)`, server chặn ở `VOLAGG_MAX_BARS = 1000`.
  - Kéo sang trái quá 1000 nến thì:
    - các nguồn đơn lẻ và "Tổng 4 sàn" để trống cột;
    - "Gộp perp + spot" lặng lẽ lấy volume Binance Futures thay vào (thang đo khác hẳn, dễ hiểu nhầm);
    - chỉ Binance Futures là đủ.

## Requirements / Spec
1. Volume nhiều sàn phủ đúng số nến đang có trên chart, tối đa **4000 nến** (5 lần tải trang). Kéo sang trái tải thêm nến thì volume nhiều sàn cũng tải thêm.
2. Nếu vẫn vượt quá 4000 nến, hoặc sàn không còn dữ liệu cũ:
   - nến không có volume của nguồn đang chọn thì để trống cột, áp dụng cho **mọi** nguồn khác Binance Futures, kể cả "Gộp" (bỏ cách lấy volume Binance Futures thay vào);
   - dòng ghi chú: "Volume nhiều sàn chỉ có từ <ngày giờ>".
3. Không đổi phần gửi cho agent: `get_features.volumeAgg` vẫn dùng số nến như hiện tại.

## Technical Design
- Server: `VOLAGG_MAX_BARS` 1000 → 4000.
  - Lần tải đầu của 5m sẽ chậm hơn, ước tính khoảng 10 giây: OKX trả 100 nến mỗi trang, nghỉ 150ms giữa các trang.
  - Đã có cache trong bảng `venue_volume`, nên các lần sau chỉ tải phần còn thiếu.
- Web:
  - `ChartView` gửi `min(bars.count, 4000)`;
  - `buildVolumeView` chế độ gộp: nến không có agg thì để trống cột (whitespace), không lấy `c.volume` thay vào. Nến đang chạy ở chế độ gộp vẫn giữ volume Binance Futures như hiện tại.
  - Thêm ghi chú mốc bắt đầu có dữ liệu khi nến đầu tiên trên chart cũ hơn agg đầu tiên.
- Trong lúc tải thêm, dữ liệu cũ vẫn hiển thị (store đã giữ `data` khi cùng symbol và tf).

## Implementation Steps
1. Test `buildVolumeView`: chế độ gộp với nến không có agg thì để trống; hàm tính mốc bắt đầu.
2. Server: nâng giới hạn; web: đổi limit, thêm ghi chú.
3. typecheck, lint, test. Chụp BTC 5m, "Tổng 4 sàn", sau khi kéo trái tải thêm 1 trang (khoảng 1600 nến): cột phủ hết.

## Tests / Acceptance
- BTC 5m có 1600 nến: "Tổng 4 sàn" có cột ở cả 1600 nến, đối chiếu vài nến cũ với API.
- "Gộp": không còn nến nào lấy volume Binance Futures thay vào ở phần lịch sử.

## Ghi chú triển khai
- `VOLAGG_MAX_BARS = 4000` chuyển sang `packages/shared` (web và server dùng chung).
- Đo thật: lần tải đầu 4000 nến BTC mất khoảng 8 giây ở cả 5m và 1h; không sàn nào thiếu nến. Nến cũ (Binance spot) khớp API.

## Approval Status
Đã duyệt (2026-11-12, "duyệt").
