# Order flow vàng từ Binance Futures XAUUSDT perp

## Bối cảnh
- Chart vàng là symbol `XAUUSD`. Nguồn giá mặc định `tiingo-okx`: giá Tiingo, volume OKX. Order flow vàng hiện chỉ có ảnh Bookmap người dùng chụp.
- XAUUSD giao ngay không có sổ lệnh tập trung. Người dùng chọn **Binance Futures XAUUSDT perp** (2026-11-12): miễn phí, có sổ lệnh và lệnh khớp như BTC.
- Số liệu đo ngày 2026-11-12:
  - 24h ≈ 1,75 tỷ $ (436k oz), khoảng 2% khối lượng COMEX.
  - Ảnh chụp sổ lệnh `fapi/v1/depth` tối đa 1000 mức, chỉ phủ khoảng ±13$ quanh giá.
  - Gom theo bucket 1$: trung vị 258 oz, p90 419 oz, lớn nhất 870 oz.
  - Một lệnh aggTrade: p50 0,06 oz, p99 24 oz, lớn nhất 51 oz trong khoảng 100 giây.

## Requirements / Spec
1. Mọi tính năng order flow của BTC áp dụng cho vàng: tường, lịch sử tường, POC/HVN/LVN, hấp thụ, CVD, lệnh lớn, vẽ sẵn trên chart (poll 15 giây), toggle Order flow, checkbox "Dùng order flow Binance" ở panel, tool MCP `get_orderflow`, `orderflowSource = BINANCE`.
2. **Nguồn**: Binance USDⓈ-M Futures, symbol `XAUUSDT`, đơn vị oz.
   - WebSocket `<sym>@depth@100ms` và `<sym>@aggTrade`.
   - Ảnh chụp REST `fapi/v1/depth?limit=1000`.
   - Đồng bộ sổ lệnh theo quy trình futures:
     - bỏ các event có `u` < `lastUpdateId`;
     - event đầu tiên phải thoả `U ≤ lastUpdateId ≤ u`;
     - mỗi event sau đó phải có `pu` bằng `u` của event trước, sai thì đồng bộ lại.
3. **Map symbol**: symbol trên chart `XAUUSD` lấy dữ liệu nguồn `XAUUSDT`, cấu hình bằng `ORDERFLOW_SOURCE_XAUUSD=futures:XAUUSDT`. BTC giữ `spot:BTCUSDT` như hiện tại, không đổi hành vi.
4. **Phạm vi giá**: vùng mỗi lần lấy mẫu = vùng ảnh chụp REST phủ được tại lần đồng bộ gần nhất, khoảng ±13$.
   - Muốn phủ rộng hơn thì đặt `ORDERFLOW_RESYNC_MIN_XAUUSD` nhỏ, mặc định 5 phút (khi làm hạ từ 10 xuống 5 vì vàng đi 5–20$ trong 10 phút). Đồng bộ lại sẽ chụp sổ lệnh mới quanh giá hiện tại.
   - Không dùng các mức nằm ngoài vùng ảnh chụp, vì chúng chỉ đến từ luồng cập nhật và không đáng tin.
   - Agent và panel ghi rõ "sổ lệnh chỉ phủ ±N$ quanh giá".
5. **Quy đổi giá**: basis = trung vị 60 phút của `close XAUUSDT − close chart XAUUSD` cùng phút, giống BTC.
   - Nến chart lấy qua `KlineService` (`XAUUSD`, 1m, closedOnly), dùng đúng nguồn chart đang chạy.
   - Thiếu dữ liệu → dùng `ORDERFLOW_OFFSET_XAUUSD` (mặc định 0) kèm ghi chú.
   - Nếu `XAUUSD_SOURCE=binance` thì chart vốn là XAUUSDT, basis ≈ 0.
   - Cuối tuần thị trường đóng: không có nến mới thì giữ basis cuối.
6. **Ngưỡng mặc định** (sẽ hiệu chỉnh lại theo dữ liệu 24h thật trước khi chốt):
   - bucket 1$;
   - tường: tối thiểu 500 oz;
   - lệnh lớn: tổng lệnh chủ động trong 1 giây cùng phía ≥ 50 oz;
   - hấp thụ: 300 oz;
   - tất cả chỉnh được qua `ORDERFLOW_*_XAUUSD`.
7. **Ảnh Bookmap vàng** vẫn giữ: nếu người dùng tải ảnh lên thì agent nhận cả ảnh lẫn order flow Binance. Hiện symbol đã bật Binance bị loại khỏi danh sách Bookmap. Với vàng, **giữ cả hai**: checkbox Binance và phần ảnh Bookmap đều hiện.
8. **Thị trường đóng** (cuối tuần, nghỉ hằng ngày khoảng 1 giờ): collector vẫn chạy. Khoảng sổ lệnh không đổi thì không tính là mất dữ liệu. Không có lệnh khớp thì CVD bằng 0.
9. Prompt agent: thêm lưu ý rằng XAUUSDT perp là dòng lệnh của trader crypto, chỉ khoảng 2% COMEX, nên chỉ dùng để xác nhận và ưu tiên cấu trúc giá.

## Technical Design
- `config.ts`:
  - `orderflowBinanceSymbols` mặc định `BTCUSDT,XAUUSD`;
  - thêm `orderflowSources` (symbol → `{ market: 'spot' | 'futures', symbol }`), mặc định `BTCUSDT → spot:BTCUSDT`, `XAUUSD → futures:XAUUSDT`;
  - thêm giá trị mặc định cho XAUUSD vào `orderflowBuckets`, `WallMin`, `BigTrade`, `Absorb`, `Offsets`; `orderflowResyncMin` cho chỉnh theo từng symbol.
- `localBook.ts`: thêm chế độ đồng bộ `futures` (kiểm tra `pu`). Logic thuần, có test.
- `collector.ts`:
  - nhận `market` và `sourceSymbol`, chọn REST/WS theo market;
  - URL WS futures phải kiểm chứng thật, vì `/ws` cũ không gửi dữ liệu còn `/market/ws` thì có (bài học từ `liveFeed`);
  - dữ liệu lưu SQLite theo symbol chart (`XAUUSD`).
- `binanceOrderflow.ts`:
  - nến nguồn lấy theo market (`api/v3/klines` hoặc `fapi/v1/klines`);
  - `futuresCandles` đổi tên thành `chartCandles(symbol)`: giá chart lấy qua `KlineService` cho mọi symbol, với BTC chính là nến futures BTCUSDT như hiện tại;
  - chú thích nguồn (`venue`) ghi "Binance Futures XAUUSDT perp".
- `format.ts`: dòng quy đổi ghi "giá nguồn" thay cho "spot"; thêm phạm vi sổ lệnh.
- Service: chỉ bỏ ảnh Bookmap khỏi symbol đã bật Binance khi symbol đó không có cấu hình ảnh Bookmap. Như vậy vàng giữ cả hai, BTC giữ như cũ.
- Web: không cần thay đổi lớn, vì UI đọc `orderflowSymbols` từ server. Kiểm tra lại độ dày vạch và nhãn với đơn vị oz.
- SPEC, README, `.env.example`, `prompts/wyckoff.md` cập nhật.

## Implementation Steps
1. Contract: kiểm tra `venue`/`unit` đủ dùng, thêm `sourceMarket` nếu cần.
2. `localBook` chế độ futures + test (event đầu, `pu` không khớp → đồng bộ lại).
3. Config, collector, BinanceOrderflow theo market + test (map symbol, basis với nến chart, dùng offset dự phòng).
4. Chạy thật: kiểm tra URL WS futures; thu dữ liệu ≥ 30 phút; hiệu chỉnh ngưỡng; kiểm tra basis so với giá Tiingo.
5. Service/panel giữ ảnh Bookmap cho vàng; cập nhật prompt và tài liệu.
6. typecheck, lint, test; chụp chart vàng 15m/1H có vạch order flow và panel.

## Tests / Acceptance
- Order flow BTC không đổi (các test cũ xanh, basis vẫn khoảng 33).
- `GET /api/orderflow/XAUUSD` báo collector đang chạy, có mẫu sổ lệnh mỗi 10 giây.
- Vạch tường vàng nằm khớp giá chart (lệch < 2$). Tường đã kết thúc giữ nguyên giá.
- Chạy phân tích vàng có bật order flow Binance và có ảnh Bookmap: agent nhận cả hai; kết quả có `orderflowSource = BINANCE`.
- Cuối tuần, hoặc khi không có lệnh khớp: không lỗi, ghi chú rõ.

## Ghi chú triển khai
- WebSocket futures tách đường: sổ lệnh ở `/public/stream`, lệnh khớp ở `/market/stream` (đã thử thật: `/stream` chỉ có sổ lệnh, `/market` chỉ có lệnh khớp) → collector futures mở 2 socket.
- **Khác mục 7**: contract hiện tại chỉ có một `orderflow.source` cho mỗi phân tích, nên vàng hiện **cả hai checkbox nhưng mỗi phân tích chọn một nguồn**; chọn ảnh Bookmap thì checkbox Binance bị khoá. Gộp cả hai vào một phân tích cần đổi contract (chờ người dùng quyết).
- Hiệu chỉnh sau 32 phút dữ liệu thật: bucket 1$ trung vị 257 oz, p90 426, p99 811, max 970 → giữ tường 500 oz (điều kiện 3× trung vị ≈ 750 oz mới là ngưỡng thực); lệnh lớn ≥ 50 oz ra 93 lần/giờ (BTC 54) → nâng lên **80 oz** (≈ 32 lần/giờ); hấp thụ giữ 300 oz.
- Basis đo thật lúc chạy: 7,11 (XAUUSDT 3968,24, chart Tiingo 3961,05).

## Approval Status
Đã duyệt (2026-11-12, "ok").
