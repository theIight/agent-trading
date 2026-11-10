# Plan — Bố trí setup trên chart không đè nhau

## Approval Status

- [x] Đã duyệt (2026-11-11)

## 1. Requirements / Spec

**Hiện trạng.** Mỗi setup được vẽ thành một công cụ Long/Short từ `asOf` tới `validUntil`, hoặc rộng 25 nến nếu không có `validUntil`. Khi có 2 setup, cả hai dùng **cùng khoảng thời gian**, nên:
- Hộp TP/SL/entry chồng lên nhau.
- Nếu 2 setup có cùng TP xa nhất, nhãn `Chờ … · SHORT · R:R … · TP x` in đè đúng một chỗ.
  - Ví dụ thật: NEAR 5m, 10-11, cả hai setup có TP 3.12.
- Nhãn đường (TP1/TP2, `SL 1m ≈`) của 2 setup chồng nhau khi cùng giá hoặc giá sát nhau.
- Khung lớn (4H/1D): `validUntil` chỉ cách vài nến, nên hộp rộng 1–2 nến và nhãn dồn thành cụm.

**Yêu cầu.**
1. Khi vẽ ≥ 2 setup, mỗi setup nằm trong **một cột thời gian riêng**, đặt cạnh nhau theo thứ tự trong `setups[]` (setup chính bên trái). Giữa các cột có khoảng hở nhỏ.
2. Mỗi cột rộng **tối thiểu 12 nến** của khung đang xem, để nhãn đọc được ở mọi khung.
3. Nhãn trên canvas (của hộp và đường) **không đè nhau**: nếu trùng vị trí thì dịch nhãn sau xuống hoặc lên cho tới khi hết chồng.
4. Không đổi:
   - Khi chọn 1 setup (bấm thẻ ở panel): chỉ vẽ setup đó, độ rộng như hiện tại nhưng vẫn áp dụng độ rộng tối thiểu.
   - 1 setup duy nhất: điểm bắt đầu và kết thúc như hiện tại, chỉ áp dụng độ rộng tối thiểu.
   - Contract, validator, prompt.

## 2. Technical Design

- `apps/web/src/overlays/model.ts`, nhánh `layers.action`:
  - `span = max(t2 − t1, MIN_TOOL_BARS × curSec)`, với `MIN_TOOL_BARS = 12`.
  - Với N tool (N ≥ 2): tổng khoảng `[t1, t1 + max(span, N × MIN_TOOL_BARS × curSec)]` được chia thành N cột bằng nhau. Mỗi cột chừa 1 nến làm khoảng hở. Tool i có `t1_i`, `t2_i` theo cột đó.
  - `futureBars` tính theo `t2` lớn nhất (đã có sẵn).
- `apps/web/src/overlays/OverlayPrimitive.ts`:
  - Gom các nhãn thành danh sách `{text, x, y, align, color}`.
  - Khi vẽ, giữ danh sách hộp chữ đã vẽ (đo bằng `measureText`, cao khoảng 12px). Nếu nhãn mới giao với hộp đã có thì dịch `y` thêm ±12px (thử xuống trước, rồi lên), tối đa 4 lần.
  - Chỉ áp dụng cho nhãn do overlay vẽ. Nhãn price line của lightweight-charts không thuộc phạm vi này.
- Giữ bản sửa `xOf` nội suy logical lẻ (đã làm).
- `SPEC.md` mục Setup (dòng 149): bổ sung "nhiều setup vẽ thành các cột cạnh nhau, mỗi cột ≥ 12 nến; nhãn tự giãn để không đè".

## 3. Implementation Steps

1. Thêm `MIN_TOOL_BARS` và logic chia cột trong `buildOverlayModel`.
2. Test cho model trong `tests/overlayModel.test.ts`.
3. Tránh va chạm nhãn trong `OverlayPrimitive`. Tách hàm thuần `layoutLabels(boxes)` vào `model.ts` để test được.
4. Cập nhật `SPEC.md`.
5. Kiểm chứng: `npm run typecheck`, `npm run lint`, `npm test`. Chụp ảnh NEAR 5m, BTC 4H và 1D, XAUUSD 5m bằng `scripts/screenshot.ts` hoặc script chụp có mở lịch sử.

## 4. Tests / Acceptance

- 2 setup → khoảng `[t1, t2]` của 2 tool **không giao nhau**, setup 0 nằm bên trái.
- Mỗi tool rộng ≥ 12 nến của khung hiện tại (thử với khung 1D, `validUntil` chỉ cách 1 ngày).
- Chọn 1 setup → chỉ 1 tool, bắt đầu tại `asOf`.
- 1 setup với `validUntil` xa → `t2 = validUntil`, giữ như cũ.
- `layoutLabels`: 2 nhãn cùng vị trí → sau khi bố trí, hộp chữ không giao nhau.
- Ảnh chụp NEAR 5m: không còn nhãn đè. BTC 1D: đọc được Entry/SL/TP của cả 2 setup.
