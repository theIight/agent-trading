# Order flow Binance: giữ nguyên giá spot (bỏ quy đổi basis)

## Bối cảnh
Basis spot − futures đo ở mỗi lần poll lệch pha thời gian (đo được 10–45$ trong 1 phút, basis thật ~31–33$) làm mọi vạch order flow nhảy lên xuống, kể cả tường đã bị quét.

## Quyết định (người dùng, 2026-11-12)
"giữ nguyên giá của số lệnh orderflow, không cần điều chỉnh chênh lệch giá spot fut" → **bỏ hẳn quy đổi**: mọi mức order flow Binance (tường, lịch sử tường, POC/HVN/LVN, hấp thụ, lệnh lớn) dùng đúng giá trên sổ lệnh / nến Binance spot.

## Spec
1. `price = sourcePrice` (giá spot). Không còn basis; bỏ ghi chú "dùng basis 0".
2. Vạch trên chart vẽ tại giá spot, đứng yên giữa các lần poll. Chart là giá futures nên vạch có thể lệch vài chục $ so với nến — chấp nhận.
3. Agent: `get_orderflow` ghi rõ giá là **Binance spot, chưa quy đổi**; chart/nến dùng giá futures (kèm giá spot và giá chart lúc lấy để agent biết chênh lệch); entry/SL/TP vẫn lấy từ `get_klines`. Prompt cập nhật tương ứng.
4. Panel kết quả: thay "basis spot − chart" bằng "giá Binance spot (chưa quy đổi)".

## Tests / Acceptance
- Tường giữ nguyên giá qua các lần poll; `price === sourcePrice` cho mọi mức.
- typecheck, lint, test xanh; ảnh chart BTC.

## Approval Status
Đã duyệt (2026-11-12): chỉ thị trực tiếp của người dùng.
