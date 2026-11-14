# Màu order flow kiểu Bookmap + chỉnh độ dày

## Bối cảnh
- Tường order flow hiện vẽ bằng dải mờ: bid màu xanh ngọc `rgba(38,166,154,0.3)` (trùng màu nến tăng `#26a69a`), ask màu đỏ `rgba(239,83,80,0.3)` (trùng nến giảm).
- Độ dày đi từ 1 đến 6px theo khối lượng (`OF_MIN_WIDTH`/`OF_MAX_WIDTH` trong `apps/web/src/overlays/model.ts`).
- Chart đã có nhiều màu xanh (nến tăng, support, TP…), nên tường bid rất khó nhìn.

## Requirements / Spec
1. **Màu kiểu heatmap Bookmap**: màu theo **độ lớn** của tường, không theo phía.
   - Thang màu (tỉ lệ so với tường lớn nhất đang vẽ): vàng nhạt `#ffd54f` → cam `#ff9800` → đỏ cam `#ff5722` → trắng nóng `#fff3e0` cho tường lớn nhất.
   - Chart chỉ vẽ tường ≥ 40% tường lớn nhất, nên chỉ dùng phần nóng của thang. Không dùng xanh/lam để khỏi lẫn với nến.
   - Phân biệt phía bằng vị trí như Bookmap (dưới giá là bid, trên giá là ask). Nhãn số giữ màu chữ theo thang, thêm chữ cái `B`/`A` trước số (ví dụ `B 521`).
   - Tường bị rút (nét chấm) dùng xám `rgba(180,180,180,0.4)`. Tường bị quét giữ dấu ×. POC giữ tím nét chấm.
2. **Cài đặt (nút ⚙)**, lưu localStorage như các cài đặt khác:
   - `Màu order flow`: `Bookmap` (mặc định) hoặc `Theo phía (cũ)`, tức xanh/đỏ như hiện tại.
   - `Độ dày order flow`: hệ số 0.5–3×, bước 0.25, **mặc định 1.5×**, tức tường lớn nhất 9px thay vì 6px. Độ dày tối thiểu 1px giữ nguyên.
   - `Độ đậm order flow`: hệ số 0.3–1.5×, bước 0.1, mặc định 1×. Alpha gốc của dải là 0.45 với Bookmap, 0.3 với theo phía.
   - Đổi cài đặt thì chart vẽ lại ngay, không cần tải lại dữ liệu.
3. Áp dụng cho cả hai nguồn: tường Binance live (lịch sử tường) và tường từ ảnh Bookmap trong kết quả phân tích.

4. **Tự chọn thang màu (bổ sung 2026-11-13)**: trong ⚙ có 4 ô chọn màu (`<input type="color">`) cho 4 mốc **40% / 60% / 80% / 100%** của thang Bookmap, kèm nút "Màu mặc định" chỉ đặt lại thang màu.
   - Lưu trong `wca:chartSettings` ở trường `ofHeatStops: [string, string, string, string]` (hex `#rrggbb`). `null` = dùng thang mặc định theo theme (tối: vàng → cam → đỏ cam → trắng nóng; sáng: vàng → cam → đỏ → đỏ đậm).
   - Đã tự chọn thì áp cho **cả hai theme**.
   - `sanitizeDisplay`: phải đủ 4 mã hex hợp lệ, sai thì về `null`.
   - Ô chọn màu chỉ hiện khi đang ở chế độ màu `Bookmap`.

Ngoài phạm vi: heatmap toàn bộ sổ lệnh (mọi mức), agent/server/contract.

## Technical Design
> Điều chỉnh sau khi chụp ảnh: với alpha 0.45 cố định, tường lớn nhất (trắng nóng) trông xám đục, nên độ đậm chế độ Bookmap đổi thành `0.45 × (0.5 + ratio) × ofOpacity`. Nhãn order flow có viền tối/sáng theo nền để đọc được khi đè lên dải. Theme sáng dùng thang vàng → đỏ đậm `#8e0000` (trắng nóng không thấy trên nền trắng).

- `overlays/model.ts`: `OrderflowLineItem` thêm `side?: 'BID' | 'ASK'`, `ratio?: number` (0–1, so với tường lớn nhất đang vẽ) và `kind?: 'wall' | 'pulled' | 'poc'`. Model **không** chốt màu/độ dày cuối cho tường nữa: giữ `color`/`width` mặc định để tương thích, renderer tính lại.
- Hàm thuần mới `apps/web/src/overlays/orderflowStyle.ts`:
  - `heatColor(ratio, alpha)`: nội suy thang màu Bookmap.
  - `wallStyle(item, settings)` trả `{ fill, text, width, label }` theo `ofColorMode`, `ofWidthX`, `ofOpacity`.
- `OverlayPrimitive.ts`: khi vẽ order flow, gọi `wallStyle(of, display())`.
- `chart/displaySettings.ts`: thêm `ofColorMode: 'bookmap' | 'side'`, `ofWidthX`, `ofOpacity` vào `DisplaySettings`, `DEFAULT_DISPLAY`, `DISPLAY_RANGES` (2 thanh trượt) và `sanitizeDisplay` (mode sai thì về `bookmap`).
- `components/SettingsButton.tsx`: thêm ô chọn `Màu order flow` (select 2 lựa chọn); 4 ô chọn màu thang + nút "Màu mặc định" (mục 4).
- `orderflowStyle.ts`: `heatColor(ratio, alpha, light, stops?)`: `stops` (4 hex) thay cho thang mặc định khi có.

## Implementation Steps
1. `orderflowStyle.ts` + test trong `tests/overlayModel.test.ts` (hoặc file mới `tests/orderflowStyle.test.ts`).
2. Model: thêm `side/ratio/kind`, giữ nguyên các test cũ về giá/nhãn/khoảng thời gian.
3. Settings: kiểu, mặc định, chuẩn hoá, UI.
4. Renderer dùng `wallStyle`.
5. Cập nhật SPEC (phần hiển thị order flow / cài đặt hiển thị).
6. Kiểm chứng: `npm run typecheck`, `npm run lint`, `npm test`, chụp ảnh bằng `scripts/screenshot.ts` cả 2 chế độ màu, build lại web rồi restart `wca-web`.

## Tests / Acceptance
- `heatColor(0.4)` ra vàng, `heatColor(1)` gần trắng nóng, nội suy đơn điệu. Ratio ngoài [0, 1] thì bị kẹp.
- Chế độ `bookmap`: bid và ask cùng ratio thì cùng màu. Nhãn có tiền tố `B`/`A`.
- Chế độ `side`: màu và nhãn giống hệt hiện tại.
- `ofWidthX = 1.5`: tường lớn nhất 9px, tường nhỏ nhất ≥ 1px.
- `sanitizeDisplay` với giá trị cũ không có trường mới → mặc định. `ofColorMode: 'xyz'` → `bookmap`.
- `heatColor` với thang tự chọn: mốc 100% ra đúng màu đã chọn, nội suy giữa các mốc. `sanitizeDisplay` với `ofHeatStops` thiếu phần tử / sai hex → `null`.
- Ảnh chụp: tường nổi rõ trên nền nến, không lẫn với nến tăng.

## Approval Status
Mục 1–3 đã duyệt (2026-11-13), đã làm xong, chưa commit. Mục 4 đã duyệt (2026-11-13).
