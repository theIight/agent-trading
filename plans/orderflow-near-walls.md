# Order flow live: chỉ xét tường gần giá khi chọn tường để vẽ

## Bối cảnh
Chart vẽ tường order flow live (`buildWallSegmentLines`) theo luật: tường còn tồn tại ≥ 40% **tường lớn nhất đang tồn tại**, tối đa 3 mỗi phía; tường đã quét / bị rút ≥ 40% tường lớn nhất trong 24h. Ngưỡng tính trên **toàn bộ sổ lệnh**.

Hiện tại (14/11/2026) BTC có tường BID **1.033 BTC ở 59.970**, cách giá ~5.400$ (~8%). Ngưỡng thành ~413 BTC, nên các tường gần giá (BID 64.970 × 333, ASK 66.670 × 198…) bị loại. Chỉ còn tường 60k được vẽ, mà mức đó nằm ngoài màn hình, nên chart trông như mất order flow (chỉ còn POC). Kiểm tra bằng `buildWallSegmentLines` trên dữ liệu `/api/orderflow/BTCUSDT/levels` thật: ra đúng 1 tường, BID@59970.

## Requirements / Spec
1. Order flow **live** (`liveLines`): chỉ xét tường có giá trong **±`OF_WALL_RANGE_PCT` (3%) quanh giá tham chiếu**. Giá tham chiếu = close nến cuối của chart đang xem. Tường ngoài khoảng không được vẽ và không tham gia tính "tường lớn nhất".
2. Các luật còn lại giữ nguyên, nhưng áp trên tập đã lọc: ≥ 40% tường lớn nhất, ≤ 3 mỗi phía (đang tồn tại); ≤ 6 gần nhất (đã quét / bị rút); độ dày và màu Bookmap theo tỷ lệ so với tường lớn nhất **được vẽ**.
3. Áp cho mọi symbol có order flow live (BTC, vàng, 8 top coin); với vàng ±3% ≈ ±115$, rộng hơn vùng sổ futures phủ (±17), nên gần như không đổi. Lỗi chỉ gặp ở BTC.
4. Không đổi: nhánh dự phòng `buildOrderflowLines(levels)` khi không có `wallSegments`, order flow của kết quả phân tích đã lưu, ảnh snapshot Telegram, server, API, dữ liệu agent nhận (snapshot order flow vẫn ≤ 12 mức như cũ), POC.
5. Không có giá tham chiếu (chưa có nến) → không lọc, giữ hành vi cũ.

## Technical Design
- `apps/web/src/overlays/model.ts`:
  - `export const OF_WALL_RANGE_PCT = 3;`
  - `buildWallSegmentLines(segments, refPrice?: number)`: có `refPrice` hữu hạn > 0 → lọc `|price − refPrice| ≤ refPrice × OF_WALL_RANGE_PCT / 100` trước mọi bước khác.
  - `liveLines(live, refPrice)`; `buildOverlayModel` truyền `candles.at(-1).close` ở cả hai chỗ gọi (có và chưa có phân tích).
- `SPEC.md` mục Order flow trên chart (bảng hiển thị): thêm "chỉ xét tường trong ±3% quanh giá close cuối".

## Implementation Steps
1. Sửa `buildWallSegmentLines` + `liveLines` + chỗ gọi.
2. Test trong `tests/overlayModel.test.ts`: tường xa lớn không còn đè ngưỡng; tường ngoài ±3% bị bỏ; không có refPrice → như cũ.
3. Cập nhật SPEC.md.
4. `npm run typecheck`, `npm run lint`, `npm test`; chụp BTC 15m (heatmap + order flow bật) bằng Playwright để thấy lại tường gần giá; build web + restart `wca-web`.

## Tests / Acceptance
- Unit: segments `[BID 59970 × 1033 active, BID 64970 × 333 active, ASK 66670 × 198 active]`, refPrice 65400 → vẽ 64970 và 66670, không vẽ 59970; không truyền refPrice → chỉ 59970 (hành vi cũ).
- Ảnh: BTC hiện lại dải tường + nhãn `B …` / `A …` ở mép phải quanh giá.

## Approval Status
Đã duyệt (2026-11-14, "ok"). Nhánh `feat/alerts-orderflow-layout`.
