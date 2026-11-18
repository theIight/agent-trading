# Rút gọn nhãn mức giá (Kháng cự, Hỗ trợ, Mục tiêu) trên màn hình nhỏ / điện thoại

## Requirements / Spec

1. **Vấn đề**:
   - Hiện tại, các đường mức giá Wyckoff (`analysis.levels`) được hiển thị bằng `PriceLine` với nhãn đầy đủ: `"Kháng cự"`, `"Hỗ trợ"`, `"Mục tiêu"`, `"Vô hiệu"`.
   - Trên điện thoại (màn hình hẹp ~375–430px), các chữ tiếng Việt dài 7–8 ký tự này chiếm tới 60–80px chiều ngang trên biểu đồ, che khuất nến và gây rối mắt khi có nhiều mức giá gần nhau.

2. **Giải pháp xử lý**:
   - Rút gọn nhãn mức giá thành các ký hiệu viết tắt ngắn gọn 2 ký tự chuẩn giao dịch (thân thuộc với trader Việt Nam):
     - `RESISTANCE` ("Kháng cự") → **`KC`**
     - `SUPPORT` ("Hỗ trợ") → **`HT`**
     - `TARGET` ("Mục tiêu") → **`TP`**
     - `INVALIDATION` ("Vô hiệu") → **`VH`**
     - `CREEK` → `Creek`
     - `ICE` → `Ice`
   - Chi tiết đầy đủ của mức giá (loại mức, ghi chú giải thích của agent, khung giờ) vẫn xem đầy đủ ở bảng phân tích.

3. **Cơ chế kích hoạt linh hoạt**:
   - **Tự động trên mobile**: Khi chiều rộng màn hình hoặc khung chart ≤ 768px (hoặc khi người dùng truy cập từ điện thoại), tự động kích hoạt chế độ nhãn ngắn `KC` / `HT` / `TP`.
   - **Tuỳ chọn trên desktop (⚙ Cài đặt hiển thị)**: Thêm tuỳ chọn `compactLevels: boolean` trong bảng cài đặt ⚙ (mặc định `false` trên desktop, lưu `localStorage`). Nếu người dùng trên máy tính muốn biểu đồ tối giản, gọn gàng cũng có thể bật tuỳ chọn này bất cứ lúc nào.

4. **Phạm vi tác động**:
   - Chỉ ở tầng hiển thị overlay UI web (`apps/web`), không đổi contract agent/server.
   - Cập nhật tài liệu `SPEC.md`.

## Technical Design

- **Định nghĩa nhãn rút gọn** (`apps/web/src/overlays/model.ts`):
  ```ts
  const LEVEL_LABELS: Record<string, string> = {
    SUPPORT: 'Hỗ trợ',
    RESISTANCE: 'Kháng cự',
    CREEK: 'Creek',
    ICE: 'Ice',
    INVALIDATION: 'Vô hiệu',
    TARGET: 'Mục tiêu',
  };

  const COMPACT_LEVEL_LABELS: Record<string, string> = {
    SUPPORT: 'HT',
    RESISTANCE: 'KC',
    CREEK: 'Creek',
    ICE: 'Ice',
    INVALIDATION: 'VH',
    TARGET: 'TP',
  };
  ```
  - Thêm trường `compactLevels?: boolean` vào `OverlayOptions`.
  - Trong vòng lặp tạo `priceLines`: chọn nhãn `COMPACT_LEVEL_LABELS` nếu `opts.compactLevels === true`, ngược lại dùng `LEVEL_LABELS`.

- **Cài đặt hiển thị** (`apps/web/src/chart/displaySettings.ts` & `apps/web/src/store/useChartSettingsStore.ts`):
  - Thêm `compactLevels: boolean` vào `DisplaySettings` (mặc định `false`, chuẩn hoá `sanitizeDisplay`).
  - Hàm helper `shouldCompactLevels(containerWidth: number): boolean` trả về `true` nếu `display().compactLevels` bật HOẶC `containerWidth <= 768` (hoặc `window.innerWidth <= 768`).

- **OverlayManager** (`apps/web/src/overlays/OverlayManager.ts`):
  - Khi gọi `buildOverlayModel`, truyền `compactLevels: shouldCompactLevels(...)` để biểu đồ tự động cập nhật nhãn khi đổi kích thước màn hình hoặc đổi cài đặt ⚙.

- **Bảng Cài đặt ⚙** (`apps/web/src/components/SettingsButton.tsx`):
  - Bổ sung checkbox: "Rút gọn nhãn mức giá (KC, HT, TP)".

- **SPEC.md**:
  - Cập nhật mục 9 (Hiển thị) ghi nhận cơ chế rút gọn nhãn mức giá trên điện thoại / màn hình nhỏ.

## Implementation Steps

1. Cập nhật `apps/web/src/chart/displaySettings.ts` (thêm `compactLevels`, helper xác định mobile/compact) và cập nhật `tests/displaySettings.test.ts`.
2. Cập nhật `apps/web/src/overlays/model.ts` hỗ trợ `compactLevels` trong `buildOverlayModel` và bổ sung unit test trong `tests/overlayModel.test.ts`.
3. Cập nhật `apps/web/src/overlays/OverlayManager.ts` truyền `compactLevels`.
4. Cập nhật `apps/web/src/components/SettingsButton.tsx` thêm toggle trong bảng cài đặt.
5. Đồng bộ tài liệu `SPEC.md`.
6. Kiểm chứng: `npm run typecheck`, `npm run lint`, `npm test`, build web và restart pm2; kiểm thử trực quan với Playwright (mô phỏng mobile viewport 375px và desktop).

## Tests / Acceptance

- **Unit test**:
  - `buildOverlayModel` với `compactLevels: true` tạo ra `priceLines` có nhãn `HT`, `KC`, `TP`, `VH`.
  - `buildOverlayModel` với `compactLevels: false` giữ nguyên `Hỗ trợ`, `Kháng cự`, `Mục tiêu`, `Vô hiệu`.
  - `sanitizeDisplay` chuẩn hoá đúng `compactLevels`.
- **Thủ công & Trực quan (Playwright)**:
  - Trên màn hình mobile (viewport width 375px): các đường mức giá hiển thị nhãn ngắn `HT`, `KC`, `TP`, tiết kiệm tối đa diện tích, không che nến.
  - Trên màn hình desktop: mặc định hiển thị nhãn đầy đủ; khi tích chọn "Rút gọn nhãn mức giá" trong ⚙ thì chuyển sang `KC`, `HT`, `TP`.

## Approval Status
Đã duyệt (2026-11-18, "ok").
