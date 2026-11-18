# Chế độ Logarithmic Scale (thang đo logarit trên chart)

## Requirements / Spec

1. **Chức năng**:
   - Cho phép người dùng chuyển đổi giữa thang đo giá tuyến tính (Linear / Normal, mặc định) và thang đo giá logarit (Logarithmic Scale).
   - Thang đo logarit giúp các bước nhảy phần trăm bằng nhau có khoảng cách chiều cao bằng nhau trên trục giá (đặc biệt hữu ích khi xem biểu đồ crypto khung lớn như BTC/ETH hoặc các đợt tăng/giảm mạnh).

2. **Vị trí nút bấm giống TradingView**:
   - Nút đặt ở góc dưới cùng bên phải của biểu đồ (`bottom-right`), ngay giao điểm giữa trục thời gian (time scale) và trục giá bên phải (right price scale).
   - Nhãn nút: `log` (hoặc `auto` / `log` giống cụm nút điều khiển thang đo ở góc TradingView).
   - Khi bật Log scale: nút `log` sáng màu xanh chủ đạo (`var(--accent)`), in đậm giống TradingView. Khi tắt: nút màu mờ (`var(--muted)`), rê chuột chuyển màu chữ thường (`var(--text)`).
   - Kèm nút `auto` bên cạnh (giống TradingView): click để đưa thang giá về chế độ tự động co giãn (`autoScale: true`), hữu ích khi người dùng kéo giãn trục giá thủ công.

3. **Lưu trạng thái (Persistence)**:
   - Lưu trạng thái `logScale: boolean` vào `localStorage` (`wca:chartSettings` thông qua `useChartSettingsStore` / `displaySettings.ts`).
   - Mặc định: `logScale: false` (Linear).
   - Tải lại trang hoặc chuyển tab vẫn giữ nguyên trạng thái người dùng đã chọn.

4. **Tương thích với các lớp vẽ (Overlays & Primitives)**:
   - Mọi primitive hiện tại (`OverlayPrimitive`, `LiquidationPrimitive`, `BookHeatmapPrimitive`, `CountdownPrimitive`, `SpikeLabelPrimitive`) đều gọi `series.priceToCoordinate(price)`.
   - Lightweight Charts tự động tính toán toạ độ Y theo `PriceScaleMode.Logarithmic`, đảm bảo các hình vẽ Wyckoff, order flow, thanh lý, đếm ngược nến đồng bộ chính xác.

5. **Phạm vi tác động**:
   - Chỉ ở tầng UI web (`apps/web`), không đổi contract agent/server (`@wca/shared`, `apps/server`, `apps/mcp`).
   - Cập nhật mục UI trong `SPEC.md`.

## Technical Design

- **Lightweight Charts API**:
  - Dùng enum `PriceScaleMode` từ thư viện `lightweight-charts` (`PriceScaleMode.Normal = 0`, `PriceScaleMode.Logarithmic = 1`).
  - Cập nhật chế độ trục giá: `chart.priceScale('right').applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal })`.
  - Nút `auto`: gọi `chart.priceScale('right').applyOptions({ autoScale: true })`.

- **Cài đặt hiển thị & Store** (`apps/web/src/chart/displaySettings.ts` & `apps/web/src/store/useChartSettingsStore.ts`):
  - Thêm `logScale: boolean` vào `DisplaySettings` (mặc định `false`).
  - Hàm `sanitizeDisplay`: chuẩn hoá boolean `logScale`.
  - Có thể tuỳ chọn hiển thị thêm toggle trong bảng Cài đặt ⚙ (`SettingsButton.tsx`) hoặc chỉ dùng trực tiếp qua nút bấm trên chart.

- **ChartController** (`apps/web/src/chart/ChartController.ts`):
  - Khi khởi tạo: đọc `display().logScale` để cấu hình `rightPriceScale: { mode: ... }`.
  - Phương thức `setLogScale(enabled: boolean)` và trong `applyDisplay()`: gọi `applyOptions` cho `priceScale('right')`.
  - Phương thức `resetPriceScale()`: gọi `applyOptions({ autoScale: true })` cho `priceScale('right')`.

- **Component nút điều khiển thang giá** (`apps/web/src/components/ChartScaleControls.tsx`):
  - Đặt trong `.chart-wrap` (bên cạnh `LayerToggles` và `ChartContextMenu`).
  - Gồm 2 nút: `auto` (Reset tỷ lệ) và `log` (Bật/tắt thang logarit).
  - CSS: `position: absolute; bottom: 4px; right: 4px; z-index: 5;` với style tối giản tương tự TradingView: không viền, nền mờ hoặc trong suốt, đổi màu khi hover/active.

- **SPEC.md**:
  - Cập nhật mục 9 (Hiển thị) ghi nhận chế độ Logarithmic Scale và vị trí nút điều khiển ở góc dưới bên phải biểu đồ.

## Implementation Steps

1. Cập nhật `apps/web/src/chart/displaySettings.ts` (thêm `logScale` vào `DisplaySettings`, `DEFAULT_DISPLAY`, `sanitizeDisplay`) và bổ sung unit test trong `tests/displaySettings.test.ts`.
2. Cập nhật `apps/web/src/chart/ChartController.ts`: áp dụng `PriceScaleMode` từ `lightweight-charts` vào `rightPriceScale`, thêm `resetPriceScale()`.
3. Tạo component `ChartScaleControls.tsx` và thêm style vào `apps/web/src/styles.css` (định vị góc dưới phải, giống TradingView).
4. Nhúng `ChartScaleControls` vào `apps/web/src/components/ChartView.tsx`.
5. Đồng bộ tài liệu `SPEC.md`.
6. Kiểm chứng: chạy `npm run typecheck`, `npm run lint`, `npm test`; build `apps/web`, khởi chạy kiểm tra giao diện bằng Playwright / chụp ảnh qua `scripts/screenshot.ts`.

## Tests / Acceptance

- **Unit test**:
  - `sanitizeDisplay({ logScale: true })` trả về `logScale: true`.
  - `sanitizeDisplay({ logScale: 'invalid' })` giữ nguyên mặc định `false`.
- **Thủ công & Trực quan (Playwright screenshot)**:
  - Nút `log` và `auto` hiển thị đúng vị trí góc dưới bên phải chart (khu vực giao nhau của trục thời gian và trục giá).
  - Click `log` → trục giá chuyển sang thang Logarithmic (khoảng cách giữa các mốc giá theo tỷ lệ %, nến các chu kỳ trước biến động lớn co giãn đều hơn), nút `log` sáng màu `accent`.
  - Click lại `log` → trở về thang Normal / Linear, nút `log` mờ trở lại.
  - Kéo dãn trục giá rồi bấm `auto` → trục giá tự động co lại vừa màn hình (`autoScale`).
  - F5 tải lại trang → trạng thái `logScale` vẫn được lưu giữ.

## Approval Status
Đã duyệt (2026-11-18, "ok").
