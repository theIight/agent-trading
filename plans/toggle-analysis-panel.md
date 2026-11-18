# Ẩn / hiện tab phân tích (mở rộng không gian xem chart)

## Requirements / Spec

1. **Chức năng**:
   - Cho phép người dùng thu gọn / ẩn toàn bộ bảng phân tích bên phải (`AnalysisPanel`), giúp biểu đồ (`ChartView`) mở rộng chiếm trọn 100% chiều ngang màn hình.
   - Khi cần phân tích hoặc xem lại kết quả / lịch sử, người dùng có thể mở lại bảng phân tích dễ dàng chỉ với 1 click.

2. **Vị trí và cách điều khiển**:
   - **Trên Toolbar (thanh công cụ trên cùng)**:
     - Thêm nút icon bật/tắt bảng phân tích ở góc phải thanh công cụ (bên cạnh nút cài đặt ⚙ và nút đổi theme ☀/☾).
     - Icon biểu tượng sidebar / bảng điều khiển (`◨` hoặc SVG sidebar).
     - Tooltip: `Ẩn bảng phân tích` (khi đang mở) hoặc `Hiện bảng phân tích` (khi đang ẩn).
   - **Trên tiêu đề bảng phân tích (`AnalysisPanel`)**:
     - Nút thu gọn `»` ở góc phải của thanh tab (`.tabs`) để người dùng có thể đóng ngay tại chỗ.
   - **Trên mép phải biểu đồ (`ChartView`) khi đang ẩn**:
     - Một nút mở nhanh nhỏ gọn (`«`) ở góc phải trên của chart để người dùng có thể mở lại nhanh mà không cần di chuột lên toolbar.

3. **Lưu trạng thái (Persistence)**:
   - Lưu trạng thái `panelOpen: boolean` vào `localStorage` (`wca:prefs`).
   - Mặc định: `true` (mở bảng).
   - Khi người dùng F5 hoặc mở tab mới, trạng thái ẩn/hiện được giữ nguyên theo cài đặt gần nhất.

4. **Tự động co giãn biểu đồ**:
   - Thư viện `lightweight-charts` đã bật `autoSize: true`. Khi `.panel` ẩn đi, `.chart-wrap` tự động nở rộng lấp đầy không gian flexbox `main`, biểu đồ tự động vẽ lại kích thước mới mượt mà, không méo hình.

5. **Phạm vi tác động**:
   - Chỉ ở tầng UI web (`apps/web`), không đổi contract agent/server.
   - Cập nhật tài liệu `SPEC.md`.

## Technical Design

- **App Store** (`apps/web/src/store/useAppStore.ts`):
  - Bổ sung `panelOpen: boolean` vào `Prefs` (mặc định `true`).
  - Thêm action `togglePanel: () => void` và `setPanelOpen: (open: boolean) => void`.
  - Tự động lưu `panelOpen` vào `localStorage` (`wca:prefs`).

- **Giao diện App & Toolbar** (`apps/web/src/App.tsx`, `apps/web/src/components/Toolbar.tsx`):
  - Trong `App.tsx`: điều kiện render `{panelOpen && <AnalysisPanel />}`.
  - Trong `Toolbar.tsx`: thêm button icon ở cụm điều khiển bên phải.

- **Nút thu gọn trong AnalysisPanel** (`apps/web/src/components/AnalysisPanel.tsx`):
  - Thêm nút thu gọn `»` vào thanh `.tabs` (bên cạnh nút `Xoá overlay` nếu có).

- **Nút mở nhanh trên ChartView** (`apps/web/src/components/ChartView.tsx`):
  - Khi `!panelOpen` và không ở chế độ `snapshot`: render nút mở bảng phân tích (`«`) nổi ở mép phải chart (`.open-panel-btn`).

- **Styling** (`apps/web/src/styles.css`):
  - Style nút icon trên toolbar, nút thu gọn trên panel, và nút nổi mép phải chart.

## Implementation Steps

1. Cập nhật `apps/web/src/store/useAppStore.ts`: thêm `panelOpen` (load/save localStorage) và action `togglePanel`, `setPanelOpen`. Viết unit test cho store trong `tests/appStore.test.ts`.
2. Cập nhật `apps/web/src/App.tsx`: render `AnalysisPanel` có điều kiện theo `panelOpen`.
3. Cập nhật `apps/web/src/components/Toolbar.tsx`: thêm nút icon toggle panel.
4. Cập nhật `apps/web/src/components/AnalysisPanel.tsx`: thêm nút thu gọn `»` trên thanh tabs.
5. Cập nhật `apps/web/src/components/ChartView.tsx`: thêm nút mở nhanh `«` khi panel đang ẩn.
6. Cập nhật `apps/web/src/styles.css`.
7. Đồng bộ tài liệu `SPEC.md`.
8. Kiểm chứng: `npm run typecheck`, `npm run lint`, `npm test`, build web và restart pm2; kiểm thử tự động với Playwright và chụp ảnh màn hình xác nhận chart giãn rộng 100%.

## Tests / Acceptance

- **Unit test**:
  - `useAppStore` lưu và load đúng `panelOpen`.
  - Gọi `togglePanel()` chuyển đổi qua lại giữa `true` và `false`.
- **Thủ công & Trực quan (Playwright)**:
  - Ban đầu bảng phân tích mở (`width: 360px`).
  - Click nút ẩn trên Toolbar hoặc nút `»` trên panel → bảng phân tích ẩn đi, chart tự động chiếm trọn 100% bề ngang màn hình.
  - Khi panel ẩn, click nút `«` trên chart hoặc nút trên Toolbar → bảng phân tích mở lại bình thường.
  - F5 tải lại trang → trạng thái ẩn/hiện được giữ nguyên.

## Approval Status
Đã duyệt (2026-11-18, "ok").
