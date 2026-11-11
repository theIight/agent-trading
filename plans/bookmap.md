# Plan — Đọc ảnh Bookmap (order flow) cho XAUUSD và BTCUSDT

## Approval Status

- [x] Đã duyệt (2026-11-11). Đã thống nhất (2026-11-11): offset vàng mặc định **10**, app tự kiểm tra; lệch nhiều thì coi là **ảnh cũ**. Làm trên nhánh `feat/bookmap`, không push lên `main`.

## 1. Bối cảnh

- Người dùng chụp Bookmap 2 khung cho mỗi symbol: **khung lớn** (zoom rộng, nhiều giờ) và **khung bé** (zoom hẹp).
  - Vàng: `GCZ6.COMEX`, hợp đồng tương lai, giá **cao hơn XAUUSD spot** khoảng 10 (basis, đổi theo ngày, nhảy khi roll sang GCG7).
  - BTC: `BTCUSDT@BN` (Binance spot); app dùng Binance Futures, chênh nhỏ.
- Thông tin đọc được: trục giá, cột **COB** (sổ lệnh hiện tại), **SVP** (volume profile, POC), heatmap (dải thanh khoản nằm lâu), bong bóng lệnh market lớn, **CVD**.
- Hạn chế:
  - Ảnh là ảnh chụp tại một thời điểm. Heatmap có thể bị spoof hoặc rút lệnh.
  - Timestamp góc dưới trái là vị trí con trỏ, **không phải** lúc chụp.
  - Có thể có khoảng trống dữ liệu (đoạn ngang phẳng).
  - Vision đọc số nhỏ có thể sai.
- Hiện có: `POST /api/analyses` nhận 1 `screenshot` PNG, MCP `get_chart_screenshot` trả ảnh. Cả 2 runner `supportsScreenshot = true`.

## 2. Requirements / Spec

1. **Phạm vi:** chỉ `BOOKMAP_SYMBOLS` (mặc định `XAUUSD,BTCUSDT`). Symbol khác gửi Bookmap → 400.
2. **Đầu vào** (`POST /api/analyses`), trường mới tuỳ chọn:
   ```
   bookmap?: {
     htf?: dataUrl,      // ảnh khung lớn, PNG/JPEG
     ltf?: dataUrl,      // ảnh khung bé
     capturedAt?: number, // unix giây; UI lấy từ File.lastModified, thiếu → thời điểm gửi
     offset?: number      // giá Bookmap − giá app; thiếu → BOOKMAP_OFFSET_<SYMBOL>
   }
   ```
   Cần ít nhất 1 ảnh. Lưu tại `data/screenshots/<id>-bookmap-{htf,ltf}.<ext>` kèm `<id>-bookmap.json` (capturedAt, offset, `refPrice`).
3. **Offset:**
   - Config `BOOKMAP_OFFSET_XAUUSD=10`, `BOOKMAP_OFFSET_BTCUSDT=0`.
   - UI có ô offset điền sẵn giá trị mặc định, sửa tay được.
   - Quy đổi: **giá app = giá Bookmap − offset**. Server tự tính, không tin số quy đổi của agent.
4. **Kiểm tra ảnh cũ:**
   - `refPrice` = giá close của nến 1m chứa `capturedAt` trên nguồn của app.
   - Agent đọc **giá cuối** trên từng ảnh (ô giá hiện tại, vd `4061.5`) và nộp lên.
   - `measuredOffset = giá cuối đọc được − refPrice`. Nếu `|measuredOffset − offset| > BOOKMAP_TOLERANCE_<SYMBOL>` (mặc định XAU 3, BTC 60) → warning: "Ảnh Bookmap có thể đã cũ (giá cuối X, quy đổi Y, giá app lúc chụp Z)". **Vẫn dùng offset đã cấu hình**, không dùng offset đo được.
   - `capturedAt` cũ hơn 30 phút so với lúc gửi → warning.
5. **MCP:**
   - `get_analysis_request` thêm `bookmap: {images: ['htf','ltf'], instrument: 'GC futures COMEX' | 'BTCUSDT Binance spot', offset, capturedAt, refPrice} | null`.
   - Tool mới `get_bookmap_images(analysisId?)`: trả các ảnh, mỗi ảnh kèm một dòng text chú thích (vai trò, instrument, offset, nhắc quy đổi).
6. **Contract output** (`analysis.ts`), trường tuỳ chọn `orderflow`:
   ```
   orderflow?: {
     lastPrices: [{ image: 'htf'|'ltf', bookmapPrice }],   // giá cuối đọc trên ảnh
     summary: string (≤ 1000),                            // nhận xét định tính tiếng Việt
     levels: [{                                           // ≤ 12
       kind: 'ASK_WALL'|'BID_WALL'|'POC'|'HVN'|'LVN'|'ABSORPTION'|'AGGRESSION',
       image: 'htf'|'ltf',
       bookmapPrice,          // giá đọc trên Bookmap (chưa quy đổi)
       price?,                // server điền = bookmapPrice − offset
       size?,                 // khối lượng đọc trên ảnh, chỉ ghi khi có số (không ước từ màu heatmap)
       sizeSource?: 'COB'|'SVP'|'BUBBLE',  // COB = lệnh chờ hiện tại, SVP = volume đã khớp trong phiên
       strength: 0..1,
       note
     }],
     cvd?: note,
     offset?, measuredOffset?  // server điền
   }
   ```
   Có ảnh Bookmap mà agent không nộp `orderflow` → warning. Không có ảnh mà vẫn nộp → bỏ + warning.
7. **Validator:**
   - Quy đổi `price`. Mức quy đổi nằm ngoài `[min low, max high]` của ~300 nến khung chính ± 3 × ATR14 → bỏ + warning.
   - Mức Bookmap **không** làm thay đổi entry/SL/TP. R:R vẫn tính theo setup như cũ.
8. **Prompt** thêm mục "Bookmap (order flow)":
   - Chỉ là **bằng chứng xác nhận**, khung lớn từ nến vẫn quyết định bối cảnh.
   - Đọc: tường thanh khoản, POC/HVN, bong bóng lớn + phản ứng giá (hấp thụ vs đẩy giá), CVD phân kỳ (vd Spring: bán mạnh bị hấp thụ, CVD quay lên).
   - Cảnh báo: spoof, đoạn phẳng = không có dữ liệu, timestamp góc trái không phải giờ chụp.
   - Luôn ghi `bookmapPrice` đúng như trên ảnh, không tự quy đổi.
   - Được phép nhắc mức Bookmap trong `rationale`/`triggerNote`. Toạ độ setup vẫn lấy từ kline.
9. **UI:**
   - `AnalysisPanel`: khi symbol thuộc `BOOKMAP_SYMBOLS`, hiện checkbox **"Dùng ảnh Bookmap"** (mặc định tắt, nhớ lựa chọn trong localStorage, giống "Đính kèm ảnh chart").
     - Tắt: ẩn khu upload, **không gửi** `bookmap` (ảnh đã chọn vẫn giữ trong phiên để bật lại không phải chọn lại).
     - Bật: hiện khu "Bookmap" gồm 2 ô chọn/dán ảnh (khung lớn, khung bé), ô offset, nhãn instrument. Bật mà chưa có ảnh nào → nút Analyze báo "Chưa chọn ảnh Bookmap".
     - Runner không hỗ trợ Bookmap → checkbox bị vô hiệu hoá kèm ghi chú.
   - Danh sách phân tích: bản ghi có dùng Bookmap hiện nhãn nhỏ `BM` để dễ so sánh có / không.
   - Chart: layer mới **"Order flow"** (mặc định bật): price line nét chấm màu tím, nhãn ngắn kèm khối lượng nếu có, vd `BM Tường bán · 77 lot`, `BM POC · 8135`, `BM Tường mua · 25.8 BTC`, tại `price` đã quy đổi. Đơn vị theo symbol: vàng = lot GC, BTC = BTC. Mức không có số thì chỉ hiện nhãn.
   - Độ dày nét theo `size` tương đối giữa các mức cùng ảnh và cùng nguồn (không so COB với SVP).
   - Panel kết quả: mục "Order flow (Bookmap)" gồm summary, CVD, offset dùng / đo được, cảnh báo ảnh cũ.
10. **Runner agy:** cần kiểm chứng agy thật có nhận nội dung ảnh trả về qua MCP không. Nếu không → `supportsBookmap = false`, UI vô hiệu hoá khu Bookmap kèm ghi chú.

## 3. Technical Design

- `packages/shared/src/analysis.ts`: `orderflowSchema`, `ORDERFLOW_LEVEL_KINDS`. Thêm `orderflow` (optional) vào `analysisSubmissionSchema`.
- `packages/shared/src/bookmap.ts` (pure):
  - `toAppPrice(bookmapPrice, offset)`.
  - `checkStaleness({lastPrices, refPrice, offset, tolerance, capturedAt, submittedAt})` → warnings + `measuredOffset`.
  - `bookmapInstrumentLabel(symbol)`.
- Server:
  - `config.ts`: `bookmapSymbols`, `bookmapOffsets`, `bookmapTolerances`, `bookmapMaxAgeMin` (30).
  - `analysis/service.ts`: nhận `bookmap`, kiểm symbol, lưu ảnh + meta, lấy `refPrice` (nến 1m chứa `capturedAt`). `AnalysisRecord` thêm `bookmap?: boolean` (trả trong danh sách để hiện nhãn `BM`).
  - `routes/analyses.ts`: schema body + `/internal/analyses/:id/bookmap/:role`.
  - `validate/orderflow.ts`: quy đổi, lọc theo dải giá, staleness. Gọi từ `validate/index.ts`.
  - `runner/prompt.ts`: dòng nhắc gọi `get_bookmap_images`. `runner/types.ts`: `hasBookmap`, `supportsBookmap`.
  - `streamParser.ts` / `agyFormat.ts`: mô tả bước cho tool mới. Phụ lục định dạng agy thêm ví dụ `orderflow`.
- MCP `apps/mcp/src/index.ts`: tool `get_bookmap_images`.
- Web:
  - `api/client.ts`: kiểu `bookmap`.
  - `useAnalysisStore`: `useBookmap` (localStorage), state ảnh/offset, đọc `File.lastModified`; chỉ gửi `bookmap` khi `useBookmap` bật và symbol hợp lệ.
  - `AnalysisPanel`: khu upload + mục kết quả.
  - `overlays/model.ts` + `OverlayManager`: layer `orderflow`.
  - `LayerToggles`: thêm "Order flow".
- Ảnh UI chụp chart hiện tại (`screenshot`) vẫn giữ nguyên, độc lập với Bookmap.

## 4. Implementation Steps

1. Contract `orderflow` + `bookmap.ts` + test (`tests/bookmap.test.ts`): quy đổi, staleness (vàng lệch 2 → không cảnh báo, lệch 15 → cảnh báo ảnh cũ), ảnh > 30 phút.
2. Validator `orderflow` + test: điền `price`, bỏ mức ngoài dải, bỏ `orderflow` khi không có ảnh, warning khi thiếu.
3. Server: config, nhận/lưu ảnh, kiểm symbol (400 cho ETHUSDT), `refPrice`, route nội bộ, `get_analysis_request`. Test route.
4. MCP tool + prompt + phụ lục agy + mô tả bước stream.
5. Kiểm chứng agy nhận ảnh qua MCP (chạy agy thật). Không được → `supportsBookmap = false` cho agy.
6. Web: khu upload, layer Order flow, mục kết quả.
7. SPEC (mục 1, 3, 4, 5, 7, 9) + README (biến môi trường).
8. Kiểm chứng:
   - `npm run typecheck`, `npm run lint`, `npm test`.
   - Ảnh UI bằng `scripts/screenshot.ts`: khu upload + layer Order flow.
   - **Chạy thật** XAUUSD với `live3.png`/`live4.png` và BTCUSDT với `live1.png`/`live2.png` (Claude Code; agy nếu bước 5 đạt).
   - Hồi quy 1 lượt BTC không có Bookmap.

## 5. Acceptance

- Gửi XAUUSD kèm 2 ảnh: agent gọi `get_bookmap_images`, nộp `orderflow` có `lastPrices` + ít nhất 1 mức. Server quy đổi đúng (vd tường bán 4078 → 4068 với offset 10).
- Ảnh cũ (giá cuối lệch so với giá app quá ngưỡng) → warning "ảnh có thể đã cũ" hiện ở panel.
- Mức Bookmap hiện trên chart ở layer Order flow, bật/tắt được. Không làm đổi entry/SL/TP hay R:R.
- ETHUSDT kèm Bookmap → 400; với ETHUSDT không hiện checkbox. Phân tích không có Bookmap chạy y như cũ.
- Checkbox "Dùng ảnh Bookmap" tắt → request không có `bookmap` dù đã chọn ảnh; bật mà thiếu ảnh → chặn ở UI.
- typecheck / lint / test xanh. Có ảnh UI.

## 6. Ngoài phạm vi

- Tự động tính offset từ giá GC live (cần nguồn dữ liệu futures).
- Kết nối API Bookmap / Rithmic trực tiếp.
- Dùng order flow để tự động sinh hoặc chỉnh setup.

## 7. Ghi chú khi triển khai (2026-11-11)

- Chạy thật lần 1 (XAUUSD, Claude): agent đặt TP1 = 4078 = giá Bookmap **chưa trừ offset** (tường thật ở 4068 trên chart). Đã bổ sung: prompt + mô tả `get_bookmap_images` nhấn mạnh phải trừ offset khi dùng mức Bookmap cho setup; validator cảnh báo khi entry/SL/TP trùng `bookmapPrice` chưa quy đổi (chỉ cảnh báo, không sửa setup).
- Ảnh `~/ssd/live*.png` được Bookmap ghi đè liên tục → `File.lastModified` là thời điểm chụp thật.
