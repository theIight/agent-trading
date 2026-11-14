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
Đã duyệt (2026-11-14, "hãy xử lý 4 plan đấy"). Nhánh `feat/alerts-orderflow-layout`.

## Ghi chú triển khai
### Bảng ngưỡng đo được (14/11/2026, `npx tsx scripts/orderflow-calibrate.ts <SYMBOL> 60`)
Nguồn: Binance USDⓈ-M futures công khai (exchangeInfo tick, depth 1000 mức, aggTrades ~60 phút qua REST, nghỉ 1s giữa request). BTCUSDT futures chỉ để tham chiếu (BTC giữ spot, ngưỡng cũ).

| Symbol | Giá | Tick | Bucket | Lệnh lớn (p99,5/giây) | ≈ USD | Hấp thụ (8×) | Tường tối thiểu (p95 bucket ±2%) | ≈ USD | aggTrade đo | Sổ 1000 mức phủ |
|---|---|---|---|---|---|---|---|---|---|---|
| ETHUSDT | 1899 | 0.01 | 0.5 | 340 | 646k | 2 700 | 2 100 | 4,0M | 37 049 / 60′ | ±0,6% |
| SOLUSDT | 75.49 | 0.01 | 0.02 | 2 300 | 174k | 18 000 | 17 000 | 1,3M | 8 560 / 60′ | ±13% |
| SUIUSDT | 0.7689 | 0.0001 | 0.0002 | 49 000 | 38k | 390 000 | 230 000 | 177k | 4 448 / 60′ | −16/+14% |
| GRAMUSDT | 1.0905 | 0.001 | 0.001 (tick) | 15 000 | 16k | 120 000 | 59 000 | 64k | 1 637 / 60′ | −99/+215% |
| XRPUSDT | 0.9856 | 0.0001 | 0.0002 | 99 000 | 98k | 790 000 | 420 000 | 414k | 8 649 / 60′ | ±10% |
| BNBUSDT | 615.2 | 0.01 | 0.1 | 76 | 47k | 610 | 410 | 252k | 10 553 / 60′ | ±1,8% |
| NEARUSDT | 3.3165 | 0.001 | 0.001 (tick) | 14 000 | 46k | 110 000 | 51 000 | 169k | 3 992 / 60′ | −36/+31% |
| LINKUSDT | 9.5955 | 0.001 | 0.002 | 1 800 | 17k | 14 000 | 21 000 | 202k | 3 180 / 60′ | −18/+15% |
| (BTCUSDT futures) | 67099 | 0.1 | 10 | 13 | 872k | 100 | 57 | 3,8M | 40 000 / 49′ | ±0,2% |

Offset = 0, resync 5 phút cho cả 8 mã. Lệnh lớn trên futures (p99,5) lớn hơn nhiều so với BTC spot (1 BTC) vì thanh khoản futures dày hơn — giữ đúng quy tắc phân vị; chỉnh qua env nếu thấy quá ít/nhiều lệnh lớn.

### Định dạng giá nhỏ
Trước đây nhiều chỗ làm tròn giá 2 chữ số kiểu BTC: khoá bucket trong mẫu sổ lệnh (`roundQty` 3 chữ số → SUI bucket 0.0002 bị gộp về 0.77), mid, VWAP lệnh lớn, profile/value area, basis, `toApp`, giá `wallSegments`, `shift` heatmap, tóm tắt `get_orderflow`, ghi chú "phủ ±N", dòng trạng thái "sổ lệnh phủ ±N$" trên web. Đã thay bằng `roundPrice` / `bucketFloor` / `cleanPrice` (`packages/shared/src/orderflow.ts`); BTC/vàng giữ 2 chữ số. Nhãn khối lượng tường rút gọn K/M khi ≥ 10 000.

### Server tạm (14/11, PORT 8792, DB tạm, Telegram/LIQ/VOLAGG tắt)
- Cả 10 collector `connected/synced`; resync định kỳ 5 phút chạy ("định kỳ"); GRAMUSDT có 1 lần "mất chuỗi update" → tự snapshot lại. Vùng phủ snapshot futures: ETH ±0,6%, BNB ±1,8%, XRP ±10%, SOL ±13%, SUI ±15%, LINK ±16%, NEAR ±33%, GRAM ±157%.
- **Dung lượng vượt ước tính** khi không giới hạn vùng lấy mẫu (lần chạy 1, ~1 phút): ~15–23 KB/mẫu cho SOL/SUI/GRAM/XRP/NEAR/LINK (sổ 1000 mức phủ ±10–30%, bucket ≈ tick) → 130–200 MB/24h/mã, ~1,1 GB cho 8 mã. Theo mục Requirements 4 đã thêm `ORDERFLOW_SAMPLE_RANGE_PCT` (mặc định 0 = không giới hạn) + `ORDERFLOW_SAMPLE_RANGE_PCT_<SYMBOL>`, **8 top coin mặc định ±3%** (BTC/vàng không đổi).
- Lần chạy 2 (±3%, 14 phút, 84 mẫu/mã): KB/mẫu XRP 5,1 · BNB 4,9 · LINK 4,5 · SUI 3,9 · ETH 3,7 · SOL 3,6 · NEAR 2,8 · GRAM 1,1 (BTC 7,8, vàng 2,1) → ~30 KB/lượt cho 8 mã ≈ 260 MB JSON/24h (~32 MB/mã, trong ước tính 50 MB/mã). Lệnh lớn trong 14 phút: ETH 24, BNB 8, SOL 6, NEAR 3, SUI 2, XRP/LINK/GRAM 0.
- Ảnh chụp SUI (tường `A 324.6K` 0.792, `B 344.1K` 0.760, "sổ lệnh phủ ±0.1142") và ETH (tường + heatmap sổ lệnh) hiển thị đúng.
