# Order flow Binance cho top coin

## Bối cảnh
Order flow Binance (collector sổ lệnh + aggTrade, tường, CVD, lệnh lớn, heatmap sổ lệnh, snapshot cho agent) hiện chỉ bật cho `BTCUSDT` (spot) và `XAUUSD` (futures `XAUUSDT`). Muốn bật thêm cho: **ETHUSDT, SOLUSDT, SUIUSDT, GRAMUSDT, XRPUSDT, BNBUSDT, NEARUSDT, LINKUSDT**.

Đã kiểm tra (14/11): cả 8 mã có trên Binance spot và USDⓈ-M futures (GRAMUSDT có cả hai).

## Requirements / Spec
1. Mặc định `ORDERFLOW_BINANCE_SYMBOLS` = `BTCUSDT,XAUUSD,ETHUSDT,SOLUSDT,SUIUSDT,GRAMUSDT,XRPUSDT,BNBUSDT,NEARUSDT,LINKUSDT` (env vẫn ghi đè được). Web, agent (`orderflow: true`), bot, snapshot dùng như BTC — không đổi luồng.
2. **Nguồn**: 8 coin mới dùng **futures cùng tên** (`ORDERFLOW_SOURCE_<SYM>=futures:<SYM>`). Lý do: chart của các mã này là Binance Futures → basis ≈ 0; với altcoin, thanh khoản futures lớn hơn spot nhiều. Futures chỉ snapshot được 1000 mức → chụp lại 5 phút/lần (`ORDERFLOW_RESYNC_MIN_<SYM>=5`, như vàng) để vùng phủ theo giá. BTC giữ spot như hiện tại.
3. **Ngưỡng theo mã** (bucket giá, lệnh lớn, hấp thụ, tường tối thiểu, offset dự phòng): đặt mặc định trong `config.ts`, env `ORDERFLOW_*_<SYM>` ghi đè. Cách chọn:
   - `bucket` ≈ 0,02% giá, làm tròn về 1/2/5 × 10ⁿ và ≥ tick size của sàn;
   - `bigTrade` (base) ≈ lệnh khớp gộp 1 giây ở phân vị 99,5 của aggTrade đo thực tế (BTC hiện 1 BTC ≈ 67k$);
   - `absorb` ≈ 8 × bigTrade (tỉ lệ như BTC);
   - `wallMin` ≈ phân vị 95 khối lượng mỗi bucket trong ±2% quanh giá đo từ sổ lệnh thực tế;
   - `offset` = 0 (futures cùng thị trường với chart).
   Số cụ thể đo bằng script `scripts/orderflow-calibrate.ts <SYMBOL>` (đọc depth + aggTrade công khai khoảng 10 phút), ghi bảng vào plan này và báo bạn trước khi restart.
4. **Tải**: mỗi mã futures 2 WebSocket + snapshot REST 5 phút/lần (weight 20 → tổng 8 mã ≈ 32 weight/phút, rất xa giới hạn 2400). Dung lượng `book_samples` ước ~50 MB/mã/24h (như vàng) → thêm ~400 MB trong DB (giữ 24h, dọn tự động). Nếu cần giảm: chỉ lấy mẫu trong ±`ORDERFLOW_SAMPLE_RANGE_PCT` quanh giá (mới, mặc định không giới hạn — chỉ thêm nếu dung lượng thực tế vượt ước tính).
5. Không đổi contract agent (`analysis.ts`), prompt, validator, quyền runner. Thanh lý (`LIQ_SYMBOLS`) và volume gộp (`VOLAGG_SYMBOLS`) **không** mở rộng ở plan này.

## Technical Design
- `apps/server/src/config.ts`: mở rộng mặc định `orderflowBinanceSymbols`, `orderflowSources`, `orderflowBuckets`, `orderflowBigTrade`, `orderflowAbsorb`, `orderflowWallMin`, `orderflowOffsets`, `orderflowResyncMinBySymbol`.
- `scripts/orderflow-calibrate.ts`: in gợi ý ngưỡng cho một symbol (không ghi DB).
- Kiểm tra định dạng giá nhỏ (SUI 0,77, XRP 0,98, GRAM 1,09): nhãn tường / heatmap / tóm tắt `get_orderflow` hiện đủ chữ số thập phân; sửa formatter nếu đang làm tròn theo kiểu BTC.
- `.env.example`, SPEC.md (bảng ngưỡng mặc định theo mã).

## Implementation Steps
1. Script calibrate → đo 8 mã → bảng ngưỡng.
2. Config mặc định + test config (mặc định đủ 10 mã, env ghi đè).
3. Rà formatter giá nhỏ (web nhãn tường/heatmap, tóm tắt MCP) + test với giá < 1.
4. `npm run typecheck`, `npm run lint`, `npm test`; chạy server tạm 15 phút với 8 mã: kiểm tra mỗi mã có `connected`, vùng phủ, tường hợp lý, dung lượng DB tăng theo ước tính; ảnh chart ETH/SUI có tường + heatmap bằng `scripts/screenshot.ts`.
5. Restart pm2 khi bạn đồng ý.

## Tests / Acceptance
- Unit: config mặc định, ghi đè env, formatter giá < 1.
- Thủ công: chọn SOLUSDT trên web → có tường order flow / heatmap sổ lệnh; phân tích SOLUSDT với order flow Binance → agent nhận snapshot (`get_orderflow`) đúng giá.

## Approval Status
Chờ duyệt.
