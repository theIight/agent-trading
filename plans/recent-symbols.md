# Gợi ý symbol xem gần nhất trong ô tìm kiếm

## Requirements / Spec
1. Ô nhập symbol trên toolbar, khi focus / gõ, gợi ý **các symbol đã xem gần nhất** (mới nhất lên đầu), sau đó là watchlist mặc định (`BTCUSDT`, `ETHUSDT`, `XAUUSD`), không trùng lặp.
2. Chỉ ghi vào "gần đây" khi symbol **tải nến thành công** (gõ sai `BTCUSDTX` → lỗi → không lưu rác).
3. Tối đa **8** symbol gần đây; xem lại symbol cũ thì đưa nó lên đầu.
4. Lưu `localStorage` key `wca:recent-symbols` (theo trình duyệt, như các prefs khác). Dữ liệu hỏng / sai kiểu → coi như rỗng; mỗi phần tử qua `normalizeSymbol`.
5. Gõ để lọc: gợi ý chứa chuỗi đang gõ (vd gõ `SOL` → `SOLUSDT`). Mỗi dòng gợi ý có nhãn nhỏ "Gần đây" cho mục lịch sử; có nút ✕ xoá từng mục gần đây.
6. Bàn phím: ↑/↓ chọn, Enter mở, Esc đóng. Click gợi ý → mở symbol ngay.
7. Không đổi contract agent/server; chỉ UI web.

## Technical Design
- **Pure** `apps/web/src/store/recentSymbols.ts`:
  - `pushRecent(list, symbol, max = 8): string[]` — đưa lên đầu, bỏ trùng, cắt `max`.
  - `parseRecent(raw: unknown): string[]` — chuẩn hoá dữ liệu localStorage.
  - `buildSuggestions(recent, watchlist, query): { symbol, recent: boolean }[]` — gộp, bỏ trùng, lọc theo `query` (sau `normalizeSymbol`).
- **Store** `useRecentSymbolsStore` (zustand, giống `useChartSettingsStore`): `recent`, `add(symbol)`, `remove(symbol)`; đọc/ghi localStorage trong try/catch.
- **Ghi nhận**: `ChartController` thêm listener `onLoaded?(symbol)` gọi sau khi `this.candles = res.candles` thành công; `ChartView` nối vào `useRecentSymbolsStore.add`.
- **UI** `Toolbar.tsx`: thay `<datalist>` bằng dropdown tự vẽ (`.symbol-suggest`), vì datalist không hỗ trợ nhãn/nút xoá và hiển thị khác nhau giữa trình duyệt. Đóng khi blur (trì hoãn ngắn để click kịp nhận) / Esc. CSS dùng biến theme sẵn có (`--border`, `--text`, `--accent`...), sáng/tối.
- **SPEC.md**: bổ sung dòng mô tả gợi ý gần đây ở mục toolbar (dòng `normalizeSymbol`/watchlist).

## Implementation Steps
1. `recentSymbols.ts` + `tests/recentSymbols.test.ts`.
2. Store + listener `onLoaded` trong ChartController/ChartView.
3. Dropdown trong Toolbar + CSS.
4. Cập nhật SPEC.md.
5. `npm run typecheck`, `npm run lint`, `npm test`; chụp ảnh dropdown bằng `scripts/screenshot.ts` (dark + light).

## Tests / Acceptance
- Unit: push lên đầu / bỏ trùng / cắt 8; parse dữ liệu hỏng → `[]`; suggestions gộp đúng thứ tự, không trùng, lọc theo query, đánh dấu `recent`.
- Thủ công: xem `SOLUSDT` → `ETHUSDT` → focus ô nhập thấy `ETHUSDT`, `SOLUSDT` (Gần đây) rồi watchlist; gõ symbol sai → không xuất hiện trong gần đây; reload trang vẫn còn; ✕ xoá được.

## Ghi chú
- Nhánh hiện tại `feat/orderflow-colors` còn thay đổi chưa commit → làm tính năng này trên nhánh riêng `feat/recent-symbols` (tách từ `main` sau khi orderflow-colors được commit/merge, hoặc tách từ nhánh hiện tại nếu bạn muốn).

## Ghi chú triển khai
- Toolbar có `overflow-x: auto` nên dropdown dùng `position: fixed` theo toạ độ ô nhập để không bị cắt.
- Focus ô nhập hiện đủ danh sách (chưa lọc theo symbol đang hiển thị); chỉ lọc sau khi gõ. Blur/Esc trả ô nhập về symbol hiện tại.
- Kiểm chứng bằng Playwright trên dev server tạm (cổng 5181): xem SOL → BTCUSDTX (lỗi) → ETH ⇒ lưu `["ETHUSDT","SOLUSDT","BTCUSDT"]` (không có BTCUSDTX); lọc `SO` → SOLUSDT; ✕ xoá được; reload vẫn còn.

## Approval Status
Đã duyệt (2026-11-13, "ok"). Nhánh `feat/recent-symbols` tách từ `596b481` (= main).
