# Chuột phải trên chart để copy giá

## Requirements / Spec
1. Chuột phải ở bất kỳ đâu trong vùng nến (kể cả trên trục giá bên phải) thì **không** hiện menu của trình duyệt mà hiện một menu nhỏ ngay tại con trỏ:
   - **Copy giá `<giá tại con trỏ>`**: giá ở toạ độ Y của chuột, làm tròn theo bước giá đang hiển thị của mã (cùng số chữ số thập phân với trục giá).
   - **Copy giá đóng `<close>`**: giá đóng của nến dưới con trỏ (chỉ hiện khi con trỏ đang ở trên một nến).
2. Giá được copy là số thô, dùng dấu `.` thập phân, không có dấu phân cách hàng nghìn (vd `97234.5`, `0.000123`), để dán thẳng vào ô lệnh trên sàn hoặc Telegram.
3. Copy xong: menu đóng, hiện thông báo nhỏ "Đã copy 97234.5" khoảng 1,5 giây. Nếu clipboard lỗi thì báo "Không copy được".
4. Menu đóng khi: click ra ngoài, nhấn Esc, cuộn hoặc kéo chart, đổi symbol hoặc khung.
5. Menu không tràn ra ngoài khung chart (gần mép phải/dưới thì lật vào trong).
6. Không áp dụng cho chế độ snapshot (`SnapshotApp`).

## Technical Design
- **Pure** `apps/web/src/chart/copyPrice.ts`:
  - `formatPriceForCopy(price, precision)`: `toFixed(precision)`, bỏ `-0`, không định dạng theo locale.
  - `clampMenuPosition(x, y, menuW, menuH, boxW, boxH)`: trả về toạ độ menu đã lật vào trong khung.
- **ChartController**: thêm `priceAt(y): { price: string; close: string | null } | null`. Dùng `candleSeries.coordinateToPrice(y)`, precision lấy từ `fixedPrecision` hoặc từ cách tính tự động đang có (tách hàm `currentPrecision()`). Nến dưới con trỏ lấy từ crosshair gần nhất (`handleCrosshair` đã có `param.time`).
- **UI** `apps/web/src/components/ChartContextMenu.tsx`: lắng nghe `contextmenu` trên container trong `ChartView` (`preventDefault`), render menu `position:absolute` theo theme, ghi clipboard bằng `navigator.clipboard.writeText` (localhost là secure context), kèm toast.
- Không đổi contract `packages/shared`, server, MCP hay agent.
- SPEC: thêm một dòng vào mục tương tác chart.

## Implementation Steps
1. `copyPrice.ts` + `tests/copyPrice.test.ts` (precision 1/2/4/7, số âm/0, lật menu ở 4 góc).
2. `ChartController.priceAt` + tách `currentPrecision()`.
3. `ChartContextMenu` + gắn vào `ChartView`, đóng menu theo các điều kiện ở mục 4.
4. Cập nhật SPEC.
5. `npm run typecheck`, `npm run lint`, `npm test`; chụp ảnh menu bằng `scripts/screenshot.ts` (BTC và một mã giá nhỏ).

## Tests / Acceptance
- BTC: chuột phải tại mức ~97k thì menu hiện `Copy giá 97234.5`; dán ra được đúng chuỗi đó.
- Mã giá nhỏ (vd PEPE): giá copy giữ đủ số thập phân như trên trục giá.
- Chuột phải gần mép phải/dưới: menu nằm trong khung chart.
- Esc / click ngoài / kéo chart: menu đóng.

## Ghi chú triển khai
- `pricePrecision` tách ra `copyPrice.ts`, dùng chung cho trục giá và giá copy.
- Clipboard: `navigator.clipboard`, ngoài secure context (mở qua IP LAN) thì dùng `execCommand('copy')` dự phòng.
- Đã kiểm thử bằng Playwright trên vite dev (cổng 5199, vì 5173 là `vite preview` của pm2 chạy bản build): BTC 4H `Copy giá 73922.3 | Copy giá đóng 75939.0`; 1000PEPE `0.0047327`; trên trục giá chỉ có "Copy giá"; menu gần mép phải được lật vào trong; Esc và click ngoài đều đóng menu; clipboard ra đúng chuỗi.

## Approval Status
Đã duyệt (2026-11-16, "ok").
