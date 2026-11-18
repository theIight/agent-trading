# Tiêu đề tab: symbol + giá hiện tại

## Requirements / Spec
1. Tiêu đề tab trình duyệt (`document.title`) hiển thị symbol đang xem và giá mới nhất, giống TradingView:
   `BTCUSDT 64,083.1 ▲ +0.15%`
   - Giá = `close` của nến mới nhất (kể cả nến đang chạy), cập nhật realtime theo live feed (WS Binance / SSE `/api/live`).
   - Số thập phân theo đúng precision của price scale chart (`pricePrecision`), có dấu phân cách hàng nghìn.
   - `▲ +x.xx%` / `▼ −x.xx%` = thay đổi so với **giá đóng cửa nến 1D gần nhất đã đóng** (giống TradingView: % theo phiên ngày, không đổi khi chuyển khung).
2. Rê chuột (crosshair) trên chart **không** đổi tiêu đề — luôn là giá mới nhất.
3. Đang tải / đổi symbol → `BTCUSDT`; lỗi tải nến → `BTCUSDT · Lỗi`; chưa có dữ liệu → `Wyckoff Chart Agent`.
4. Trang snapshot (`?snapshot=`, dùng cho ảnh Telegram) giữ tiêu đề cũ.
5. Không đổi contract agent/server; chỉ UI web.

## Technical Design
- **Pure** `apps/web/src/chart/tabTitle.ts`:
  `formatTabTitle({ symbol, price, precision, refClose? }): string` → ghép symbol, giá (`toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p })`), mũi tên + % khi có `refClose`.
- **ChartController**: thêm listener `onLastPrice?(symbol, close, precision)` gọi sau khi tải nến xong và trong `onLiveCandle` (không gọi từ crosshair).
- **% ngày**: khi đổi symbol, `ChartView` gọi `fetchKlines({ symbol, tf: '1d', limit: 2, closedOnly: true })` (API sẵn có) lấy `close` nến 1D đã đóng gần nhất làm `refClose`; làm mới khi qua mốc đóng nến ngày (so `time` nến live với `refTime + 86400`). Lỗi → bỏ phần %.
- **ChartView** (chỉ khi không ở chế độ snapshot): `useEffect` gán `document.title = formatTabTitle(...)`; cleanup khôi phục `Wyckoff Chart Agent`.
- **SPEC.md**: thêm 1 dòng ở mục UI chart.

## Implementation Steps
1. `tabTitle.ts` + `tests/tabTitle.test.ts`.
2. Listener `onLastPrice` trong ChartController.
3. ChartView: lấy `refClose` 1D + gán `document.title`.
4. Cập nhật SPEC.md.
5. `npm run typecheck`, `npm run lint`, `npm test`; build web, restart `wca-web`, kiểm chứng bằng Playwright (đọc `document.title`, đổi symbol, chờ tick live) + chụp ảnh.

## Tests / Acceptance
- Unit: precision 1/2/5 chữ số, phân cách nghìn, tăng → `▲ +`, giảm → `▼ −`, không có `refClose` → chỉ symbol + giá, `refClose = 0` không chia cho 0.
- Thủ công: mở BTCUSDT → tiêu đề `BTCUSDT 64,083.1 ▲ +0.15%` và nhảy theo giá; rê chuột không đổi; chuyển XAUUSD → tiêu đề đổi theo; 2 tab khác symbol phân biệt được trên thanh tab.

## Approval Status
Đã duyệt (2026-11-18, "ok") — có phần % ngày.
