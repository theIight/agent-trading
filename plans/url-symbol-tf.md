# Symbol + khung trên URL (mỗi tab giữ symbol riêng khi reload)

## Vấn đề
`symbol`/`tf` chỉ lưu trong localStorage `wca:prefs` (dùng chung mọi tab). Mở nhiều tab rồi reload thì tab nào cũng nhận symbol của tab đổi gần nhất.

## Requirements / Spec
1. URL của trang chính luôn mang symbol và khung đang xem: `/?symbol=INJUSDT&tf=1m`.
   - Đổi symbol hoặc khung → URL cập nhật ngay bằng `history.replaceState`: không reload, không tạo thêm mục trong lịch sử Back.
   - Các tham số khác trên URL (vd `demo`) được giữ nguyên.
2. Khi tải trang, symbol/khung lấy theo thứ tự ưu tiên:
   1. tham số URL (hợp lệ),
   2. localStorage `wca:prefs` (như hiện nay, để tab mới mở không có tham số vẫn ra symbol dùng gần nhất),
   3. mặc định `BTCUSDT` / `4h`.
   - Từng tham số xét riêng: URL chỉ có `symbol` thì `tf` lấy từ localStorage.
   - `symbol` qua `normalizeSymbol` (chữ hoa, alias `GOLD` → `XAUUSD`…); `tf` không hợp lệ (`isTimeframe` sai) thì bỏ qua và lấy nguồn kế tiếp.
   - Tải trang mà URL thiếu tham số → ghi bổ sung luôn vào URL (replaceState), để reload lần sau vẫn đúng tab đó.
3. localStorage vẫn được ghi khi đổi symbol/khung như cũ (để tab mới mở ra symbol gần nhất). Theme vẫn chỉ ở localStorage, không đưa lên URL.
4. Chế độ snapshot (`?snapshot=<id>&tf=`) không đọc và không ghi các tham số này, giữ hành vi cũ.
5. Copy URL gửi người khác / bookmark → mở đúng symbol + khung.

## Technical Design
- **Pure** `apps/web/src/store/urlPrefs.ts`:
  - `readUrlPrefs(search): { symbol?: string; tf?: Timeframe }`: đọc và chuẩn hoá, bỏ giá trị sai.
  - `writeUrlPrefs(search, symbol, tf): string`: trả về query mới (giữ tham số khác; `symbol` và `tf` đứng đầu).
- `useAppStore`:
  - giá trị khởi tạo = `{ ...loadPrefs(), ...readUrlPrefs(location.search) }` (khi không ở chế độ snapshot), rồi mặc định;
  - `setSymbol` / `setTf` gọi `syncUrl()` → `history.replaceState(null, '', path + writeUrlPrefs(...) + hash)` khi query thay đổi;
  - đồng bộ URL một lần lúc khởi tạo.
  - Nhận biết snapshot bằng `parseSnapshotParams(location.search) !== null`.
- Không đổi server, contract hay agent. Link snapshot do server tạo giữ nguyên.
- SPEC: bổ sung vào mục toolbar/symbol.

## Implementation Steps
1. `urlPrefs.ts` + `tests/urlPrefs.test.ts`: đọc hợp lệ / sai, alias, chỉ có một tham số, giữ `demo`, ghi đè giá trị cũ.
2. Tích hợp `useAppStore` (khởi tạo + replaceState, bỏ qua khi snapshot).
3. Cập nhật SPEC.
4. `npm run typecheck`, `npm run lint`, `npm test`; kiểm thử Playwright trên vite dev: 2 tab (INJUSDT 1m, ETHUSDT 4h) đổi qua lại rồi reload từng tab, mỗi tab giữ đúng symbol của nó; tab mới không tham số ra symbol gần nhất; URL `?symbol=gold&tf=xx` → XAUUSD + khung từ localStorage. Chụp ảnh.
5. Build web + restart `wca-web` (pm2) sau khi kiểm chứng xong.

## Tests / Acceptance
- Tab A `?symbol=INJUSDT&tf=1m`, tab B đổi sang ETHUSDT 4H; reload tab A → vẫn INJUSDT 1m.
- Đổi symbol bằng toolbar → thanh địa chỉ đổi theo, nút Back không đi qua từng symbol.
- Mở `/` (tab mới) → symbol/khung gần nhất, URL được bổ sung tham số.
- Snapshot Telegram vẫn chụp đúng.

## Ghi chú triển khai
- Đã kiểm thử bằng Playwright trên vite dev (cổng 5199):
  - tab A `?symbol=INJUSDT&tf=1m`; tab B đổi từ ETHUSDT 1H sang 4H thì URL thành `?symbol=ETHUSDT&tf=4h`, `history.length` không tăng;
  - reload tab A vẫn INJUSDT 1m;
  - tab mới mở `/` ra `?symbol=ETHUSDT&tf=4h`;
  - `?symbol=gold&tf=xx&demo=wait` ra `?symbol=XAUUSD&tf=4h&demo=wait`;
  - `?snapshot=abc123&tf=1h` giữ nguyên URL.

## Approval Status
Đã duyệt (2026-11-16, "ok").
