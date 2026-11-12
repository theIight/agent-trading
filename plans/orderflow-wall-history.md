# Lịch sử tường thanh khoản trên chart (tường bị quét vẫn còn vạch)

## Bối cảnh
Hiện chart BTC chỉ vẽ tường **đang tồn tại**, kéo ngang toàn chart. Tường bị giá quét qua (khớp hết / hấp thụ) thì biến mất khỏi sổ lệnh và mất vạch. Người dùng muốn giống heatmap Bookmap: tường đã bị quét vẫn để lại vạch, **từ lúc tường xuất hiện tới đúng lúc giá quét qua**.

Chỉ áp dụng cho BTC (nguồn Binance). Vàng không đổi.

## Requirements / Spec
1. Mỗi tường là **một đoạn theo thời gian** (không còn kéo ngang toàn chart):
   - **Đang tồn tại**: từ lúc xuất hiện → kéo tới mép phải chart (như hiện nay nhưng có điểm bắt đầu).
   - **Bị quét / hấp thụ** (giá chạm tới mức tường rồi tường biến mất hoặc giảm còn < 50%): từ lúc xuất hiện → đúng thời điểm bị quét. Cuối đoạn có dấu × nhỏ.
   - **Bị rút** (biến mất khi giá chưa chạm, thường là lệnh ảo): vẽ **nét chấm mờ, mảnh, không nhãn** để biết chỗ có hiện tượng này (cùng quy tắc lọc như tường bị quét, tối đa 6 đoạn gần nhất).
2. Độ dày theo khối lượng lớn nhất mà tường đạt được (1–6px, như mục 10), màu đỏ/xanh như cũ, mờ 30%. Nhãn số khối lượng ở cuối đoạn (tường bị quét) hoặc mép phải (tường đang tồn tại).
3. Lọc:
   - Tường phải đứng ≥ 5 phút.
   - Tường đang tồn tại: giữ quy tắc hiện tại (≥ 40% tường lớn nhất, tối đa 3 mỗi phía).
   - Tường đã bị quét: khối lượng đỉnh ≥ 40% tường lớn nhất trong cửa sổ; hiện tối đa 6 đoạn gần nhất.
4. Cửa sổ lịch sử: 24 giờ (bằng thời gian server lưu sổ lệnh). Lịch sử chỉ có từ lúc collector chạy.
5. Lưu ý hiển thị: trên khung lớn (1H, 4H) một tường đứng 20 phút chỉ rộng chưa tới 1 nến, nên đoạn rất ngắn. Xem rõ nhất ở khung 1m–15m.
6. Chỉ là hiển thị: agent, validator, entry/SL/TP không đổi.

## Technical Design
- **Pure** `findWallSegments(samples, candles, opts)` trong `apps/server/src/orderflow/calc.ts`:
  - Mỗi mẫu: bucket ≥ max(3 × median cùng phía, `ORDERFLOW_WALL_MIN_<SYMBOL>`, mặc định BTC 8, cấu hình trong `.env`) thì là ứng viên tường.
  - Mở đoạn khi bucket vượt ngưỡng. Đoạn tiếp tục khi size ≥ 50% đỉnh của đoạn (cho phép hụt 1 mẫu). Khi kết thúc thì phân loại:
    - `consumed`: trong khoảng từ mẫu cuối còn tường tới mẫu kế tiếp, giá chạm bucket. Tường mua: low nến 1m spot hoặc mid ≤ cận trên bucket; tường bán: high hoặc mid ≥ cận dưới bucket. Thời điểm quét lấy theo nến 1m chạm đầu tiên.
    - `pulled`: các trường hợp còn lại.
    - `active`: còn ở mẫu mới nhất.
  - Kết quả: `{side, sourcePrice, start, end | null, peakSize, status}`.
- **Hiệu năng**: `BinanceOrderflow` cache các mẫu đã parse trong bộ nhớ, mỗi lần chỉ đọc mẫu mới từ SQLite (giống cache nến), không parse lại 24 giờ mỗi 15 giây.
- **API**: `GET /api/orderflow/:symbol/levels` thêm `wallSegments[]` (giá đã quy đổi `price = sourcePrice − basis`, basis hiện tại).
- **Web**: `OrderflowLineItem` thêm `t1` và `t2` (null = tới mép phải), `endMark`. Primitive vẽ đoạn theo trục thời gian (dùng time mapper hiện có, đầu đoạn trước nến đầu tiên thì kẹp về mép trái). Chart BTC dùng `wallSegments` thay cho danh sách tường hiện tại; POC giữ vạch ngang toàn chart.
- SPEC/README cập nhật.

## Implementation Steps
1. `findWallSegments` + test (tường đứng rồi bị quét, bị rút, đang tồn tại, nhiễu hụt 1 mẫu, ngắn hơn 5 phút).
2. Cache mẫu + API trả `wallSegments`, test.
3. Model + primitive vẽ đoạn, dấu ×, test model.
4. typecheck, lint, test; chụp chart BTC 5m và 1H; đối chiếu một tường bị quét với ảnh Bookmap cùng lúc.

## Tests / Acceptance
- Tường mua 58 BTC ở 73000 bị giá quét → trên chart còn đoạn từ lúc xuất hiện tới nến quét, có dấu ×.
- Tường biến mất khi giá chưa chạm → không vẽ.
- Tường đang tồn tại kéo tới mép phải như hiện nay.
- Poll 15 giây không parse lại toàn bộ 24 giờ mẫu.

## Ghi chú triển khai (2026-11-12)
- Điểm cuối tường bị quét không sớm hơn lần cuối còn thấy tường (nến 1m chạm có thể mở trước đó vài giây).
- Dữ liệu thật sau ~67 phút ghi: 53 đoạn (16 đang tồn tại, 12 bị quét, 25 bị rút). Lần gọi đầu ~0,65s (tải nến 24h), các lần sau ~12ms.
- Nhãn cuối đoạn gần nhau tự giãn dọc.

## Đã chốt (2026-11-12)
- Tường bị rút: vẽ nét chấm mờ ("vẫn vẽ nét mờ để biết hiện tượng").
- Ngưỡng tường tối thiểu BTC 8, cấu hình được ("ổn và cần config được").

## Approval Status
Đã duyệt (2026-11-12) qua câu trả lời cho các câu hỏi mở.
