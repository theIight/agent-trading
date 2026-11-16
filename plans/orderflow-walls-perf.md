# Order flow: tính lịch sử tường theo từng phần (hết chặn event loop)

## Bối cảnh (đo ngày 2026-11-15)
- Gọi `/api/health` mỗi 200ms: cứ khoảng 13–15s lại có spike **3.7s / 10.7s / 7.2s / 8.0s**. TCP connect ~0.2ms, chỉ TTFB chậm, nghĩa là event loop của server đang bận. Trong lúc đó mọi API đều phải đợi: `/api/runners` 19.5s, `/api/klines` 7–9s (gọi thẳng Binance chỉ ~150ms), `/api/liquidations` 6.8s…
- CPU profile JS 60s của process thật: đoạn bận liên tục dài nhất **6.96s**. Gần như toàn bộ nằm trong `GET /api/orderflow/:symbol/levels → BinanceOrderflow.live() → wallSegments() → findWallSegments()` (`median` sort mảng, `new Map(levels)` mỗi mẫu), kèm ~4.2s GC.
- Nguyên nhân: `findWallSegments` duyệt lại **toàn bộ 24h mẫu** mỗi lần chạy. UI poll `/levels` mỗi 15s, còn cache live chỉ giữ 10s (`LIVE_CACHE_SEC`), nên lần poll nào cũng tính lại từ đầu. Bên trong, mỗi lần đóng tường lại duyệt cả 1440 nến 1m (`touched`).
- Đo riêng trên `data/app.db`:

| Symbol | Mẫu 24h | Mức/mẫu | Parse | `findWallSegments` |
|---|---|---|---|---|
| BTCUSDT | 8111 | 1792 | 1.8s | 4.1s |
| XAUUSD | 8110 | 476 | 0.55s | 1.0s |
| ETHUSDT | 6812 | 221 | 0.34s | 0.3s |

  (Parse đã có cache tăng dần `sampleCache`, nên chỉ tốn ở lần đầu.)

## Requirements / Spec
1. `wallSegments` của `/api/orderflow/:symbol/levels` tính **tăng dần**: mỗi request chỉ xử lý mẫu sổ lệnh mới kể từ lần trước. Lần đầu sau khi khởi động server mới duyệt cả 24h.
2. Kết quả giữ nguyên luật hiện tại trong SPEC (k=3 × median, `ORDERFLOW_WALL_MIN_<SYMBOL>`, persist 50%, hụt 1 mẫu, mất dữ liệu > 5 phút thì đóng mọi tường, bỏ tường < 5 phút, consumed/pulled theo nến 1m / mid). Contract `WallSegment` và response không đổi.
3. Cửa sổ 24h: chỉ trả tường còn tồn tại hoặc có `end ≥ now − 24h`. Tường bắt đầu trước cửa sổ có `start` cắt về đầu cửa sổ (`max(start, now − 24h)`). **Khác biệt chấp nhận được** so với tính lại từ đầu: `peakSize` của tường dài hơn 24h có thể tính cả đỉnh trước cửa sổ.
4. Mục tiêu hiệu năng: sau lần đầu, `/levels` của BTC tốn < 50ms CPU mỗi lần poll; monitor `/api/health` trong 2 phút không còn spike > 200ms do order flow.
5. Không đổi: tần suất poll của UI, `LIVE_CACHE_SEC`, phạm vi lấy mẫu BTC (giới hạn ±3% cho BTC làm thay đổi heatmap sổ lệnh nên để quyết định riêng, không nằm trong plan này), snapshot / heatmap / dữ liệu agent nhận.

## Technical Design
### `apps/server/src/orderflow/calc.ts`
- Tạo `class WallTracker` (export), giữ trạng thái giữa các lần gọi:
  - `open: Map<string, OpenWall>`, `closed: WallSegment[]`, `pending: { wall, mids }[]` (tường đã mất nhưng nến 1m chưa phủ hết khoảng `[lastSeen, firstMiss]`), `prevT`, `prevMid`, `latestT`.
  - `push(samples, candles)`: bỏ mẫu có `t ≤ latestT` (mẫu vào theo thứ tự thời gian). Với mỗi mẫu, chạy đúng vòng lặp của `findWallSegments` hiện tại (gap > `maxGapSec` thì đóng hết; với mỗi phía tính ngưỡng, cập nhật / đóng tường mở, mở tường mới). Chỗ đóng tường chuyển sang `pending`.
  - Giải quyết `pending`: khi nến 1m đã đóng phủ tới `to` (`lastCandle.time + 60 > to`), chạy `touched` rồi đưa vào `closed` (hoặc bỏ nếu < `minDurationMin`). Như vậy kết quả giống bản tính lại từ đầu, vốn luôn thấy đủ nến.
  - `segments(from)`: `closed` có `end ≥ from` + `pending` tính tạm bằng nến hiện có (không sửa trạng thái) + tường đang mở thoả `latestT − start ≥ minDurationMin` (status `active`). Cắt `start` về `from`, sort theo `start`. Đồng thời xoá khỏi `closed` các tường có `end < from`.
  - `touched`: nến đã sort theo `time`, nên tìm điểm bắt đầu bằng binary search thay vì duyệt cả mảng.
  - `median`: dùng quickselect trên bản sao (O(n)) thay vì sort.
- `findWallSegments(samples, candles, opts)` giữ nguyên chữ ký, cài lại bằng `new WallTracker(opts)` → `push(sorted, candles)` → `segments(-Infinity)` (không cắt). Test hiện có của `findWallSegments` vẫn đúng, nên bản tăng dần và bản đầy đủ dùng chung một code path.

### `apps/server/src/orderflow/binanceOrderflow.ts`
- Thêm `private readonly wallTrackers = new Map<string, WallTracker>()`.
- `wallSegments(symbol, now)`: lấy (hoặc tạo) tracker theo symbol, `push(historySamples(symbol, now), candles)` (tracker tự bỏ mẫu cũ), trả `segments(now − 24h)`.

### `SPEC.md`
- Ở mục `GET /api/orderflow/:symbol/levels`: ghi rằng lịch sử tường tính tăng dần (chỉ xử lý mẫu mới), tường bắt đầu trước cửa sổ 24h bị cắt `start`.

## Implementation Steps
1. `WallTracker` + cài lại `findWallSegments` trong `calc.ts` (binary search nến, quickselect median).
2. Test `tests/orderflowBinance.test.ts` (hoặc file mới `tests/wallTracker.test.ts`):
   - Tương đương: cùng bộ mẫu ngẫu nhiên có seed (gồm tường xuất hiện / bị quét / bị rút / khoảng mất dữ liệu), `push` theo nhiều lô khác nhau (1 mẫu, 7 mẫu, tất cả) ra kết quả giống hệt `findWallSegments` trên toàn bộ mẫu.
   - Tường mất khi nến chưa phủ: lúc đầu là pending (tạm `pulled` theo mid), có nến chạm thì thành `consumed` với `end` đúng.
   - Cửa sổ: tường đóng trước `from` bị bỏ; tường mở từ trước `from` có `start = from`.
   - `BinanceOrderflow.wallSegments` gọi 2 lần liên tiếp: lần 2 chỉ xử lý mẫu mới (đếm qua spy / số mẫu đã push).
3. Tích hợp `binanceOrderflow.ts`.
4. Cập nhật `SPEC.md`.
5. Kiểm chứng: `npm run typecheck`, `npm run lint`, `npm test`. Restart server, rồi:
   - Đo `/api/orderflow/BTCUSDT/levels` lần đầu và các lần sau (mỗi 15s).
   - Monitor `/api/health` mỗi 200ms trong 2 phút, báo số spike > 200ms.
   - So sánh `wallSegments` BTC trước/sau trên cùng thời điểm (số tường active, các tường ±3% quanh giá).

## Tests / Acceptance
- Unit test tương đương giữa bản tăng dần và bản đầy đủ đạt với mọi cách chia lô.
- `/levels` BTC sau lần đầu < 50ms; không còn spike event loop ~15s một lần; `/api/klines` cold quay về ~150–300ms.
- Chart không đổi bằng mắt: tường vẫn vẽ như cũ (không cần chụp lại vì UI không đổi; nếu `wallSegments` trước/sau lệch ngoài khác biệt ở Requirement 3 thì dừng lại và báo).

## Kết quả phần 1 (đã làm, 2026-11-15)
- `npm run typecheck`, `npm run lint`, `npm test` (29 file, 323 test) đều đạt.
- Trên dữ liệu thật 24h, `findWallSegments` mới cho kết quả **giống hệt** bản cũ: BTC 3220 tường, XAU 134, ETH 985. Tính lại từ đầu cũng nhanh gấp đôi (BTC 3.4s → 1.6s).
- Sau restart, `wallSegments` không còn trong CPU profile. Monitor `/api/health` 2 phút: từ spike 3.7–10.7s khoảng 15s một lần còn **2 spike ≤ 1.1s**.
- Chưa đạt mục tiêu < 50ms: `/levels` BTC lặp lại vẫn mất 0.9–1.8s. Phần còn lại nằm ở `snapshot()` → `collector.samples(now − 240 phút, now)`: mỗi lần đọc lại 4h mẫu từ SQLite và `JSON.parse` (BTC ~1440 mẫu × 24KB ≈ 35MB), không dùng cache `sampleCache` đã parse.
- Ghi chú (không do thay đổi này): restart server làm collector mất các mức xa giá được giữ qua resync (BTC ~1000 → ~170 mức/mẫu), nên các tường xa (33k–128k) chuyển thành `pulled` đúng lúc restart. Lần restart nào cũng vậy.

## Mở rộng phạm vi (phần 2, đã duyệt)
- `BinanceOrderflow.snapshot()`: lấy mẫu 4h từ `historySamples(symbol, now)` (đã parse, có cache), lọc `t ≥ now − BOOK_WINDOW_MIN × 60`, rồi cắt sau khoảng mất dữ liệu > 300s cuối cùng, đúng logic `collector.samples()`. Output không đổi.
- Kiểm tra `buildSnapshot` / `findWalls` không sửa mảng mẫu dùng chung (cache).
- Test: `snapshot()` dùng nguồn chỉ có `rawSamples` (`samples` ném lỗi) cho kết quả như cũ; có khoảng mất dữ liệu > 5 phút thì bỏ phần trước khoảng đó.
- Kiểm chứng lại: typecheck / lint / test; restart; `/levels` BTC lặp lại < 100ms; monitor `/api/health` 2 phút không còn spike > 200ms.

### Kết quả phần 2 (đã làm)
- Thêm `BinanceOrderflow.bookWindowSamples()`; `snapshot()` không còn gọi `collector.samples()`. Test đối chiếu với logic cũ (có khoảng mất dữ liệu) đạt. typecheck / lint / test (29 file, 325 test) đạt.
- `JSON.parse` / đọc SQLite 4h không còn trong profile. Monitor `/api/health` 2 phút: 2 spike (0.22s, 1.23s).
- Vẫn chưa đạt < 100ms. Mỗi lần poll `/levels` BTC chặn event loop **0.5–0.9s**. Phân tích các đoạn bận > 300ms: ~45% GC, ~20% `findWalls` (tạo `new Map` bids/asks cho cả ~1440 mẫu 4h mỗi lần), ~20% `collector.status()` (gọi 2 lần mỗi request).
- `collector.status()`: `SELECT MIN(t), MAX(t) FROM book_samples WHERE symbol=?` gộp 2 aggregate nên SQLite không dùng tối ưu min/max, quét cả range của symbol (bảng WITHOUT ROWID chứa luôn JSON). BTC **103ms** mỗi lần, tách thành 2 subquery chỉ còn **0.14ms**.

## Mở rộng phạm vi (phần 3, chờ duyệt)
- `BookCollector.status()`: `SELECT (SELECT MIN(t) …), (SELECT MAX(t) …)`. Kết quả không đổi.
- `findWalls` (`calc.ts`): bỏ `new Map` cho mọi mẫu. Lấy tập giá ứng viên (mức ≥ k × median ở mẫu cuối, thường vài chục) rồi đi lùi theo mẫu; mỗi mẫu quét `levels` một lần, chỉ lấy khối lượng của giá ứng viên (Set) và dừng sớm khi mọi ứng viên đã đứt. Output giống hệt.
- Test: `findWalls` mới khớp bản cũ (giữ bản cũ trong test làm reference) trên dữ liệu ngẫu nhiên; `status()` trả đúng `since`/`lastSampleAt`.
- Kiểm chứng: typecheck / lint / test; restart; profile lại; `/levels` BTC chặn event loop < 100ms; monitor 2 phút.

## Approval Status
Phần 1: đã duyệt (2026-11-15, "ok"), đã làm. Phần 2: đã duyệt (2026-11-15, "ok"), đã làm. Phần 3: chờ duyệt. Nhánh `feat/alerts-orderflow-layout`.
