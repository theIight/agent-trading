# Plan — Chart & phân tích Wyckoff cho XAUUSD (vàng)

## Approval Status

- [x] Đã duyệt (2026-11-09) — phương án OANDA (mục 7); mặc định: giá mid, chỉ XAUUSD

## 1. Khảo sát (2026-11-09)

| Hạng mục | Kết quả |
|---|---|
| Nguồn | Binance USDⓈ-M có `XAUUSDT` (`TRADIFI_PERPETUAL`, underlying `COMMODITY`, tick 0.01), bám giá vàng giao ngay. Có thêm `XAGUSDT` (bạc), `PAXGUSDT` và `XAUTUSDT` (token vàng). |
| App hiện tại | `/api/klines?symbol=XAUUSDT` và WebSocket chạy được ngay, không cần sửa. |
| Lịch sử | Từ 2025-12-11: 1D ≈ 334 nến, **1W ≈ 49 nến**; 4H/1H đủ 1500 nến. Không có khoảng trống. |
| Cuối tuần | Perp giao dịch 24/7, nhưng khi vàng giao ngay đóng cửa (≈ thứ 6 22:00 → Chủ nhật 23:00 UTC) volume trung vị chỉ **7.6%**, biên độ **13.6%** so với ngày thường. |

Hệ quả nếu để nguyên:
- `volRatio = volume / SMA20` của nến đầu tuần bị thổi phồng, sinh **climax giả** (SC/BC giả).
- Nến cuối tuần đi ngang làm méo swing, range và ATR.
- Agent dễ đánh dấu Spring/UT trên nến thanh khoản mỏng.

## 2. Requirements / Spec

1. **Chọn nhanh symbol**: toolbar có danh sách theo dõi `BTCUSDT`, `ETHUSDT`, `XAUUSDT` (hiển thị "XAUUSD · Vàng"), `XAGUSDT`, và vẫn gõ được symbol bất kỳ. Gõ `XAUUSD` / `GOLD` tự chuyển thành `XAUUSDT`.
2. **Thông tin công cụ** (`GET /api/instruments/:symbol`, cache từ `exchangeInfo`):
   - `assetClass`: `crypto` hoặc `commodity`, theo `underlyingType`.
   - `tickSize`, `onboardDate`.
   - `session`: commodity có lịch đóng cửa cuối tuần.
3. **Phiên giao dịch (commodity):**
   - Nến nằm trong khung đóng cửa cuối tuần được gắn `session: 'closed'`.
   - Giờ đóng/mở cửa theo giờ New York (17:00 ET thứ 6 → 18:00 ET Chủ nhật) để tự đúng khi đổi giờ mùa hè/đông.
   - Chỉ áp dụng cho khung ≤ 4H; khung 1D/1W giữ nguyên.
4. **Features (`computeFeatures`)** khi có nến `closed`:
   - SMA volume, ATR, climax và range candidate **bỏ qua nến closed**.
   - Swing vẫn tính trên mọi nến, nhưng nến closed không được làm điểm climax.
5. **MCP:**
   - `get_klines` thêm cột `session` (`open`/`closed`) cho commodity.
   - `get_analysis_request` thêm `instrument` (assetClass, ghi chú lịch sử ngắn).
6. **Prompt** thêm mục "Vàng / hàng hoá":
   - Bỏ qua nến cuối tuần khi đánh giá nỗ lực–kết quả.
   - Không đặt sự kiện Wyckoff trên nến closed.
   - Lưu ý gap đầu tuần.
   - Phiên London/New York là nơi volume có ý nghĩa.
   - Lịch sử 1W ngắn.
7. **Validator:** event đặt trên nến `closed` → warning (không tự bỏ).
8. **Chart:**
   - Tô nền mờ các khung đóng cửa cuối tuần (khung ≤ 4H).
   - Legend ghi "XAUUSD · Vàng (Binance perp)".
   - Panel cảnh báo khi chọn khung có ít hơn 100 nến lịch sử (1W của vàng).

## 3. Technical Design

- `packages/shared/src/instruments.ts`:
  - `InstrumentInfo`, `WATCHLIST`, `symbolAlias()`.
  - `isSessionClosed(time, tfSeconds, session)`: pure, dùng `Intl.DateTimeFormat` với `America/New_York`.
- Server:
  - `market/instruments.ts` (cache `exchangeInfo` 6 giờ).
  - Route `/api/instruments/:symbol`.
  - `computeFeatures(candles, tf, { closedMask })`.
- MCP: lấy thông tin instrument qua API, thêm cột `session`.
- Web:
  - `Toolbar`: dropdown watchlist.
  - `OverlayPrimitive`: lớp tô nền phiên đóng cửa (tách layer `session`, mặc định bật).
  - `ChartController`: legend theo tên hiển thị.
- Crypto: **không đổi hành vi** (không có `session` → mọi nến `open`).

## 4. Implementation Steps

1. Shared `instruments.ts` + test (DST: đổi giờ tháng 3 và tháng 11).
2. Server instruments + route; features bỏ qua nến closed + test (fixture có cuối tuần giả: không sinh climax giả ở nến đầu tuần).
3. MCP cột `session` + `instrument` trong request; prompt mục vàng; validator warning.
4. Web: watchlist, alias, tô nền phiên đóng cửa, legend, cảnh báo lịch sử ngắn.
5. SPEC / README.
6. Kiểm chứng:
   - typecheck, lint, test, build.
   - Ảnh XAUUSD 1H/4H.
   - **Chạy thật XAUUSDT** với Claude và agy (Argon High) bộ 1D → 4H → 15m.
   - BTC hồi quy 1 lượt.

## 5. Acceptance

- XAUUSD hiển thị realtime, có vùng cuối tuần tô mờ, chọn được từ watchlist.
- Nến đầu tuần không còn bị đánh dấu climax chỉ vì so với volume cuối tuần.
- Phân tích XAUUSDT: DONE, không có event trên nến closed (hoặc có warning nếu agent vẫn đặt).
- BTC không đổi hành vi (test cũ vẫn đạt).

## 6. Cần quyết

1. **Nguồn dữ liệu:**
   - (a) Binance `XAUUSDT` perp (đề xuất): miễn phí, realtime, cùng hạ tầng, volume thật của hợp đồng; nhưng lịch sử chỉ từ 12/2025.
   - (b) XAUUSD giao ngay từ nhà cung cấp forex (OANDA / Twelve Data…): lịch sử dài, nhưng cần API key, chỉ có tick volume (yếu cho Wyckoff), phải viết thêm provider và WebSocket.
2. **Nến cuối tuần trên chart khung nhỏ:** giữ + tô mờ (đề xuất), hay ẩn hẳn?
3. **Watchlist:** BTC, ETH, XAU, XAG có đủ không, hay cần thêm symbol khác?

## 7. Phương án OANDA (người dùng hỏi 2026-11-09) — thay mục 1–6 nếu chọn

### Nguồn

OANDA v20 REST API:
- Endpoint: `api-fxpractice.oanda.com` (demo, miễn phí) hoặc `api-fxtrade.oanda.com` (live).
- Instrument `XAU_USD`. Nến lấy từ `GET /v3/instruments/XAU_USD/candles?granularity=M1|M5|M15|M30|H1|H4|D|W&count|from|to&price=M|B|A`, tối đa 5000 nến/lần, có cờ `complete`.
- Cần **API token** (header `Authorization: Bearer`). Lấy nến không cần account ID.

### Ưu / nhược so với Binance XAUUSDT

| | OANDA XAU_USD | Binance XAUUSDT |
|---|---|---|
| Giá | Vàng giao ngay (giống TradingView `OANDA:XAUUSD`) | Perp bám giá giao ngay |
| Lịch sử | Nhiều năm (1W/1D đủ cho Wyckoff dài hạn) | Từ 12/2025 |
| Cuối tuần | Không có nến (đóng cửa thật) → không có climax giả | Có nến cuối tuần "chết" |
| Volume | **Tick volume** (số lần đổi giá). Proxy phổ biến cho Wyckoff forex, không phải khối lượng thật | Khối lượng hợp đồng thật |
| Realtime | Không có WebSocket nến. Phải để server poll nến chưa đóng (2–3 giây) hoặc đọc pricing stream (cần account ID) rồi đẩy qua SSE | WebSocket trực tiếp từ trình duyệt |
| Bảo mật | Token phải nằm ở server (`.env`), trình duyệt không gọi trực tiếp | Public |

### Thiết kế

- `OandaProvider implements MarketDataProvider`:
  - Map `tf` → granularity; parse RFC3339 → unix giây; `volume` = tick volume.
  - Nến `complete=false` là nến đang chạy.
  - Phân trang `from/to` cho `endTime`.
  - Căn nến D/H4: `dailyAlignment=17&alignmentTimezone=America/New_York` (mặc định của OANDA). Tuần mở theo `weeklyAlignment=Sunday`; chốt khi triển khai bằng cách so với TradingView.
- **Định tuyến symbol** `market/router.ts`:
  - `XAUUSD`, `XAU_USD` → OANDA. Có thể mở rộng `XAGUSD` và cặp forex sau.
  - Còn lại → Binance.
  - Cache SQLite theo symbol như hiện tại.
- **Realtime cho symbol OANDA:**
  - Server poll `count=2` mỗi 2 giây cho cặp symbol/tf đang có người xem.
  - Đẩy SSE `/api/live?symbol&tf`.
  - Web dùng `liveFeed` qua SSE thay vì WebSocket Binance khi symbol thuộc OANDA.
- **Khoảng trống cuối tuần:** chart theo chỉ số nến nên tự liền; `makeTimeMapper` / validator đã snap theo nến thật.
  - Kiểm tra `isCandleClosed` dùng cờ `complete` thay vì `time + tf ≤ now`, vì nến cuối thứ 6 kéo dài qua cuối tuần.
- Không cần phần "đánh dấu nến cuối tuần" của mục 2.3–2.4; prompt vẫn thêm ghi chú: vàng, tick volume, gap đầu tuần, phiên London/NY.
- **Config:**
  - `OANDA_API_TOKEN`, `OANDA_ENV=practice|live`, `OANDA_PRICE=M` (mid; `B` = bid).
  - `OANDA_SYMBOLS=XAUUSD`.
  - Thiếu token → symbol OANDA báo lỗi rõ ràng trên UI.

### Cần từ người dùng

1. Tài khoản OANDA (demo là đủ để lấy dữ liệu) và **API token** (OANDA Hub → Manage API Access), đặt vào `.env`. Token không gửi vào chat.
2. Chọn giá: mid (M, đề xuất) hay bid (B).
3. Chỉ XAUUSD, hay thêm XAGUSD / các cặp forex?

## 8. Tiến độ (2026-11-09) — phương án OANDA

- [x] Shared: `instruments.ts` (`InstrumentInfo`, `WATCHLIST`, `describeInstrument`, `oandaInstrument`), alias `GOLD`/`XAU_USD` trong `normalizeSymbol`
- [x] Server: `OandaProvider` (parse UNIX time, mid/bid/ask, tick volume, căn nến NY 17:00), `RoutingProvider`, `LivePoller` + `GET /api/live` (SSE), `GET /api/instruments/:symbol`, config `OANDA_*` / `LIVE_POLL_MS`
- [x] Prompt: mục "Vàng / forex" (tick volume, gap đầu tuần, phiên London/NY, tin vĩ mô); prompt người dùng + `get_analysis_request` kèm instrument
- [x] Web: watchlist toolbar, realtime SSE cho nguồn OANDA, legend theo nguồn, 2 số lẻ cho vàng; symbol tải lỗi thì xoá chart cũ + legend đúng nguồn
- [x] Test `tests/oanda.test.ts` (parse, query, provider fetch giả, router, alias, poller); typecheck, lint, test (97), build:web; ảnh UI (BTC hồi quy, XAUUSD chưa có token hiện lỗi rõ ràng)
- [ ] **Chưa kiểm chứng với OANDA thật** (chưa có token): căn nến H4/D/W so với TradingView, realtime SSE, chạy phân tích XAUUSD với Claude + agy
- Bỏ: phần "đánh dấu nến cuối tuần" của phương án Binance (OANDA không có nến cuối tuần)

## 9. Phương án Tiingo (giá) + OKX (volume) — đã duyệt (2026-11-09)

Người dùng chưa lấy được key OANDA; đề xuất dùng giá Tiingo + volume OKX.

### Khảo sát

- **Tiingo FX** (`/tiingo/fx/<ticker>/prices?startDate&resampleFreq`, WebSocket `wss://api.tiingo.com/fx`):
  - Giá gộp bid/ask từ nhà cung cấp không nêu tên; nến chỉ có OHLC, **không có volume**.
  - Có vàng (Gold / Silver / Platinum), mã ticker chưa nêu → kiểm tra khi có key.
  - Intraday từ 01/2020.
  - Gói miễn phí: **50 request/giờ, 1.000/ngày**, 1 GB/tháng, "Internal Use Only". WebSocket firehose có trong gói miễn phí.
  - Thị trường mở 20:00 Chủ nhật → 17:00 thứ 6 (giờ New York).
- **OKX `XAU-USDT-SWAP`**:
  - Từ 2025-04-08 (580 nến 1D, sớm hơn Binance 8 tháng).
  - Volume 1H có tương quan log **0.94** với Binance `XAUUSDT`, quy mô khoảng 17% Binance; cuối tuần còn 15% ngày thường.
  - REST công khai `/api/v5/market/history-candles` (100 nến/lần), WebSocket công khai.
  - Nến ≥ 6H mặc định theo giờ UTC+8 → dùng `1Dutc`/`1Wutc`.
  - Cần header User-Agent (urllib mặc định bị 403).
- `XAUT-USDT` (token vàng, từ 2022): không dùng; hành vi volume crypto 24/7 khác hẳn.

### Thiết kế

- **`TiingoOkxProvider` cho `XAUUSD`** (cấu hình `XAUUSD_SOURCE=tiingo-okx|oanda|binance`, mặc định `tiingo-okx`):
  - Giá: Tiingo `resampleFreq` = `1min|5min|15min|30min|1hour|4hour|1day`. 1W tự gộp từ 1D (tuần mở theo giờ NY).
  - Volume mỗi nến Tiingo `[t, t+tf)` = **tổng volume OKX** (đơn vị XAU, `volCcy`) của các nến OKX nằm trong khoảng đó.
    - Join theo tổng chứ không theo open time, nên không phụ thuộc cách căn nến của hai bên.
    - Khung ≤ 4H dùng OKX cùng khung; 1D/1W cộng từ OKX 1H (cache SQLite).
  - Nến trước 2025-04-08 (hoặc OKX lỗi) → `volume = 0` kèm cờ không có volume. Features bỏ qua nến đó khi tính SMA volume / climax. Agent được báo.
- **Realtime:**
  - Server mở 1 WebSocket Tiingo (mid của top-of-book, `thresholdLevel` theo tài liệu) để dựng nến đang chạy.
  - Server mở 1 WebSocket OKX (`candle<tf>` của `XAU-USDT-SWAP`) cho volume nến đang chạy.
  - Đẩy xuống trình duyệt qua SSE `/api/live`, dùng lại `LivePoller` / hạ tầng của OANDA.
- **Tiết kiệm quota Tiingo:**
  - Cache SQLite theo `(symbol, tf, time)` như hiện tại.
  - Lần đầu tải một khung thì kéo nhiều ngày một lần.
  - Cuộn trái chỉ gọi khi cache thiếu.
  - Đếm request; gần chạm giới hạn thì trả cache kèm cảnh báo.
- **Config:** `TIINGO_API_TOKEN`, `XAUUSD_SOURCE`, `OKX_VOLUME_INST=XAU-USDT-SWAP`.
- Code OANDA giữ nguyên, chọn được qua `XAUUSD_SOURCE=oanda` khi có key.
- **Legend:** "XAUUSD · Vàng · giá Tiingo · volume OKX perp".
- **Prompt:** volume là khối lượng hợp đồng OKX XAU-USDT (proxy cho nỗ lực, không phải volume vàng giao ngay); nến trước 04/2025 không có volume.

### Kiểm chứng

- Unit test:
  - Ghép volume theo khoảng thời gian (nhiều nến OKX → 1 nến Tiingo, thiếu dữ liệu).
  - Parse Tiingo REST / WebSocket, parse OKX.
  - Gộp 1W.
  - Đếm quota.
- Với key thật:
  - Tra mã ticker vàng; so nến 1H/4H/1D với giá Tiingo top-of-book.
  - Kiểm tra số request khi đổi khung / cuộn lịch sử.
  - Realtime 2 WebSocket.
  - Chạy phân tích XAUUSD với Claude + agy; BTC hồi quy.

### Cần từ người dùng

- **Tiingo API token** (đăng ký miễn phí tại tiingo.com → Account → API → Token), đặt `TIINGO_API_TOKEN=` trong `.env`. Không gửi vào chat.

## 10. Tiến độ (2026-11-09) — Tiingo + OKX

- [x] `market/tiingo.ts`: `TiingoFxClient` (REST, quota `RequestQuota`), `parseTiingoBars`, `aggregateWeekly` / `weekStartUtc` (tuần vàng), `tiingoDateRange`
- [x] `market/okx.ts`: `OkxVolumeClient` (phân trang `after`, User-Agent), `parseOkxRows` (volCcy), `mergeVolumes` (cộng theo khoảng)
- [x] `market/tiingoOkx.ts`: `TiingoOkxProvider` (1D căn 00:00 UTC → OKX 1Dutc, lệch → OKX 1H; 1W gộp từ 1D; OKX lỗi → volume 0), `TiingoOkxLive` (WebSocket Tiingo + poll OKX), `applyQuote`, `parseTiingoFxMessage`
- [x] Router 3 nguồn (`XAUUSD_SOURCE`), `/api/live` chọn nguồn realtime theo symbol; OANDA giữ nguyên
- [x] Features bỏ qua nến volume 0; prompt + tin nhắn người dùng giải thích volume proxy / volume 0
- [x] Test: `tests/tiingoOkx.test.ts` + features (112 test); typecheck, lint, build
- [x] OKX thật: 1H 300 nến, 1Dutc 580 nến từ 2025-04-09; UI XAUUSD chưa có token hiện lỗi rõ ràng, legend "giá Tiingo · volume OKX perp"
- [ ] **Chưa kiểm chứng với Tiingo thật** (chưa có token): mã ticker vàng (`xauusd`?), căn nến 1D/4H, định dạng subscribe WebSocket, số request khi dùng; chạy phân tích XAUUSD với Claude + agy
