# Heatmap sổ lệnh: nhãn khối lượng tại điểm bắt đầu dải thanh khoản

## Bối cảnh
Heatmap sổ lệnh chỉ thể hiện độ dày bằng màu, không đọc được số. Nhãn order flow (khối lượng tường) nằm ở **mép phải** (tường còn tồn tại) hoặc **cuối đoạn** (tường đã kết thúc). Người dùng muốn ghi số lượng ở **điểm bắt đầu của mỗi dải thanh khoản** trên heatmap, để không đè lên số của order flow (vốn ở cuối), và dùng **cùng cỡ chữ** với nhãn order flow.

## Requirements / Spec
1. **Dải thanh khoản** = chuỗi cột liên tiếp mà cùng một bucket nguồn `ix` có ô **đang hiển thị** (≥ ngưỡng ẩn hiện có: `bookHeatHidePct` / `bookHeatMinQty`). Cho phép hụt **1 cột** giữa chuỗi (giống tường cho phép hụt 1 mẫu). Dải phải kéo dài ≥ 5 phút (`≥ ceil(300 / colSec)` cột, tối thiểu 1) để bỏ lệnh chớp nhoáng.
2. Nhãn đặt ở **điểm bắt đầu** dải: x = mép trái cột đầu tiên + 3px, căn trái; y = tâm bucket theo giá chart tại cột đó (`ix × bucket − shift[cột đầu] + bucket/2`). Dải bắt đầu trước vùng đang nhìn → nhãn ghim ở mép trái chart (x = 4) để dải đang kéo dài vẫn có số.
3. Số = **khối lượng đỉnh** của dải (ô lớn nhất trong chuỗi, giống `peakSize` của tường), là khối lượng lệnh chờ trung bình bid + ask, đơn vị `BookHeatmap.unit` (BTC, ETH, oz…). Định dạng `fmtSize` (rút gọn K/M khi ≥ 10 000) giống nhãn tường.
4. **Cỡ chữ = nhãn order flow**: dùng chung `ofFont()` (`display().ofFontPx`) như nhãn tường trong `OverlayPrimitive`, đổi cỡ chữ order flow trong ⚙ thì nhãn heatmap đổi theo. Màu chữ = màu heatmap của ô đỉnh với alpha = 1, viền halo giống nhãn order flow.
5. Chỉ xét dải có điểm nằm trong vùng đang nhìn (cột và giá). Lấy tối đa **N dải có đỉnh lớn nhất**; chống đè: duyệt theo đỉnh giảm dần, bỏ nhãn có khung chữ chồng lên nhãn đã đặt (bỏ chứ không dịch, để số luôn đúng giá).
6. Cài đặt ⚙ mới: **"Heatmap sổ lệnh: số nhãn khối lượng"**, thanh trượt 0–30, bước 1, mặc định **12**; 0 = tắt. Lưu chung `wca:chartSettings`. Ảnh snapshot Telegram dùng mặc định.
7. Chỉ đổi web. Không đổi server, API, contract agent hay dữ liệu agent nhận.

## Technical Design
- `bookHeatmapModel.ts` (pure):
  - `heatBands(h, {c0, c1, low, high}, min, maxGap = 1, minCols)` → `{ix, start, end, peak, peakCol, price}[]` (`start`/`end` là chỉ số cột, `price` = tâm bucket tại cột `start`), sắp theo `peak` giảm dần. Quét các cột từ `max(0, c0 − ngưỡng nhìn lại)` để biết dải bắt đầu trước vùng nhìn; dải kết thúc trước `c0` hoặc nằm ngoài [low, high] bị bỏ.
  - `pickHeatLabels(items: {x, y, w, h}[], n)` → chọn tham lam tối đa n nhãn không chồng khung chữ.
- `displaySettings.ts`: thêm `bookHeatLabels: number` (0–30, mặc định 12) vào `DisplaySettings` + `NUM`.
- `BookHeatmapPrimitive.ts`: thêm `draw()` (lớp trên nến): dùng lại `vis`, `xs`, `scale` của lần vẽ nền (lưu trong renderer), cache kết quả `heatBands` theo cùng key với thang màu; đo chữ bằng `measureText`, chọn nhãn, vẽ `strokeText` halo + `fillText`.
- Nhãn order flow ở cuối đoạn / mép phải không đổi. Hiếm khi điểm bắt đầu dải heatmap trùng chỗ cuối một tường; chấp nhận, không xử lý chéo giữa hai primitive.
- `SPEC.md` mục heatmap sổ lệnh thêm 1 dòng về nhãn chart.

## Implementation Steps
1. `displaySettings` + test sanitize.
2. `heatBands` / `pickHeatLabels` + test (`tests/bookHeatmapModel.test.ts`).
3. Primitive vẽ nhãn + ⚙.
4. Cập nhật SPEC.md.
5. `npm run typecheck`, `npm run lint`, `npm test`; chụp ảnh BTC bằng `scripts/screenshot.ts` (heatmap bật, có tường order flow) để kiểm tra số nằm ở đầu dải, cỡ chữ bằng nhãn tường. Build web + restart `wca-web` khi bạn đồng ý.

## Tests / Acceptance
- Unit: chuỗi liên tục thành một dải; hụt 1 cột vẫn nối, hụt 2 cột thì tách; dải ngắn hơn minCols bị bỏ; ô < min không tính; `peak` đúng; dải bắt đầu trước c0 vẫn được giữ; ngoài [low, high] bị bỏ; pick bỏ nhãn chồng nhau, tối đa n, n = 0 → rỗng; sanitize kẹp 0–30.
- Ảnh: BTC có số ở đầu các dải sáng nhất, cùng cỡ chữ với nhãn tường; nhãn tường không đổi.

## Approval Status
Đã duyệt (2026-11-14, "ok" sau bản 2). Nhánh `feat/alerts-orderflow-layout`.
