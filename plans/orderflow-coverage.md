# Vùng phủ sổ lệnh theo giá + giữ tường ngoài vùng phủ

## Bối cảnh (sự cố 2026-11-13)
- Lúc khoảng 05:50 UTC, tường bid 500+ BTC ở 67000 (Binance spot) đã nằm trên sổ lệnh. Giá chọc xuống khoảng 67.7k spot lúc 05:56 rồi hồi lên.
- Chart chỉ hiện tường này từ **06:20 UTC**. Đó đúng là lúc snapshot định kỳ 30 phút (log `13:19:03 … đồng bộ sổ lệnh (định kỳ)`).
- Nguyên nhân:
  - Snapshot spot `limit=5000` chỉ phủ khoảng 1000–1400$ dưới giá BTC (tick 0.01).
  - `sampleBook` chỉ lấy các mức ≥ `coverLow`.
  - `coverLow` chỉ được tính lại mỗi `ORDERFLOW_RESYNC_MIN=30` phút. Lúc đó `coverLow = 67470`, nên mức 67000 bị lọc dù server đã nhận nó qua diff WebSocket.
- Dữ liệu đã mất không lấy lại được, vì API công khai không có lịch sử sổ lệnh.

## Requirements / Spec
1. **Snapshot lại khi giá tới gần mép vùng phủ.** Mỗi lần lấy mẫu (10s), nếu đã đồng bộ, không đang đồng bộ và khoảng cách từ mid tới `coverLow` hoặc `coverHigh` nhỏ hơn `ORDERFLOW_EDGE_RESYNC_PCT` (mặc định **35**) % độ rộng vùng phủ phía đó lúc snapshot, thì gọi `resync('gần mép vùng phủ')`.
   - Giữa hai lần snapshot do chạm mép cách nhau tối thiểu `ORDERFLOW_EDGE_RESYNC_MIN_SEC` (mặc định 60s), để không vượt rate limit. Spot depth 5000 tốn 250 weight; giới hạn là 6000/phút.
   - Snapshot định kỳ `ORDERFLOW_RESYNC_MIN*` giữ nguyên, dùng làm lưới an toàn.
   - Áp dụng cho mọi symbol, kể cả XAUUSD futures (1000 mức, khoảng ±13$).
2. **Mức ngoài vùng phủ mà diff đã chạm thì được tính.** Một diff Binance mang khối lượng **tuyệt đối** của mức giá, nên mức nào nhận diff sau snapshot thì có số đúng.
   - `LocalBook` ghi lại tập giá đã nhận diff (`touched`) ở mỗi phía.
   - `sampleBook` lấy: các mức trong vùng phủ như cũ, **cộng** các mức ngoài vùng phủ có trong `touched`.
   - Mức ngoài vùng phủ chưa từng nhận diff thì vẫn bỏ, vì không biết số thật.
   - Bucket ngoài vùng phủ chỉ cộng các mức đã chạm, nên là cận dưới. Với tường lớn đặt mới thì không ảnh hưởng.
   - **Thay đổi so với `plans/orderflow-gold.md` mục 4** ("không dùng mức ngoài vùng ảnh chụp"): nay dùng các mức đã nhận diff, vì khối lượng của chúng chính xác.
3. **Giữ các mức ngoài vùng phủ qua lần snapshot lại** khi luồng diff không đứt, tức là snapshot định kỳ hoặc do chạm mép. Không giữ khi WebSocket rớt hoặc mất chuỗi update.
   - Trước khi áp snapshot mới, lưu các mức đã chạm.
   - Sau snapshot, mức nào nằm ngoài vùng phủ mới thì khôi phục, rồi áp **mọi** diff trong buffer theo thứ tự cho các mức đó, kể cả diff bị coi là stale với snapshot, để không sót thay đổi trong lúc đang chụp.
   - Mức nằm trong vùng phủ mới thì lấy theo snapshot.
4. **Mẫu ghi thêm vùng phủ**: `BookSample` có thêm `coverLow?`, `coverHigh?` (JSON cũ không có thì coi như mọi mức nằm trong vùng phủ). Chỉ để tra cứu, chưa đổi cách vẽ.
5. `GET /api/orderflow/:symbol` trong `status` thêm `farLevels` (số mức ngoài vùng phủ đang giữ) và `lastResyncReason`.

Ngoài phạm vi: vẽ nhạt các mức ngoài vùng phủ trên UI, và đổi tần suất lấy mẫu 10s.

## Technical Design
> Điều chỉnh khi làm: trong sổ cục bộ, mức ngoài vùng phủ **chỉ** có thể đến từ diff (hoặc giữ lại qua snapshot), nên không cần tập `touched` riêng. `sampleBook` bỏ điều kiện vùng phủ. Khi snapshot lại liền mạch thì giữ **toàn bộ** sổ cũ nằm ngoài vùng phủ mới, trong ±15% quanh giá (cả vùng snapshot cũ cũng đúng, không riêng mức đã chạm).

- `apps/server/src/orderflow/localBook.ts`
  - `LocalBook`: thêm `touchedBids/touchedAsks: Set<number>`. `applyDiff` thêm giá vào set; mức có qty 0 thì xoá khỏi map và set.
  - `applySnapshot(s, carry?)`: `carry` = `{ bids, asks }` gồm các mức đã chạm từ sổ cũ. Sau khi tính cover mới, khôi phục những mức nằm ngoài [coverLow, coverHigh] vào map và set touched.
  - `farLevels()` để lấy các mức ngoài vùng phủ đã chạm, dùng cho carry và status.
  - `sampleBook`: điều kiện `within` thành "trong vùng phủ **hoặc** thuộc touched"; ghi thêm `coverLow/coverHigh` vào mẫu.
  - Hàm thuần `applyDiffsToLevels(levels, diffs)` để áp buffer lên carry (test riêng).
- `apps/server/src/orderflow/collector.ts`
  - `resync(reason, { carry })`: chỉ carry khi lý do là `định kỳ` hoặc `gần mép vùng phủ` và `book.isSynced`. Lấy carry trước khi chụp, áp buffer (gồm cả diff stale) lên carry rồi truyền vào `applySnapshot`.
  - `takeSample()`: sau khi lấy mẫu, gọi `maybeEdgeResync(mid)` (hàm thuần `nearCoverEdge(mid, low, high, snapMid, pct)` export để test).
  - Lưu `snapMid` (mid lúc snapshot) để tính độ rộng từng phía. Lưu `lastResyncAt` và `lastResyncReason`.
- `apps/server/src/config.ts`: thêm `orderflowEdgeResyncPct` (35) và `orderflowEdgeResyncMinSec` (60); `app.ts` truyền vào collector.
- `apps/web/src/api/client.ts`: thêm field optional cho status (chỉ type, không đổi UI).
- Contract `packages/shared` không đổi: `BookSample` nằm ở server, schema analysis/level giữ nguyên.

## Implementation Steps
1. `localBook.ts`: touched set, carry trong `applySnapshot`, `sampleBook` mở rộng, `applyDiffsToLevels`.
2. Test pure logic trong `tests/orderflowBinance.test.ts`.
3. `collector.ts`: chạm mép thì snapshot lại, carry khi snapshot lại, status mới; config và `app.ts`.
4. Cập nhật SPEC.md mục 3.3 (vùng phủ, chạm mép, mức đã chạm, env mới).
5. Kiểm chứng: `npm run typecheck`, `npm run lint`, `npm test`; restart pm2 rồi xem log `gần mép vùng phủ` và `status.farLevels` với BTC thật.

## Tests / Acceptance
- Snapshot phủ [100, 110], diff thêm bid 90 = 500 thì mẫu có bucket 90 = 500. Mức 95 có trong sổ nhưng không nhận diff (giả lập) thì không xuất hiện.
- Diff đặt mức ngoài vùng phủ về 0 thì mức đó biến mất khỏi mẫu.
- Snapshot định kỳ mà vùng phủ mới không chứa 90 thì vẫn giữ 90 = 500. Diff trong buffer (kể cả stale) đổi 90 thành 300 thì kết quả 300.
- Snapshot sau khi mất chuỗi hoặc WebSocket rớt thì không giữ mức ngoài vùng phủ.
- `nearCoverEdge`: mid cách `coverLow` 30% độ rộng phía dưới thì true; 50% thì false. Chạm mép 2 lần trong 60s thì chỉ snapshot 1 lần.
- Mẫu JSON cũ (không có cover) vẫn đọc được, `findWalls/findWallSegments` cho kết quả như trước.
- Chạy thật: khi BTC đi xuống khoảng 300–400$ thì log có `gần mép vùng phủ` và `coverLow` dịch theo giá, không phải chờ 30 phút.

## Approval Status
Đã duyệt (2026-11-13).
