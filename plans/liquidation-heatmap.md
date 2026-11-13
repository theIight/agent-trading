# Thanh lý BTC: bong bóng thanh lý thật + heatmap mức thanh lý ước tính

## Bối cảnh
Người dùng chọn làm cả hai loại cho BTC (2026-11-12). Đã thử ngày 2026-11-12:
- `!forceOrder@arr` (đường `/market` của fstream) và kênh `liquidation-orders` của OKX nhận được dữ liệu, không cần key. Trong 45 giây thị trường yên có 38 lệnh cho mọi symbol, BTC không có lệnh nào.
- `futures/data/openInterestHist` của Binance có OI 5 phút, lấy được tối đa 30 ngày quá khứ.

## Requirements / Spec

### A. Thanh lý thật (bong bóng)
1. **Nguồn:**
   - Binance Futures `wss://fstream.binance.com/market/ws/!forceOrder@arr`, lọc BTCUSDT. Field `S=SELL` nghĩa là long bị thanh lý; khối lượng `z`, giá `ap`, thời gian `T`.
   - OKX `wss://ws.okx.com:8443/ws/v5/public`, kênh `liquidation-orders` (instType SWAP), lọc `BTC-USDT-SWAP`. `posSide`/`side` cho biết long hay short; khối lượng `sz` × 0,01 BTC; giá `bkPx`; thời gian `ts`.
   - Symbol bật theo `LIQ_SYMBOLS` (mặc định `BTCUSDT`). Map symbol theo `LIQ_OKX_INST_<SYMBOL>` (mặc định BTCUSDT → `BTC-USDT-SWAP`, hệ số hợp đồng 0,01).
2. **Lưu trữ:** SQLite bảng `liquidations(symbol, venue, t, side, price, qty)`, giữ `LIQ_RETAIN_H` giờ (mặc định 72). Giá Binance futures và OKX swap dùng thẳng, không quy đổi: chart là Binance futures, OKX chỉ lệch vài $.
3. **Gộp:** các lệnh cùng giây, cùng phía, cùng sàn gộp thành một (giá VWAP).
4. **Chart:**
   - Hình tròn tại (thời gian, giá): long bị thanh lý màu đỏ, short bị thanh lý màu xanh. Bán kính theo căn bậc hai của khối lượng, từ 3 đến 18 px.
   - Chỉ vẽ cụm ≥ `LIQ_MIN_QTY_<SYMBOL>` (BTC mặc định 0,5 BTC). Khi gộp theo nến của khung đang xem, cụm phải ≥ ngưỡng × (độ dài khung / 1 phút)^0,5.
   - Gộp theo nến của khung đang xem để không rối.
   - Có toggle "Thanh lý", trạng thái nhớ trong localStorage.
5. **Giới hạn ghi rõ:**
   - Binance chỉ đẩy lệnh thanh lý cuối cùng mỗi giây cho mỗi symbol, nên con số luôn thấp hơn thực tế.
   - Không có lịch sử trước khi server chạy.
   - Tooltip/ghi chú dưới toggle: "Thanh lý đã xảy ra (Binance + OKX, Binance đếm thiếu)".

### B. Heatmap mức thanh lý ước tính (mô hình)
1. **Dữ liệu:**
   - OI 5 phút của Binance BTCUSDT (`openInterestHist`, lần đầu tải 30 ngày, sau đó poll mỗi 5 phút), lưu SQLite bảng `open_interest(symbol, t, oi)`.
   - Nến 5m futures (giá, taker buy) lấy qua `KlineService` hoặc fapi.
2. **Mô hình** (pure, chỉnh qua config):
   - Mỗi bước 5 phút, ΔOI = OI(t) − OI(t−1).
   - **ΔOI > 0:** vị thế mới mở ở giá điển hình của nến (HLC/3). Mỗi hợp đồng mới có một long và một short. Coi phía chủ động là phía "mới vào lệnh có đòn bẩy":
     - long mới = ΔOI × tỷ lệ mua chủ động;
     - short mới = ΔOI × (1 − tỷ lệ mua chủ động).
   - **Phân bố đòn bẩy** `LIQ_LEVERAGE` mặc định `10:0.3,25:0.3,50:0.25,100:0.15`; ký quỹ duy trì `LIQ_MMR` mặc định 0,004.
     - Giá thanh lý long = giá vào × (1 − 1/L + MMR).
     - Giá thanh lý short = giá vào × (1 + 1/L − MMR).
     - Gom theo bucket `LIQ_BUCKET_<SYMBOL>` (BTC 50$).
   - **ΔOI < 0:** mọi mức còn mở giảm theo tỷ lệ |ΔOI| / OI.
   - **Giá chạm mức** (low ≤ mức long, high ≥ mức short): xoá mức đó, vì coi như đã bị thanh lý.
3. **Đầu ra cho chart:** lưới thời gian × giá. Mỗi cột là trạng thái các mức đang mở tại cuối khoảng.
   - Độ dài cột = max(5 phút, khung đang xem); tối đa 600 cột gần nhất.
   - Chỉ gửi ô có giá trị ≥ 2% ô lớn nhất, cường độ lượng tử hoá 0–255.
   - Server tính lại khi có OI mới (5 phút/lần) và cache theo (symbol, độ dài cột).
4. **Chart:**
   - Dải màu phía sau nến, thang tím → vàng giống heatmap, độ đậm theo cường độ, mờ để không che nến.
   - Có toggle "Heatmap thanh lý" (mặc định tắt) và chú thích "ước tính".
   - Khung 1m dùng cột 5 phút (thô hơn nến).
5. **Giới hạn ghi rõ:**
   - Là mô hình: phân bố đòn bẩy là giả định; không biết vị thế nào đóng; không tính hedge, ký quỹ chéo hay funding. Sai số có thể vài trăm $.
   - Chỉ dùng OI của Binance (OKX để sau).

### C. Agent
- `get_orderflow` (khi phân tích BTC có bật order flow Binance) thêm hai mục:
  - **Thanh lý 24h:** tổng long/short bị thanh lý theo sàn, 5 cụm lớn nhất (giờ, giá, khối lượng), cụm trong 4 giờ gần nhất.
  - **Heatmap ước tính:** 3 vùng mức thanh lý dày nhất phía trên và 3 phía dưới giá hiện tại (khoảng giá, khối lượng ước tính, phía long/short), kèm cảnh báo "ước tính".
- Prompt: thanh lý dồn dập ở đáy hoặc đỉnh ủng hộ SC/BC/Spring/UTAD. Vùng heatmap dày là thanh khoản có thể bị săn (nam châm hút giá), chỉ dùng để xác nhận hoặc đặt mục tiêu tham khảo, không làm toạ độ entry/SL/TP.
- Agent không nộp gì thêm; contract `submit_analysis` không đổi.
- Snapshot lưu kèm file `<id>-orderflow.json`. Panel kết quả hiện thêm hai dòng tóm tắt.

## Technical Design
- **Contract** `packages/shared`:
  - `LiquidationEvent {t, venue: 'binance'|'okx', side: 'LONG'|'SHORT', price, qty}`;
  - `LiquidationHeatmap {colSec, bucket, cols: number[] (t), cells: [colIdx, price, intensity][], maxQty, asOf}`.
- **Server** `apps/server/src/liquidation/`:
  - `collector.ts`: 2 WebSocket với reconnect và backoff; OKX cần ping mỗi 25 giây; ghi DB.
  - `oi.ts`: tải và lưu OI.
  - `model.ts`: pure `buildLiqLevels` và `heatmapGrid`, có test.
  - `service.ts`: cache và tóm tắt.
- **API:**
  - `GET /api/liquidations/:symbol?tf=` → `{events (gộp theo nến tf, 24–72h tuỳ tf), heatmap, notes}`;
  - `/api/config.liquidation = {symbols}`.
- **Web:**
  - `useLiquidationStore` poll 15 giây (heatmap 60 giây);
  - primitive `LiqBubblePrimitive` (zOrder top) và `LiqHeatmapPrimitive` (zOrder bottom, vẽ canvas theo `timeToCoordinate`/`priceToCoordinate`);
  - 2 toggle trong `LayerToggles`.
- **Config:** `LIQ_SYMBOLS`, `LIQ_OKX_INST_<SYMBOL>`, `LIQ_MIN_QTY_<SYMBOL>`, `LIQ_BUCKET_<SYMBOL>`, `LIQ_LEVERAGE`, `LIQ_MMR`, `LIQ_RETAIN_H`.
- SPEC, README, `.env.example`, prompt cập nhật.

## Implementation Steps
1. Contract.
2. Model heatmap (pure) + test:
   - ΔOI dương tạo mức long/short đúng giá theo từng đòn bẩy;
   - ΔOI âm giảm theo tỷ lệ;
   - giá chạm thì xoá;
   - lưới cột và ngưỡng 2%.
3. Collector thanh lý + test parse Binance/OKX (side, đơn vị hợp đồng), gộp theo giây, lưu DB.
4. OI loader: lần đầu 30 ngày, sau đó tải tăng dần.
5. API + tóm tắt cho agent + prompt.
6. Web: 2 primitive, toggle, store.
7. typecheck, lint, test; chạy thật: heatmap 30 ngày hiện ngay trên BTC 15m/1H; bong bóng xuất hiện khi có thanh lý (có thể phải đợi lúc giá chạy mạnh). Chụp ảnh.

## Tests / Acceptance
- Heatmap BTC 1H hiện dải mức thanh lý trên và dưới giá; mức đã bị giá quét thì biến mất ở các cột sau.
- Bong bóng thanh lý thật khớp thời gian/giá với nến, đúng màu theo phía.
- Mất kết nối một sàn: ghi chú rõ, không lỗi.
- Agent nhận tóm tắt thanh lý + heatmap trong `get_orderflow`; order flow BTC hiện tại không đổi.
- Hiệu năng: tính heatmap 30 ngày dưới 1 giây; chart vẫn mượt khi bật heatmap.

## Ghi chú triển khai
- `openInterestHist` chỉ có `startTime` thì trả 500 điểm MỚI NHẤT → phải truyền cả `startTime` + `endTime` khi phân trang. Lần đầu tải 8351 điểm (29 ngày).
- Thang màu: tuyến tính theo ô lớn nhất thì gần như một màu (trung vị cường độ 47/255) → cường độ theo **phân vị 99** (kẹp 255), chỉ gửi ô ≥ phân vị 60. Payload 0,2–0,9 MB tuỳ khung; client gửi `heatmapAsOf`, server không gửi lại heatmap nếu chưa có OI mới (poll 15s chỉ còn bong bóng).
- Độ đậm heatmap 8–45% để không che nến.
- Bong bóng đã kiểm tra bằng 2 dòng giả chèn tạm vào DB (đã xoá ngay); thị trường yên 1 giờ đầu chỉ ghi được 1 lệnh BTC (0,006 BTC, Binance).
- Panel kết quả: mục "Thanh lý + heatmap ước tính lúc phân tích" (thu gọn) từ `orderflow.liquidation`.

## Approval Status
Đã duyệt (2026-11-12, "ok").
