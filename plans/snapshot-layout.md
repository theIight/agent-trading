# Bố cục ảnh chụp: nến 60% bên trái, setup bên phải

## Bối cảnh
Ảnh khung chính gửi Telegram chỉ thấy setup, không thấy nến. Ví dụ phân tích BTCUSDT 1m `c4fcccd2…`: ảnh toàn vùng tương lai, nến bị đẩy ra khỏi mép trái.

Nguyên nhân (`OverlayManager.render`): `rightOffset = max(12, model.futureBars + 6)`, với `futureBars` lấy theo thời điểm xa nhất của overlay — `setup.validUntil` (6 giờ = 360 nến 1m) và điểm cuối đường dự đoán. Chart giữ độ rộng nến mặc định nên khoảng trống tương lai 366 nến chiếm hết khung nhìn.

## Requirements / Spec
1. **Ảnh chụp (chế độ `?snapshot=`), mọi khung**: nến chiếm **60% bên trái** độ rộng vùng vẽ, **40% bên phải** là vùng tương lai.
   - Số nến hiển thị trong 60%: `SNAPSHOT_BARS` = 120 (đủ thấy cấu trúc gần, nến không quá nhỏ ở 1600 px).
   - Nến cuối nằm ở mốc 60%.
2. **Setup (position tool) chiếm 50% bên phải**: hộp Entry/SL/TP bắt đầu ở mốc 50% và kéo tới mép phải (phủ lên ~10% nến gần nhất để nối với giá hiện tại). Nhãn Entry/SL/TP nằm trong vùng này. Đường dự đoán / setup kéo xa hơn mép phải thì bị cắt ở mép phải (không kéo giãn khung nhìn).
3. Thang giá tự co theo nến **và** các mức của setup đang vẽ (SL/TP/Entry) — không bị đường dự đoán ở xa kéo giãn.
4. **Web**: không đổi bố cục đặt cố định; chỉ giới hạn `rightOffset` ≤ 40% số nến đang nhìn thấy để mở một phân tích có `validUntil` xa không còn đẩy nến ra khỏi màn hình (người dùng vẫn cuộn/zoom tự do).
5. Không đổi server, contract agent, dữ liệu phân tích.

## Technical Design
- `apps/web/src/snapshotMode.ts` (pure): `snapshotRange(lastIndex, bars = 120, candleFrac = 0.6)` → `{ from, to }` logical range; `toolStartIndex(range, frac = 0.5)` → chỉ số nến tại mốc 50%.
- `overlays/model.ts`: option `toolStartTime?: number` — có thì `t1` của position tool = `max(snapToBar(asOf), toolStartTime)` → hộp bắt đầu từ mốc 50%; nếu `asOf` đã nằm bên phải mốc 50% thì giữ `asOf`.
- `OverlayManager`: option `fixedRange` (snapshot) → bỏ qua tính `rightOffset` theo `futureBars`; web: `rightOffset = min(max(12, futureBars + 6), 0.4 × số nến đang nhìn)`.
- `SnapshotApp`: khi nến đã tải → `setVisibleLogicalRange(snapshotRange(...))`, truyền `toolStartTime` cho overlay, chờ 2 frame rồi `data-snapshot=ready` (như cũ).
- Autoscale thang giá: primitive overlay chỉ báo `autoscaleInfo` cho các mức nằm trong vùng thời gian nhìn thấy (đường dự đoán ngoài khung không tính).

## Implementation Steps
1. `snapshotRange`, `toolStartIndex` + test; option `toolStartTime` trong model + test.
2. OverlayManager (snapshot cố định / web giới hạn rightOffset), SnapshotApp.
3. `npm run typecheck`, `npm run lint`, `npm test`; chụp lại phân tích `c4fcccd2…` (1m) và một phân tích 4h — so sánh trước / sau; ảnh web mở phân tích đó bằng `scripts/screenshot.ts`.
4. Build web + restart `wca-web` khi bạn đồng ý.

## Tests / Acceptance
- Unit: range đặt nến cuối ở 60%, 120 nến; t1 của tool = mốc 50% (hoặc asOf nếu muộn hơn); web rightOffset bị giới hạn.
- Ảnh: khung chính thấy rõ nến 60% bên trái, hộp setup ở nửa phải; khung lớn (không có setup) thấy nến 60% + đường dự đoán ở 40% phải.

## Approval Status
Đã duyệt (2026-11-14, "hãy xử lý 4 plan đấy"). Nhánh `feat/alerts-orderflow-layout`.

## Ghi chú triển khai
- `snapshotMode.ts`: `snapshotRange(lastIndex)` → `{from: last + 0.5 − 120, to: from + 200}`; `toolStartIndex` → nến có mép trái tại mốc 50% (= `last − 19`).
- `model.ts`: option `toolStartTime` (t1 = max(asOf, mốc 50%)) và thêm `toolEndTime` (t2 = mép phải thay cho `validUntil`, để nhiều setup chia cột trong nửa phải thay vì cột thứ 2 nằm ngoài khung) — lệch nhỏ so với thiết kế (plan chỉ nêu `toolStartTime`). `webRightOffset(futureBars, visibleBars)` = min(max(12, futureBars + 6), 40% số nến đang nhìn). `overlayPriceRange` (dùng trong `OverlayPrimitive.autoscaleInfo`): hộp tính khi giao khung nhìn (trước đây chỉ khi một đầu nằm trong khung), điểm đường chỉ tính khi trong khung.
- `OverlayManager({ snapshot })`: snapshot → tính mốc tool + `setVisibleLogicalRange(snapshotRange)` mỗi lần render; web → `webRightOffset`. `SnapshotApp` đặt lại khung nhìn sau `scrollToRealTime` của lần tải rồi mới `ready`.
- Lưu ý: `asOf` của phân tích mới ≈ nến đã đóng gần nhất, nên ảnh gửi ngay khi phân tích xong sẽ có hộp setup bắt đầu ở ~mốc 60% (giữ `asOf` theo spec); chỉ khi chụp muộn (asOf trôi về trái) hộp mới bắt đầu đúng mốc 50%.
- Trước / sau (phân tích `c4fcccd2…`, BTCUSDT 1m, setup `validUntil` +6h):
  - Trước (web 5173): ảnh 1m toàn vùng tương lai, không thấy nến (chỉ một mẩu nến ở mép trái), thang giá bị đường dự đoán kéo tới 67.8k–64.4k; web mở phân tích cũng không thấy nến. Ảnh 4h/1h/1d vốn thấy nến (setup ẩn ở khung lớn), nến kín tới mép phải.
  - Sau (vite 5175): ảnh 1m thấy 120 nến 1m ở 60% trái, hộp 2 setup ở nửa phải (cột 1 từ mốc 50%, cột 2 tới mép phải), đường dự đoán bị cắt ở mép phải; 1h/4h/1d: nến 60% trái + dự đoán ở 40% phải. Web mở phân tích: nến hiện rõ, khoảng trống tương lai ≤ 40% khung.
