# SPEC — Wyckoff Chart Agent

## 1. Dữ liệu thị trường

* Nguồn theo symbol (`market/router.ts`):
  * **Binance USDⓈ-M Futures** (mặc định, crypto): REST `/fapi/v1/klines` (server), WebSocket `wss://fstream.binance.com/ws/<symbol>@kline_<tf>` (trình duyệt kết nối trực tiếp, tự reconnect backoff 1s→30s).
  * **Tiingo + OKX** cho `XAUUSD` khi `XAUUSD_SOURCE=tiingo-okx` (mặc định; `oanda` / `binance` = XAUUSDT là phương án thay thế):
    * Giá: Tiingo FX `GET /tiingo/fx/<TIINGO_XAU_TICKER>/prices?startDate&endDate&resampleFreq` (1min…1day; 1W gộp từ 1D, tuần vàng mở tối Chủ nhật, nhãn = thứ 2 00:00 UTC), header `Authorization: Token`. Không có volume.
    * Quota gói miễn phí: đếm request (cửa sổ trượt) `TIINGO_MAX_PER_HOUR` (45) / `TIINGO_MAX_PER_DAY` (950); chạm giới hạn → lỗi → KlineService trả cache.
    * Volume: OKX `XAU-USDT-SWAP` (`/api/v5/market/history-candles`, `volCcy` theo XAU, nến ≥ 1D dùng `1Dutc`). Volume nến giá `[t, t+tf)` = tổng volume các nến OKX có open time trong khoảng đó; nến ngày Tiingo không căn 00:00 UTC thì cộng từ OKX 1H. Không có dữ liệu (trước 2025-04-08 / OKX lỗi) → `volume = 0`.
    * Realtime: 1 WebSocket Tiingo `wss://api.tiingo.com/fx` (subscribe `thresholdLevel: 5`, quote `["Q", ticker, date, bidSize, bid, mid, askSize, ask]`) dựng nến đang chạy từ giá mid, căn UTC; poll OKX `/market/candles` (2 nến) mỗi 3s cho volume. Seed nến từ REST (1 request Tiingo mỗi feed). SSE `/api/live`.
  * **OANDA v20** cho symbol trong `OANDA_SYMBOLS` (mặc định `XAUUSD` → instrument `XAU_USD`): `GET /v3/instruments/{inst}/candles` với `price=OANDA_PRICE` (M/B/A), `dailyAlignment=17`, `alignmentTimezone=America/New_York`, `weeklyAlignment=Sunday`, header `Accept-Datetime-Format: UNIX`, `to = endTime + 1`. Volume = **tick volume**. Không có nến cuối tuần. Token `OANDA_API_TOKEN` chỉ ở server; thiếu token → 502 "Chưa cấu hình OANDA_API_TOKEN".
  * Realtime OANDA: `GET /api/live?symbol&tf` (SSE, `{candle, closed}` hoặc `{error}`); server poll 2 nến mới nhất mỗi `LIVE_POLL_MS` (2s), chỉ khi có người xem; nến trước phát `closed: true` khi xuất hiện nến mới.
* `GET /api/instruments/:symbol` → `InstrumentInfo {symbol, source, displayName, sourceLabel, assetClass, volumeType: contract|tick, live: binance-ws|server-sse}`; `get_analysis_request` và prompt người dùng kèm thông tin này.
* `normalizeSymbol`: chữ hoa, bỏ ký tự lạ (`XAU_USD` → `XAUUSD`), alias `GOLD` → `XAUUSD`, `SILVER` → `XAGUSD`. Watchlist toolbar: `BTCUSDT`, `ETHUSDT`, `XAUUSD`.
* Khung hỗ trợ (`SUPPORTED_TFS`): `1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w` — trùng interval Binance.
* `Candle = { time (unix giây, open time), open, high, low, close, volume }`.
* `GET /api/klines?symbol&tf&limit(≤1500, mặc định 500)&endTime(unix giây, gồm nến có open time ≤ endTime)&closedOnly`:
  * Lưu mọi nến vào SQLite `klines(symbol, tf, open_time)`; memo trong bộ nhớ `KLINE_MEMORY_TTL_MS` (5s).
  * Binance lỗi → trả cache (`source: 'cache'`); cache rỗng → 502.
  * Nến đóng khi `time + tfSeconds ≤ now`. `closedOnly=true` bỏ nến đang chạy, vẫn trả đủ `limit` nến.

## 2. Chọn khung & top-down

* Người dùng chọn 1 khung chính (= khung đang xem) + 0–3 khung phụ; tổng ≤ `AGENT_MAX_TFS` (4). Không trùng, chỉ khung hỗ trợ (`buildTfPlan`).
* Kế hoạch phân tích sắp **giảm dần theo độ dài khung**; vai trò `HTF` (lớn hơn khung chính) / `PRIMARY` / `LTF` (nhỏ hơn).
* Preset mặc định (UI, lưu localStorage): Swing `4h+1d+5m`, Intraday `1h+4h+15m`, Position `1d+1w+4h`, Scalp `15m+1h+1m`.

## 3. Contract `AnalysisSubmission` (`packages/shared/src/analysis.ts`)

| Trường | Ràng buộc |
|---|---|
| `symbol`, `primaryTf` | Phải khớp yêu cầu |
| `schematic` | ACCUMULATION / REACCUMULATION / DISTRIBUTION / REDISTRIBUTION / UNCLEAR |
| `currentPhase` | A–E hoặc null |
| `bias`, `confidence` | BULLISH/BEARISH/NEUTRAL, 0..1 |
| `summary` | Tiếng Việt, ≤ 4000 ký tự |
| `topDown[]` | `{tf, role, bias, phase, schematic, note}` — đủ mọi khung được giao |
| `events[]` (≤ 60) | `{type ∈ WYCKOFF_EVENT_TYPES, tf, time, price, confidence, note}` |
| `ranges[]` (≤ 6) | `{tf, start, end, top, bottom, label, creek?, ice?}` |
| `phases[]` (≤ 10) | `{tf, phase, start, end}` |
| `levels[]` (≤ 20) | `{kind ∈ SUPPORT/RESISTANCE/CREEK/ICE/INVALIDATION/TARGET, price, tf?, note}` |
| `scenarios[]` (≤ 3) | `{name, probability, bias, path[2..12]{time, price}, trigger, invalidation, note}` |
| `tradePlan` | `{decision ∈ ENTER/WAIT_FOR_SETUP/STAND_ASIDE, reason, reconsiderWhen, setups[≤2]}` — xem 3.1 |
| `action` | Không do agent gửi (bị bỏ qua + warning). Server suy ra từ `tradePlan` để tương thích bản ghi cũ |
| `tfConflicts[]` | Mâu thuẫn giữa các khung |
| `orderflow?` | Chỉ khi phân tích có ảnh Bookmap — xem 3.2 |

`AnalysisResult` = submission + `{id, createdAt, tfs (top-down), asOf (nến đóng cuối của khung chính), model?, warnings[]}`; `action` luôn có, `tradePlan` thiếu ở bản ghi cũ.

### 3.1 Trade plan

* `decision`: `ENTER` (vào ngay, cần setup `MARKET`), `WAIT_FOR_SETUP` (chờ setup kích hoạt), `STAND_ASIDE` (đứng ngoài; **bắt buộc** `reconsiderWhen`).
* `setups[]` (≤ 2, phần tử đầu = setup chính): `{name, direction ∈ LONG/SHORT, entryType ∈ MARKET/LIMIT/STOP, tf, trigger ∈ SETUP_TRIGGERS, triggerNote, entryLow, entryHigh, stopLoss, takeProfits[1..3], validUntil?, scenario?, confidence, rationale, riskReward?, riskRewardTp1?}`.
* `refinedEntry?` (SL tầng 2, ước lượng): `{tf ≤ khung chính, trigger ∈ REFINED_TRIGGERS (SETUP_TRIGGERS + CHOCH), condition, stopRule, estStopDistance (đơn vị giá), atr?, riskReward?, riskRewardTp1?}` — khi giá vào vùng entry, chờ tín hiệu khung nhỏ, SL sau đỉnh/đáy tín hiệu + đệm ATR. Không thay thế `stopLoss` cấu trúc.
* `MARKET` = giá đang ở vùng entry; `LIMIT` = chờ hồi về (LONG vùng dưới giá, SHORT vùng trên); `STOP` = chờ phá vỡ (LONG vùng trên giá, SHORT vùng dưới).
* `action` suy ra: `ENTER` → LONG/SHORT của setup chính (entry = giữa vùng); `WAIT_FOR_SETUP` → `WAIT` kèm mức giá setup chính; `STAND_ASIDE` → `WAIT` không mức giá, `condition` = lý do + điều kiện xem lại.

### 3.2 Order flow (Bookmap)

* Chỉ symbol trong `BOOKMAP_SYMBOLS` (mặc định `XAUUSD,BTCUSDT`). Ảnh `htf` = khung lớn (zoom rộng), `ltf` = khung bé.
* `orderflow = {lastPrices[≤2]{image, bookmapPrice}, summary, levels[≤12], cvd, offset?, measuredOffset?}`.
* `levels[] = {kind ∈ ASK_WALL/BID_WALL/POC/HVN/LVN/ABSORPTION/AGGRESSION, image ∈ htf/ltf, bookmapPrice, price?, size?, sizeSource? ∈ COB/SVP/BUBBLE, strength, note}`. Agent ghi `bookmapPrice` đúng như trên trục Bookmap; `size` chỉ khi có số in trên ảnh.
* **Server điền** `price = bookmapPrice − offset`, `offset`, `measuredOffset` (giá agent tự quy đổi bị ghi đè). Vàng: Bookmap chạy GC futures COMEX, cao hơn XAUUSD spot (basis).
* Order flow là bằng chứng xác nhận: **không** làm đổi entry/SL/TP hay R:R.

## 4. Validator (`apps/server/src/validate`)

Nộp có `analysisId` mà thiếu `symbol` / `primaryTf` → server điền từ yêu cầu phân tích + warning (sai giá trị vẫn là lỗi; nộp không có `analysisId` vẫn bắt buộc).

Trước khi parse: mọi `tf`/`primaryTf` viết hoa (`1D`, `4H`…) được chuẩn hoá về chữ thường (`1M` giữ nguyên → lỗi).

Lỗi (trả về agent để sửa, **toàn bộ trong một lần**): sai schema (kèm đường dẫn trường), sai `symbol`/`primaryTf`, `topDown` thiếu khung, **bản nộp placeholder**: `summary` < 80 ký tự, `topDown[].note` < 15, `tradePlan.reason` < 20, hoặc chỉ là từ placeholder (`test`, `todo`, `tbd`, `n/a`, `...`), hoặc `schematic` ≠ `UNCLEAR` mà `events` rỗng.

Tự sửa + ghi `warnings`:
* `topDown` sắp lại đúng thứ tự lớn → nhỏ, sửa vai trò, bỏ khung không được giao.
* Event: `time` snap về open time của nến chứa nó; ngoài dữ liệu (nạp tới 1500 nến đã đóng) → bỏ. `price` ngoài `[low − ε, high + ε]` (ε = 0.1 × ATR14 của khung) → snap về high/low gần hơn. Khung không có dữ liệu → bỏ.
* Range: đảo start/end, top/bottom nếu ngược; clamp vào cửa sổ dữ liệu; bỏ `creek`/`ice` nằm ngoài range (±2%).
* Phase: sắp start ≤ end, snap, clamp.
* Scenario: path sắp theo thời gian; tổng xác suất ≠ 1 → chuẩn hoá (cảnh báo khi lệch > 0.05).
* Trade plan (`validate/tradePlan.ts`), `P` = giá đóng cửa nến đã đóng gần nhất của khung chính, dung sai vùng entry = 0.25 × ATR14 khung chính:
  * `STAND_ASIDE` thiếu `reconsiderWhen` → **lỗi** trả về agent.
  * `entryLow > entryHigh` → đảo. LONG cần `SL < entryLow` và mọi TP `> entryHigh`; SHORT ngược lại; sai → **bỏ setup**. TP sắp từ gần đến xa.
  * Giá đã qua SL (trừ setup `STOP` chưa kích hoạt) hoặc đã qua TP xa nhất → bỏ setup.
  * R:R = |TP xa nhất − giữa vùng entry| / |giữa vùng entry − SL| (server tính, làm tròn 2 số; thêm `riskRewardTp1`). R:R < `SETUP_MIN_RR` (mặc định 2) → **bỏ setup**.
  * `MARKET` mà `P` ngoài vùng entry ± dung sai → đổi `LIMIT`/`STOP` theo vị trí; `LIMIT`/`STOP` sai phía → đổi loại.
  * `refinedEntry`: `tf` lớn hơn khung chính hoặc không có dữ liệu → bỏ. `estStopDistance` < 0.5 × ATR14(tf) → nâng lên 0.5 ATR. `estStopDistance` ≥ khoảng cách SL cấu trúc (từ giữa vùng entry) → bỏ. Server điền `atr`, `riskReward` = |TP xa nhất − giữa vùng| / estStopDistance, `riskRewardTp1`. **Ngưỡng R:R tối thiểu chỉ xét SL cấu trúc.**
  * `validUntil ≤ asOf` → bỏ trường; `scenario` không khớp tên kịch bản → bỏ trường. Setup ngược bias khung HTF → chỉ cảnh báo.
  * Hạ cấp: `ENTER` không còn setup `MARKET` → `WAIT_FOR_SETUP` (còn setup) hoặc `STAND_ASIDE`; `WAIT_FOR_SETUP` hết setup → `STAND_ASIDE` (tự điền `reconsiderWhen` nếu trống). `STAND_ASIDE` giữ setup làm tham khảo. `ENTER` đưa setup `MARKET` lên đầu.

* Order flow (`validate/orderflow.ts`):
  * Không có ảnh Bookmap mà vẫn nộp → bỏ + warning. Có ảnh mà không nộp → warning.
  * Mức của ảnh không được gửi → bỏ. `price` quy đổi ngoài `[min low, max high]` của 300 nến khung chính gần nhất ± 3 × ATR14 → bỏ. `size` thiếu `sizeSource` → bỏ `size`.
  * Ảnh cũ: `refPrice` = close nến 1m chứa `capturedAt` (lấy một lần, lưu vào meta). `measuredOffset = giá cuối (ưu tiên ảnh ltf) − refPrice`. `|giá cuối − refPrice − offset| > BOOKMAP_TOLERANCE_<SYMBOL>` → warning "có thể đã cũ" (vẫn quy đổi bằng offset cấu hình). Ảnh chụp cách lúc gửi > `BOOKMAP_MAX_AGE_MIN` (30) phút → warning. Thiếu `lastPrices` / `refPrice` → warning không kiểm tra được.
  * Giá entry/SL/TP của setup trùng `bookmapPrice` (chưa quy đổi) của một mức trong ±0.02 × ATR14 khung chính nhưng không trùng giá đã quy đổi → warning "trùng giá Bookmap CHƯA quy đổi" (không tự sửa setup; bỏ qua khi |offset| ≤ 0.04 × ATR).

## 5. Điều phối phân tích (`apps/server/src/analysis`)

* `POST /api/analyses {symbol, primaryTf, contextTfs[], screenshot?, runner?, model?}` → bản ghi `RUNNING` (lưu `runner`, `model`), đưa vào hàng đợi; **chạy tuần tự 1 job/lần** cho mọi agent. `runner` ∈ `AGENT_RUNNERS` (mặc định `AGENT_RUNNER`), không bật / binary không chạy được → 400. `model` khớp `^[\w.:/-]{1,80}$`, rỗng = mặc định của runner. `screenshot` là data URL PNG, lưu `data/screenshots/<id>.png`.
* `bookmap? {htf?, ltf?, capturedAt?, offset?}` (data URL PNG/JPEG, ≥ 1 ảnh): symbol ngoài `BOOKMAP_SYMBOLS`, runner `supportsBookmap = false`, thiếu ảnh hoặc sai định dạng → 400. `capturedAt` (unix giây, UI lấy `File.lastModified` của ảnh cũ nhất; thiếu/tương lai → lúc gửi). `offset` thiếu → `BOOKMAP_OFFSET_<SYMBOL>` (XAUUSD 10, BTCUSDT 0). Lưu `data/screenshots/<id>-bookmap-{htf,ltf}.{png,jpg}` + `<id>-bookmap.json` (meta). Bản ghi có `bookmap: true` (cột `analyses.bookmap`).
* Trạng thái: `RUNNING → DONE | FAILED | CANCELED`. Agent thoát mà chưa nộp hợp lệ → `FAILED`. Server khởi động lại → mọi `RUNNING` cũ thành `FAILED`.
* `POST /api/analyses/:id/cancel` hủy job đang chạy (SIGTERM, sau 3s SIGKILL) hoặc đang chờ.
* SSE: `/api/analyses/:id/stream` (step/text/status/result của 1 phân tích), `/api/events` (status/result mọi phân tích). Heartbeat 15s.
* `GET /api/analyses?symbol` (danh sách gọn), `GET /api/analyses/:id` (đầy đủ).
* `GET /api/runners` → `{defaultRunner, runners: RunnerInfo[]}` (`id, label, available, reason?, defaultModel?, models[], supportsScreenshot, supportsBookmap`). Bản ghi cũ không có `runner` coi là `claude-code`; kết quả từ Claude Code / agy tương tác có `runner: 'interactive'`. `result.model` = `<runner> · <model>`.

## 6. Agent runner

### 6.1 Claude Code (`claude-code`)

```
claude -p --output-format stream-json --verbose
  --mcp-config .mcp.json --strict-mcp-config
  --tools "" --allowedTools "mcp__wyckoff__*"
  --no-session-persistence --append-system-prompt <prompts/wyckoff.md> [--model AGENT_MODEL]
```
* Prompt người dùng (stdin): symbol, `analysisId`, khung chính, thứ tự top-down, số nến mặc định.
* Timeout `AGENT_TIMEOUT_MS` (300s). Env cho MCP: `WCA_SERVER_URL`, `WCA_INTERNAL_TOKEN`. Model: `AGENT_MODEL` hoặc alias `opus/sonnet/haiku` từ UI.

### 6.2 Antigravity (`agy`, `apps/server/src/runner/agyRunner.ts`)

```
agy -p <user prompt> --agent wyckoff-analyst --output-format stream-json
    --settings <JSON khoá quyền> --disable-slash-commands [--model AGY_MODEL]
```
* cwd = `data/agy-workspace` (workspace rỗng, ghi lại mỗi lần chạy): `.agents/mcp_config.json` (server `wyckoff`, đường dẫn tuyệt đối) + `.agents/agents/wyckoff-analyst.md` (custom agent: `excludeDefaultComponents: true`, `inheritMcp: true`, `tools: [view_file]`, system prompt = `prompts/wyckoff.md` hạ một cấp heading).
* Khoá quyền 3 lớp (setting toàn cục của agy có thể là `always-proceed`): (1) custom agent chỉ còn tool MCP + xem file (cần để đọc schema MCP agy nạp lười); (2) workspace rỗng + `allowNonWorkspaceAccess: false` → file ngoài workspace bị từ chối (trừ thư mục schema MCP của agy); (3) `--settings`: `toolPermission: request-review`, allow `mcp(wyckoff/*)`, deny `command(*)`, `write_file(*)`, `mcp(<MCP khác trong agy mcp list>/*)`. Không dùng `deny mcp(*)` vì deny thắng allow.
* Stream: `init` → model; `step_update` tool `ACTIVE` → bước (mô tả theo `ToolName` của `call_mcp_tool`), `ERROR` → "Tool lỗi"; `agent_response` gom `text_delta`; `result.status = SUCCESS` và không có `finished_reason` → ok. Dòng ngoài JSON (vd quyền bị tự động từ chối) → bước cảnh báo.
* System prompt agy kèm phụ lục định dạng `submit_analysis` (mẫu `SUBMISSION_EXAMPLE` + enum); prompt người dùng nhắc `symbol`, `primaryTf`, đủ khung `topDown`, `limit`.
* Model: `AGY_MODEL` (mặc định `gemini-4-argon-high`) hoặc danh sách `agy models` (cache 10 phút). Timeout `AGY_TIMEOUT_MS` (600s).

## 7. MCP server `wyckoff` (`apps/mcp`, stdio)

| Tool | Mô tả |
|---|---|
| `get_analysis_request(analysisId)` | symbol, khung chính, `topDownOrder`, `barsPerTf`, `hasScreenshot`, `lastClose` (khung chính, nến đã đóng), `minRiskReward`, `bookmap` (`{images, instrument, offset, capturedAt, refPrice, note}` hoặc null) |
| `get_klines(symbol, tf, limit?=300, endTime?)` | CSV `i,time_utc,unix,open,high,low,close,volume`, chỉ nến đã đóng. `tf` nhận chữ hoa; `limit` < 100 tự nâng lên 100 (ghi chú ở dòng đầu) |
| `get_features(symbol, tf, limit?, endTime?)` | ATR14, trend, swings (40 gần nhất), BOS/CHoCH (15), climax (20), range candidates — chỉ số `i` khớp `get_klines` cùng tham số |
| `get_chart_screenshot(analysisId)` | Ảnh PNG nếu có |
| `get_bookmap_images(analysisId)` | Dòng mô tả (instrument, offset, giờ chụp, giá app lúc chụp) + từng ảnh Bookmap kèm nhãn htf/ltf (`/internal/analyses/:id/bookmap`) |
| `submit_analysis(analysisId?, analysis)` | Validate + lưu; không có `analysisId` → tạo bản ghi mới (agent tương tác). `analysis` = union(schema đầy đủ, object bất kỳ) để server trả đủ lỗi một lần; thiếu wrapper `analysis` thì gom các trường ở cấp ngoài |

Ngữ cảnh lượt chạy: runner đặt env `WCA_ANALYSIS_ID`, `WCA_SYMBOL`, `WCA_PRIMARY_TF` cho MCP (Claude: env tiến trình `claude`; agy: `env` trong `mcp_config.json` của workspace). Khi agent bỏ sót, `analysisId` (get_analysis_request, get_chart_screenshot, submit_analysis) và `symbol` (get_klines, get_features) lấy từ env; phiên tương tác không có env → thiếu tham số là lỗi tiếng Việt. Có `WCA_ANALYSIS_ID` thì `submit_analysis` luôn gắn vào lượt đang chạy.

API nội bộ `/internal/*`: chỉ localhost + header `x-wca-token` = nội dung `data/internal-token` (tạo ngẫu nhiên lần đầu, mode 600).

## 8. Đặc trưng (`apps/server/src/features`)

* Swing fractal 2/2 (không repaint), nhãn HH/LH/EH/HL/LL/EL, trend Dow, BOS/CHoCH theo giá đóng cửa — port 1:1 từ `pumping-token-detect/src/indicators/marketStructure.js` (test so khớp trên fixture BTC 4h).
* Nến `volume <= 0` = không có dữ liệu volume: bỏ qua khi tính SMA volume (cần ≥ nửa cửa sổ có volume), climax và `volumeDryUpRatio`.
* Climax bar: `volRatio = volume / SMA20(volume 20 nến trước) ≥ 2.0`, hoặc `≥ 1.5` và `spread ≥ 1.5 × ATR14`. `isExtreme`: low (nến giảm) / high (nến tăng) là cực trị trong [i−20, i+5].
* Range candidate: climax cực trị → AR = swing ngược chiều đầu tiên trong 30 nến → range [SC low, AR high] (hoặc [AR low, BC high]) → theo dõi tới khi đóng cửa vượt biên quá 15% chiều cao (`BROKEN_UP/DOWN`), ≥ 8 nến; ghi `probesBelow/Above`, `volumeDryUpRatio`; bỏ ứng viên chồng lấn (giữ climax volume lớn hơn).

## 9. Hiển thị (`apps/web/src/overlays`)

- Overlay chỉ vẽ khi `analysis.symbol` trùng symbol đang xem. Đổi sang symbol khác thì ẩn hình vẽ (kết quả vẫn ở panel), quay lại symbol cũ thì hiện lại.
- Đổi symbol bật lại auto-scale trục giá và cuộn về nến mới nhất. Đổi khung giữ nguyên thang giá người dùng đã kéo.

| Layer | Cách vẽ |
|---|---|
| Sự kiện | Series markers; giá ≥ giữa nến → `aboveBar`/arrowDown, ngược lại `belowBar`/arrowUp; xanh = cầu, đỏ = cung, xám = trung tính; khung khác thêm hậu tố `·1D` |
| Trading Range | Primitive hộp chữ nhật + Creek/Ice nét đứt |
| Phase | Dải nền dọc + nhãn trên vùng volume |
| Mức giá | Price line nhãn ngắn (Hỗ trợ, Kháng cự, Creek, Ice, Vô hiệu, Mục tiêu) |
| Dự đoán | Đường nét đứt tới tương lai; kịch bản xác suất cao nhất nét đậm; nhãn `tên xx%` |
| Setup | Công cụ Long/Short cho từng setup: giữa vùng entry→TP xa nhất (xanh), →SL (đỏ), vùng entry (vàng, nếu là vùng), TP trung gian nét đứt, SL tinh chỉnh (nếu có) là đường đứt đỏ "SL 1m ≈" tại giữa vùng ∓ `estStopDistance`; từ `asOf` tới `validUntil` hoặc 25 nến, tối thiểu 12 nến khung đang xem. Nhiều setup → các cột cạnh nhau (setup chính bên trái, cách 1 nến) để không chồng; nhãn overlay tự giãn dọc để không đè nhau. Setup `MARKET` của quyết định `ENTER` vẽ nét liền; setup đang chờ vẽ mờ, viền nét đứt, nhãn `Chờ hồi/Chờ phá vỡ <trigger>`. `STAND_ASIDE` không vẽ, trừ khi bật "Hiện setup tham khảo". Click thẻ setup ở panel → chỉ vẽ setup đó. Bản ghi cũ vẽ từ `action` |

| Order flow | Price line nét chấm tím tại `price` đã quy đổi, nhãn `BM <loại> · <size> <đơn vị>` (vàng: lot, BTC: BTC); độ dày 1–3 theo `size` tương đối trong cùng ảnh + cùng `sizeSource`. Toggle "Order flow" chỉ hiện khi kết quả có `orderflow` |

* Panel phân tích: với symbol trong `BOOKMAP_SYMBOLS` có checkbox **"Dùng ảnh Bookmap"** (mặc định tắt, nhớ trong localStorage). Bật → 2 ô ảnh (khung lớn / khung bé: chọn file, kéo thả, dán), ô offset (mặc định từ `/api/config.bookmap.offsets`, sửa được, nhớ theo symbol). Tắt → không gửi `bookmap`. Bật mà chưa có ảnh → chặn Analyze. Ảnh giữ trong phiên theo symbol. Runner không hỗ trợ → checkbox bị khoá.
* Kết quả có mục "Order flow (Bookmap)" (summary, CVD, các mức, offset dùng / đo được); lịch sử hiện nhãn `BM`.
* Mặc định ẩn mục của khung **nhỏ hơn** khung đang xem; mục của khung lớn hơn được snap về nến chứa nó.
* `rightOffset` của time scale tự mở rộng để thấy hết phần tương lai.
