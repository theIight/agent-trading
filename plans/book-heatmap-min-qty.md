# Heatmap sổ lệnh: ngưỡng khối lượng tối thiểu hiển thị

## Bối cảnh
Heatmap sổ lệnh vẽ quá nhiều ô (lệnh nhỏ), khó nhìn. Hiện chỉ có `bookHeatHidePct` (ẩn ô dưới phân vị 0–50% trong vùng đang nhìn) — là ngưỡng tương đối, đổi theo vùng zoom, không cho đặt "chỉ hiện lệnh ≥ X BTC". Cần thêm ngưỡng **khối lượng tuyệt đối** chỉnh được trong ⚙.

## Requirements / Spec
1. Cài đặt mới trong ⚙ (mục heatmap sổ lệnh): **"Heatmap sổ lệnh: chỉ hiện ô ≥ [ số ] <đơn vị>"**, theo **từng symbol** (BTC tính bằng BTC, vàng bằng oz, ETH bằng ETH… — cùng đơn vị khối lượng của sổ lệnh nguồn). `0` / để trống = tắt.
   - Ô hiển thị khi `qty ≥ max(ngưỡng tuyệt đối, ngưỡng phân vị hiện có)`; hai cài đặt dùng chung được.
   - Bên cạnh ô nhập hiện gợi ý theo vùng đang nhìn: `trung vị · p90 · p99` khối lượng ô (để biết nên nhập bao nhiêu).
2. Thang màu (độ sáng) tính trên **các ô còn hiển thị** (≥ ngưỡng) → lọc bớt lệnh nhỏ vẫn giữ tương phản giữa mức dày/mỏng.
3. Mở rộng `bookHeatHidePct` tối đa từ 50% lên **95%** (bước 5) — cách lọc nhanh không cần biết đơn vị.
4. Lưu localStorage cùng cài đặt hiển thị (`wca:display`), dạng `bookHeatMinQty: { [symbol]: number }`; giá trị sai / âm → bỏ. Chế độ snapshot (ảnh Telegram) không dùng (localStorage trống → mặc định tắt).
5. Chỉ đổi web (hiển thị). Không đổi server, API, contract agent, dữ liệu agent nhận (tường / snapshot order flow giữ nguyên).

## Technical Design
- `displaySettings.ts`: thêm `bookHeatMinQty: Record<string, number>` vào `DisplaySettings`, mặc định `{}`; `sanitizeDisplay` lọc key symbol `^[A-Z0-9]{2,30}$`, giá trị hữu hạn > 0; `bookHeatHidePct.max = 95`.
- `bookHeatmapModel.ts`: `heatScale(h, hidePct, view, minQty = 0)` — bỏ ô `< minQty` trước khi tính phân vị; `min = max(minQty, phân vị hidePct)`; thêm `heatStats(h, view)` → `{ p50, p90, p99 }` (pure) cho gợi ý.
- `BookHeatmapPrimitive.ts`: đọc `display().bookHeatMinQty[symbol]`, đưa vào khoá cache scale.
- `SettingsButton.tsx`: ô nhập số + đơn vị (`bookmapSizeUnit`/đơn vị base của symbol) + dòng gợi ý; chỉ hiện khi symbol hiện tại có heatmap sổ lệnh.

## Implementation Steps
1. `displaySettings` + test sanitize.
2. `heatScale` minQty + `heatStats` + test (`tests/bookHeatmapModel.test.ts`).
3. Primitive + Settings UI.
4. `npm run typecheck`, `npm run lint`, `npm test`; ảnh BTC trước / sau khi đặt ngưỡng bằng `scripts/screenshot.ts`; build web + restart `wca-web` khi bạn đồng ý.

## Tests / Acceptance
- Unit: ô < minQty bị ẩn; min = max(tuyệt đối, phân vị); thang màu chỉ tính ô còn lại; sanitize bỏ giá trị sai; hidePct kẹp 0–95.
- Thủ công: BTC đặt "≥ 5" → chỉ còn các dải ≥ 5 BTC, đổi sang XAUUSD giữ ngưỡng riêng của vàng.

## Approval Status
Đã duyệt (2026-11-14, "hãy xử lý 4 plan đấy"). Nhánh `feat/alerts-orderflow-layout`.
