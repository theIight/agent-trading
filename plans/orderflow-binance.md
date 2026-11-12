# Order flow từ dữ liệu Binance (thay ảnh Bookmap cho BTC)

## Bối cảnh & kết quả nghiên cứu (2026-11-12)

Hiện agent đọc order flow từ ảnh Bookmap (`plans/bookmap.md`): agent tự đọc số trên ảnh (dễ sai), phải quy đổi offset, ảnh có thể cũ. Bookmap BTC lấy dữ liệu từ chính API công khai của Binance, nên server có thể tự lấy dữ liệu gốc thay vì đọc ảnh.

Đã thử API công khai thật (không cần key):

| Nguồn | Kết quả |
|---|---|
| `GET api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=5000` (spot) | 5000 mức mỗi phía, phủ khoảng ±1.5% (±1.100$). Tường lớn nhất: 73000 có 56 BTC |
| `GET fapi.binance.com/fapi/v1/depth?limit=1000` (futures BTC) | Chỉ phủ khoảng ±140$, quá hẹp để tìm tường |
| `fapi … XAUUSDT` (perp vàng) | Có, volume 24h khoảng 1,7 tỷ $, nhưng 1000 mức chỉ phủ ±12$. **Không phải COMEX** |
| klines 1m spot | Có sẵn `takerBuyBaseVolume` → tính delta/CVD và volume profile không cần stream |
| `aggTrades` REST | 1000 lệnh chỉ khoảng 3,5 phút → không backfill cả ngày bằng REST được |

**Đính chính đoạn trích người dùng gửi:** Binance miễn phí dữ liệu realtime là đúng. Nhưng API công khai **không có lịch sử sổ lệnh**, chỉ có snapshot hiện tại cộng stream thay đổi. Bản đồ nhiệt (tường đã tồn tại bao lâu, có bị rút không) phải do server **tự ghi liên tục** từ lúc chạy. Lịch sử giao dịch thì có (klines, aggTrades).

**Vàng:** Binance không có dữ liệu GC/COMEX. XAUUSDT perp là một thị trường khác (thanh khoản crypto), sổ lệnh mỏng và hẹp. → Vàng **giữ ảnh Bookmap** như hiện tại.

## Requirements / Spec

1. Với BTCUSDT, server tự tính order flow từ Binance spot (khớp với Bookmap BTCUSDT@BN người dùng đang xem), không cần ảnh.
2. Agent nhận một bản tóm tắt gọn (không gửi dữ liệu thô): tường lớn kèm thời gian tồn tại, POC/HVN/LVN, CVD, lệnh lớn gần đây.
3. Mức giá do server tính nên **không phải cấu hình offset (server tự đo basis spot/futures), không có cảnh báo ảnh cũ, không phải tin số agent đọc**. Agent chỉ nhận xét định tính và chọn mức nào đáng dùng; giá giữ nguyên số server đưa.
4. Giữ nguyên các nguyên tắc của bản ảnh: mức order flow chỉ để tham khảo/vẽ, không dùng đặt lệnh, không làm đổi entry/SL/TP hay R:R. Chỉ dùng nến/dữ liệu đã đóng tới thời điểm gửi.
5. Chart vẽ như mục 8 của `plans/bookmap.md` (vạch mờ 30%, nhãn số lượng).
6. UI: với BTC, checkbox đổi thành "Dùng order flow Binance" và hiện trạng thái collector (đang ghi từ lúc nào, đủ bao nhiêu phút lịch sử). Vàng giữ nguyên "Dùng ảnh Bookmap".

## Technical Design

### Collector sổ lệnh (`apps/server/src/orderflow/bookCollector.ts`)
- Chạy nền trong server cho mỗi symbol trong `ORDERFLOW_BINANCE_SYMBOLS` (mặc định `BTCUSDT`).
- Theo đúng quy trình đồng bộ local book của Binance: mở stream `<sym>@depth@100ms`, gọi snapshot REST `limit=5000`, áp các diff theo `U/u`; mất chuỗi → snapshot lại. Tự kết nối lại khi rớt (WS Binance tự đóng sau 24 giờ).
- Mỗi `ORDERFLOW_SAMPLE_SEC` (mặc định 10s) gom sổ lệnh theo bucket giá (`ORDERFLOW_BUCKET_BTCUSDT`, mặc định 10$) và lưu mẫu vào ring buffer trong bộ nhớ, đồng thời ghi SQLite bảng `book_samples` (giữ `ORDERFLOW_RETAIN_H`, mặc định 24 giờ) để restart pm2 không mất lịch sử.
- Stream `<sym>@aggTrade`: giữ các lệnh khớp lớn (≥ ngưỡng theo phân vị) trong 24 giờ.
- Rate limit: snapshot 5000 tốn weight 250/6000 phút, chỉ gọi khi khởi động hoặc mất đồng bộ.

### Tính toán thuần (`packages/shared/src/orderflowCalc.ts` hoặc `apps/server/src/orderflow/calc.ts`, có test)
- **Tường:** bucket có size ≥ `k × median` của các bucket trong ±X% quanh giá, và **tồn tại ≥ N% số mẫu trong 30–60 phút gần nhất** (lọc tường ảo/spoof). Báo `size` hiện tại, `persistMin`, đã bị khớp/rút một phần chưa.
- **Volume profile, POC/HVN/LVN:** từ klines 1m spot (`volume`) của phiên/24 giờ, phân bổ volume vào bucket giá.
- **CVD:** cộng dồn `2×takerBuy − volume` theo nến 1m; trả xu hướng và phân kỳ với giá (giá tạo đỉnh mới nhưng CVD không).
- **Hấp thụ:** vùng khối lượng lớn từ aggTrades mà giá gần như không đi tiếp (điều kiện cụ thể chốt khi code, có test).
- Kết quả dùng lại kiểu `Orderflow` hiện có (`levels` với `price` = giá thật, `offset = 0`, `sizeSource` thêm `BOOK` cho tường từ sổ lệnh), nên renderer chart không đổi.

### Contract (`packages/shared/src/analysis.ts`)
- `ORDERFLOW_SIZE_SOURCES` thêm `BOOK` (và `TRADES` cho hấp thụ/lệnh lớn).
- `AnalysisRecord` thêm `orderflowSource?: 'bookmap-image' | 'binance'`.
- Với nguồn `binance`: **server tự gắn** `orderflow.levels` đã tính vào kết quả; agent chỉ nộp `orderflow.summary` (và có thể chọn bớt mức). Validator bỏ mọi giá agent tự đặt cho mức Binance.

### MCP
- Tool mới `get_orderflow` (chỉ đọc): trả bản tóm tắt cắt tại thời điểm gửi phân tích, tối đa ~12 mức + CVD + 5 lệnh lớn. Không dùng file/shell, không đổi quyền runner.
- `get_analysis_request` cho biết nguồn order flow (`bookmap-image` | `binance` | không có).

### Prompt
- `prompts/wyckoff.md`: thêm mục cách đọc order flow Binance (tường có thời gian tồn tại; tường mới xuất hiện dễ là spoof; dùng CVD để xác nhận test/spring/upthrust). Nhắc rằng không cần quy đổi giá.

## Implementation Steps
1. Contract + kiểu dữ liệu.
2. Hàm tính thuần (tường, profile, CVD, hấp thụ) + test bằng dữ liệu giả lập.
3. Collector WS/REST + bảng SQLite + test đồng bộ diff (`U/u`, mất chuỗi → resync) bằng WS giả.
4. Tích hợp service/MCP/validator; BTC dùng Binance, vàng giữ ảnh.
5. UI: checkbox và trạng thái collector.
6. Cập nhật SPEC, README, `.env.example`.
7. Kiểm chứng: typecheck, lint, test; để collector chạy ≥ 30 phút, so tường tìm được với ảnh Bookmap `~/ssd/live1.png`/`live2.png` cùng thời điểm; chạy thật một phân tích BTC bằng Claude và chụp ảnh chart.

## Tests / Acceptance
- Local book khớp snapshot REST sau khi áp diff (sai lệch 0 ở top 20 mức).
- Tường ở giá tròn (vd 73000, 56 BTC lúc thử) xuất hiện với `persistMin` đúng; tường chỉ tồn tại 1–2 mẫu bị loại.
- So với ảnh Bookmap cùng lúc: các tường lớn nhất trùng giá (±1 bucket).
- Restart server không mất lịch sử đã ghi.
- Phân tích BTC không cần ảnh, không có cảnh báo offset/ảnh cũ; entry/SL/TP và R:R không bị ảnh hưởng bởi order flow.

## Rủi ro / giới hạn
- Lịch sử heatmap chỉ có từ lúc collector chạy; mới khởi động thì tường chưa có `persistMin` đáng tin (UI và tóm tắt sẽ ghi rõ).
- Chỉ là sổ lệnh Binance spot; thanh khoản futures và sàn khác không có (giống Bookmap BTCUSDT@BN hiện tại).
- Server phải luôn chạy (pm2 đã lo).

## Câu hỏi mở
- Có muốn thêm XAUUSDT perp của Binance làm nguồn phụ cho vàng không? Đề xuất: **chưa**, vì không phải COMEX và sổ lệnh mỏng.
- Chart của app dùng giá BTC **futures**, collector dùng **spot**. Lúc thử, spot 73844 còn futures 73810, lệch khoảng 34$ (hơn 3 bucket). Đề xuất: server đo basis spot − futures ngay lúc gửi (từ 2 giá cuối) rồi quy đổi tự động, không cần người dùng cấu hình offset. Cách khác là lấy sổ lệnh futures, nhưng snapshot chỉ phủ ±140$.

## Ghi chú triển khai (2026-11-12)
- Code: `apps/server/src/orderflow/` (`localBook.ts`, `collector.ts`, `calc.ts`, `binanceOrderflow.ts`, `format.ts`); test `tests/orderflowBinance.test.ts`.
- Contract: `orderflowLevelSchema.image`/`bookmapPrice` thành optional (validator Bookmap vẫn bắt buộc, thiếu thì bỏ mức); thêm `sourcePrice`, `persistMin`; `orderflow.source/asOf/historyMin`; `sizeSource` thêm `BOOK`, `VOLUME`, `TRADES`; `AnalysisRecord.orderflowSource`.
- Symbol bật Binance bị loại khỏi danh sách Bookmap (BTC không còn tick ảnh); `ORDERFLOW_BINANCE_SYMBOLS=` rỗng để quay lại.
- Cửa sổ tính tường 4 giờ mẫu gần nhất. Basis đo tự động (spot mid − close 1m của chart).
- Thử thật 40 giây với Binance: đồng bộ OK, mẫu ~3 KB (111 bucket bid / 115 ask), tường 73000 = 57,8 BTC khớp REST, basis 31,3.

## Approval Status
Đã duyệt (2026-11-12, "commit và action theo plan").
