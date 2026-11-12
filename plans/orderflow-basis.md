# Order flow Binance: quy đổi spot → chart bằng basis ổn định (trung vị 60 phút)

## Bối cảnh
- Bản đầu: basis đo ở mỗi lần poll, lệch pha thời gian (10–45$ trong 1 phút) → vạch nhảy.
- Bản 2 (2026-11-12, commit 370cc83): bỏ quy đổi, giữ giá spot → vạch đứng yên nhưng lệch ~33$ so với nến futures.
- Đo 1.000 phút (≈ 16 giờ): spot − futures trung vị 32,9$; trung vị từng giờ 28–37$; từng phút lệch quanh trung vị giờ p50 2,3$, p95 7$.

## Quyết định (người dùng, 2026-11-12)
Lúc đầu duyệt "cố định chênh lệch", sau đó gửi lại mô tả phương án 2 ("Tự tính nhưng ổn định…") → làm **phương án 2**; offset cố định trong config chỉ còn là **giá trị dự phòng**.

## Spec
1. Basis tại phút `t` = **trung vị** của `close spot − close futures` cùng phút trên 60 nến 1m đã đóng tới `t` (cần ≥ 10 cặp). Basis hiện tại tính tại nến đã đóng gần nhất → chỉ đổi khi có nến đóng mới, vạch đứng yên giữa các phút.
2. `price = sourcePrice − basis`:
   - tường đang tồn tại, POC/HVN/LVN, hấp thụ, lệnh lớn: basis hiện tại;
   - tường đã kết thúc (bị quét / bị rút): basis tại phút kết thúc → cố định mãi, nằm đúng chỗ giá futures chạm lúc ấy.
3. Thiếu dữ liệu (chưa đủ 10 cặp, lỗi tải nến futures) → dùng `ORDERFLOW_OFFSET_<SYMBOL>` (mặc định BTCUSDT 33) kèm ghi chú.
4. Nến 1m futures 24h lấy qua `KlineService` (closedOnly), cache theo phút: chỉ tải lại khi có nến đóng mới.
5. Agent: `get_orderflow` ghi giá đã quy đổi về giá chart bằng basis X (trung vị 60 phút). Panel: "quy đổi bằng basis X".

## Tests / Acceptance
- Basis không đổi giữa các lần poll trong cùng phút; tường đã kết thúc giữ nguyên giá qua các phút.
- Basis gần bookTicker spot − futures (lệch < 5$).
- Thiếu dữ liệu → offset dự phòng + ghi chú.
- typecheck, lint, test; ảnh chart BTC.

## Approval Status
Đã duyệt (2026-11-12): phương án 2.
