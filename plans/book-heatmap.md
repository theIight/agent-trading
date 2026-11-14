# Heatmap sổ lệnh (liquidity heatmap) từ dữ liệu order flow sẵn có

## Bối cảnh
Chart hiện chỉ vẽ order flow dạng **tường** (≥ 3 × median và ≥ `ORDERFLOW_WALL_MIN`) + ≤ 12 level, nên trông thưa hơn Liquidity Heatmap của Coinglass. Collector đã lưu toàn bộ sổ lệnh gom theo bucket mỗi 10 giây trong 24 giờ (`book_samples`), nhưng chart chưa dùng phần thanh khoản nhỏ. Plan này vẽ **toàn bộ thanh khoản lệnh chờ** thành heatmap (thời gian × giá), không thêm nguồn dữ liệu. Gộp nhiều sàn / lưu lâu hơn là plan sau.

## Requirements / Spec
1. Symbol có collector order flow Binance (`ORDERFLOW_BINANCE_SYMBOLS`, hiện `BTCUSDT`, `XAUUSD`) có lớp **"Heatmap sổ lệnh"** trong thanh Lớp hiển thị. Mặc định tắt, nhớ trong localStorage.
2. Mỗi ô = khối lượng lệnh chờ **trung bình** của một bucket giá trong một cột thời gian (cả bid lẫn ask). Màu theo một thang duy nhất (tối → sáng), lệnh nhỏ mờ, lệnh lớn sáng; vẽ **sau nến** (nền), không che nến.
3. Cột thời gian = độ dài nến khung đang xem (tối thiểu 1 phút), tối đa 24 giờ (giới hạn lưu của collector) và ≤ 720 cột. Cột cuối (đang chạy) cập nhật theo poll.
4. Giá ô quy về giá chart bằng **basis tại thời điểm cột** (giống tường: `price = sourcePrice − basis`), nên heatmap khớp nến chart.
5. Cường độ màu do client tính theo **thứ hạng phân vị** của ô trong dữ liệu đang có (lũy thừa 3: ~10% ô dày nhất sáng). *(Ban đầu định dùng √(qty/p99); đổi khi kiểm chứng — xem Ghi chú triển khai.)* Cài đặt ⚙: độ đậm heatmap sổ lệnh (0.2–1.5×) và ngưỡng ẩn ô nhỏ (0–50 % phân vị).
6. Bật "Heatmap sổ lệnh" thì tự tắt "Heatmap thanh lý (ước tính)" và ngược lại, để hai lớp màu không chồng lên nhau.
7. Lớp tường / level hiện tại giữ nguyên, vẽ đè lên heatmap.
8. Chỉ là UI/API hiển thị: **không** đổi contract agent (`analysis.ts`), snapshot gửi agent, validator hay prompt.
9. Vàng: ghi chú sẵn có "sổ lệnh futures chỉ phủ ±N" vẫn hiện; heatmap chỉ có dữ liệu trong vùng phủ (dải hẹp quanh giá) — chấp nhận.

## Technical Design

### Contract (`packages/shared/src/orderflow.ts` hoặc file hiện có chứa `LiveOrderflow`)
```ts
export interface BookHeatmap {
  symbol: string;
  colSec: number;
  bucket: number;            // bucket giá nguồn (BTC 10, vàng 1)
  /** Unix giây mở cột, tăng dần. */
  cols: number[];
  /** Basis (nguồn − chart) của từng cột: giá chart của ô = ix × bucket − shift[i]. */
  shift: number[];
  /** data[i] = phẳng [ix, qty, ix, qty, ...]; giá nguồn ô = ix × bucket; qty theo đơn vị nguồn (BTC / oz). */
  data: number[][];
  unit: string;
  /** Cột cuối là cột đang chạy (chưa đóng). */
  partialLast: boolean;
  asOf: number;
}
```
- Gửi **khối lượng thật** (làm tròn 3 số lẻ) thay vì cường độ, để client tự tính thang và ghép dữ liệu tăng dần không bị lệch thang.

### Server
- **Pure** `apps/server/src/orderflow/bookHeatmap.ts`: `buildBookHeatmap(samples, { colSec, bucket, from, to, basisAt, maxCols })`:
  - Gom mẫu theo cột `floor(t / colSec) × colSec`; mỗi bucket: tổng qty (bid + ask) / số mẫu trong cột → trung bình (bucket không có trong mẫu = 0).
  - Bỏ ô < 0.1 % ô lớn nhất của cột (giảm dung lượng, không thấy được bằng mắt).
  - `shift[i] = basisAt(col + colSec)` cho cột đã đóng, basis hiện tại cho cột đang chạy.
- `BinanceOrderflow.bookHeatmap(symbol, tf, after?)`: dùng `historySamples` (đã cache) + `basisFn`. Cache cột **đã đóng** theo `(symbol, colSec)`; mỗi request chỉ tính thêm cột mới + cột đang chạy.
- Route `GET /api/orderflow/:symbol/heatmap?tf=&after=` → `BookHeatmap`. `after` = mở cột đã đóng cuối cùng client có → chỉ trả các cột sau đó (lần đầu không có `after` → trả đủ). Symbol không bật → 404, `tf` sai → 400.

### Web
- `api/client.ts`: `fetchBookHeatmap(symbol, tf, after?)`.
- Store `useBookHeatmapStore` (giống `useLiquidationStore`): `show` (localStorage `wca:layerBookHeatmap`), `data`, `watch(symbol, tf)`, poll 15 giây với `after`, ghép cột mới (thay cột đang chạy cũ), cắt cột ngoài 24 giờ. Bật lớp này → `useLiquidationStore` tắt heatmap thanh lý và ngược lại.
- **Pure** `apps/web/src/overlays/bookHeatmapModel.ts`: `mergeHeatmap(prev, next)`, `heatScale(data, hidePct)` → `{ ref (p99), min }`, `intensityOf(qty, ref)` = `255 × √min(1, qty/ref)`.
- Vẽ: tách `HeatmapRenderer` hiện có của `LiquidationPrimitive` thành renderer dùng chung (nhận cột, ô, hàm giá theo cột), hoặc thêm `BookHeatmapPrimitive` riêng gắn vào `candleSeries` trước primitive tường. Thang màu khác heatmap thanh lý (vd đen-xanh dương → vàng-trắng kiểu Bookmap) để phân biệt.
- `LayerToggles`: checkbox "Heatmap sổ lệnh" khi symbol có order flow live; tooltip ghi nguồn (Binance spot / futures), "trung bình lệnh chờ theo cột, 24 giờ gần nhất".
- `displaySettings`: `bookHeatOpacity` (0.2–1.5, mặc định 1), `bookHeatHidePct` (0–50, mặc định 20).

### Dung lượng (ước lượng)
BTC: ~280–400 bucket/cột. Khung 1m lần đầu 720 cột ≈ 1–2 MB JSON (localhost, một lần); các poll sau chỉ 1–2 cột (vài KB). Khung lớn ít cột hơn nhiều.

### SPEC.md
Thêm mục 3.3: heatmap sổ lệnh, endpoint `/api/orderflow/:symbol/heatmap`, cài đặt mới.

## Implementation Steps
1. Contract `BookHeatmap` trong `packages/shared`.
2. `bookHeatmap.ts` + `tests/bookHeatmap.test.ts`.
3. `BinanceOrderflow.bookHeatmap` + cache cột + route; test route (404/400/`after`).
4. Web: client, store, `bookHeatmapModel.ts` + `tests/bookHeatmapModel.test.ts`, renderer, toggle, cài đặt.
5. SPEC.md.
6. `npm run typecheck`, `npm run lint`, `npm test`; chụp ảnh BTC 1m / 15m và vàng 1m (dark + light) bằng dev server tạm (không đụng pm2); đo dung lượng response lần đầu.

## Tests / Acceptance
- Unit server: gom cột đúng (trung bình theo số mẫu, bucket vắng = 0), bid + ask cộng chung, `shift` theo basis từng cột, `after` chỉ trả cột sau, cột đang chạy đánh dấu `partialLast`, ≤ `maxCols`, bỏ ô quá nhỏ.
- Unit web: ghép thay cột đang chạy, không trùng cột, cắt 24 giờ; thang p99 + ẩn phân vị; cường độ kẹp 1–255.
- Thủ công: BTC 1m bật lớp thấy dải thanh khoản liên tục quanh giá, các tường hiện tại trùng vệt sáng; tắt/bật heatmap thanh lý loại trừ nhau; poll không tải lại toàn bộ (xem network: lần sau vài KB); vàng có dải hẹp kèm ghi chú vùng phủ.

## Ngoài phạm vi (plan sau)
- Thêm nguồn: BTC perp Binance, OKX, Bybit, Coinbase L2 (gộp nhiều sàn).
- Lưu lâu hơn bằng gộp dần (1 phút / 7 ngày, 5 phút / 30 ngày) để khung lớn có heatmap dài.

## Ghi chú triển khai
- **Thang màu** (đổi so với thiết kế): √(qty/p99) làm BTC gần như tối (phân bố đuôi dài: p50 ≈ 2 BTC, p99 ≈ 132) và vàng sáng gần hết (sổ lệnh dày đều: p80 ≈ 43% p99). Đã đổi sang **thứ hạng phân vị³**, tính trên **vùng đang nhìn thấy** (cột + dải giá, kiểu auto-contrast Bookmap), cache theo vùng làm tròn 1/20 chiều cao.
- Dung lượng đo thật: BTC 1m lần đầu ~1.98 MB (719 cột, ~178k ô), 15m ~250 KB; poll tăng dần ~2.8 KB.
- Sửa kèm: `ChartController.destroy()` tăng `loadToken` — ở dev (StrictMode mount 2 lần) controller bị huỷ khi đang tải vẫn gọi `resetPriceScale` lên chart đã remove → hiện "Lỗi tải dữ liệu: Value is null". Bản build pm2 không bị, nhưng là lỗi thật khi huỷ giữa chừng.
- Kiểm chứng UI bằng server tạm (cổng 8788, bản sao DB trong scratchpad) + vite dev (5181); không đụng pm2. Ảnh: BTC 1m/15m (dark/light), vàng 1m; bật heatmap thanh lý ↔ heatmap sổ lệnh loại trừ nhau.
- Ở zoom xa (BTC 15m), bucket 10$ < 1px nên heatmap thành các vạch mảnh — đúng dữ liệu; gộp bucket theo zoom có thể làm sau.

## Approval Status
Đã duyệt (2026-11-13, "ok"). Nhánh `feat/book-heatmap` tách từ `feat/recent-symbols`.
