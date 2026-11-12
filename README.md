# Wyckoff Chart Agent

Chart giống TradingView (Binance USDⓈ-M Futures, realtime) + agent Claude Code phân tích **Wyckoff top-down** và vẽ kết quả trực tiếp lên chart: sự kiện (SC, AR, Spring, SOS, UTAD…), Trading Range, Phase A–E, mức giá, kịch bản dự đoán và công cụ Long/Short.

Không cần chụp ảnh TradingView thủ công nữa: agent đọc dữ liệu nến qua MCP.

## Yêu cầu

- Node ≥ 22.12
- Ít nhất một agent CLI đã cài và đăng nhập:
  - [Claude Code](https://claude.com/claude-code) (`claude` có trong PATH). Không cần `ANTHROPIC_API_KEY`.
  - Antigravity CLI (`agy` có trong PATH) — model Gemini / Claude / GPT-OSS theo `agy models`.

## XAUUSD (vàng)

Mặc định (`XAUUSD_SOURCE=tiingo-okx`): **giá vàng giao ngay từ Tiingo + volume hợp đồng OKX XAU-USDT-SWAP** (có volume từ 04/2025).

1. Đăng ký miễn phí tại tiingo.com → Account → API → Token.
2. `.env`: `TIINGO_API_TOKEN=<token>` (không commit). Gói miễn phí 50 request/giờ — app đếm quota và dùng cache khi gần chạm giới hạn.
3. Khởi động lại `npm run dev`, chọn **XAUUSD** trên toolbar.

Phương án khác: `XAUUSD_SOURCE=oanda` (cần `OANDA_API_TOKEN`, `OANDA_ENV=practice|live`, volume = tick volume) hoặc `XAUUSD_SOURCE=binance` (XAUUSDT perp).

## Bookmap (order flow, XAUUSD / BTCUSDT)

Khai báo đường dẫn ảnh mà Bookmap ghi ra (ghi đè liên tục) trong `.env`: `BOOKMAP_IMAGE_<SYMBOL>_HTF` / `_LTF` (hỗ trợ `~`). Trong panel tick **"Dùng ảnh Bookmap"**: panel hiện ảnh xem trước + tuổi ảnh; khi job bắt đầu chạy, server copy ảnh mới nhất cho agent. Agent đọc COB, SVP, heatmap, bong bóng, CVD làm bằng chứng xác nhận (không đổi bối cảnh khung lớn, không đổi entry/SL/TP). Chart (layer "Order flow") chỉ vẽ vạch mờ cho tường lớn (đỏ = bán, xanh = mua, nhãn = khối lượng) và POC.

- Vàng trên Bookmap là **GC futures**, cao hơn XAUUSD spot: giá app = giá Bookmap − offset. Offset mặc định `BOOKMAP_OFFSET_XAUUSD=10` (BTC `0`), sửa được trên form. Khi roll hợp đồng (GCZ → GCG…) offset tăng — cập nhật lại.
- Giá cuối trên ảnh lệch so với giá app lúc chụp quá `BOOKMAP_TOLERANCE_<SYMBOL>` (vàng 3, BTC 60) → cảnh báo **ảnh có thể đã cũ**. Ảnh chụp quá `BOOKMAP_MAX_AGE_MIN` (30) phút → cảnh báo.
- Symbol có ít nhất một `BOOKMAP_IMAGE_<SYMBOL>_*` mới hiện tick Bookmap.

## Order flow Binance (BTCUSDT)

Với symbol trong `ORDERFLOW_BINANCE_SYMBOLS` (mặc định `BTCUSDT`), server **tự ghi sổ lệnh và lệnh khớp của Binance spot** qua WebSocket công khai (không cần key) thay vì đọc ảnh Bookmap. Panel có tick **"Dùng order flow Binance"** kèm trạng thái ghi. Khi phân tích, server tính tường thanh khoản kèm thời gian đứng (lọc tường ảo), POC/HVN/LVN 24h, CVD + phân kỳ, hấp thụ; agent đọc qua tool `get_orderflow` và chỉ nhận xét, các mức do server gắn và vẽ.

- Mở chart BTC là thấy ngay tường (dày theo khối lượng) + POC, tự làm mới mỗi 15 giây, không cần chạy phân tích. Giống heatmap Bookmap: tường vẽ từ lúc xuất hiện; tường bị giá quét/hấp thụ dừng ở chỗ bị quét (dấu ×); tường bị rút trước khi giá chạm (lệnh ảo) vẽ nét chấm mờ. Ngưỡng tường `ORDERFLOW_WALL_MIN_BTCUSDT` (mặc định 8). Xem rõ nhất ở khung 1m–15m.
- Giá order flow quy đổi từ Binance spot về giá chart (futures) bằng **basis = trung vị 60 phút** của chênh lệch giá đóng spot − futures cùng phút: vạch đứng yên giữa các phút, sai số vài $. Tường đã bị quét dùng basis lúc bị quét nên không dịch nữa. Thiếu dữ liệu → `ORDERFLOW_OFFSET_BTCUSDT` (mặc định 33).
- Binance không có lịch sử sổ lệnh: lịch sử bắt đầu từ lúc server chạy (lưu SQLite 24 giờ, restart không mất). Cần ≥ 30 phút để thời gian đứng của tường đáng tin.
- **Volume gộp BTC** (toggle "Volume gộp"): nến đã đóng hiện volume perp 3 sàn (Binance Futures + OKX + Bybit) và phần spot Binance màu cam phía trên; dấu `S` / `P` / `S+P` = đột biến spot / perp / cả hai (> 3× trung vị 20 nến, `VOLAGG_SPIKE_X`). Agent nhận `volumeAgg` trong `get_features`.
- **Thanh lý BTC** (toggle trên chart): *Thanh lý* = bong bóng thanh lý thật từ Binance + OKX (đỏ = long bị thanh lý, xanh = short; Binance chỉ đẩy 1 lệnh/giây nên đếm thiếu, chỉ có từ lúc server chạy). *Heatmap thanh lý (ước tính)* = mức thanh lý dự kiến tính từ open interest Binance 29 ngày với đòn bẩy giả định (`LIQ_LEVERAGE`) — là mô hình, sai số vài trăm $; mức bị giá quét thì biến mất. Agent nhận tóm tắt cả hai trong `get_orderflow`.
- Vàng (`XAUUSD`): order flow lấy từ **Binance Futures XAUUSDT perp** (đơn vị oz), vẽ live trên chart giống BTC, basis = trung vị 60 phút XAUUSDT − giá chart. Lưu ý: đây là dòng lệnh crypto (~2% khối lượng COMEX), sổ lệnh chỉ phủ khoảng ±13$ quanh giá → chỉ để xác nhận phụ. Ảnh Bookmap vàng vẫn dùng được; mỗi phân tích chọn một nguồn. Đặt `ORDERFLOW_BINANCE_SYMBOLS=` (rỗng) để tắt.

## Chạy

```bash
npm install
cp .env.example .env   # tùy chọn, mặc định đã chạy được
npm run dev            # server :8787 + web :5173
```

Mở http://127.0.0.1:5173

1. Chọn symbol và **khung chính** trên toolbar (khung đang xem = khung chính).
2. Ở panel bên phải, tick **khung phụ** (tối đa 3) hoặc chọn **preset**. Thứ tự phân tích luôn là khung lớn → khung nhỏ.
3. Chọn **Agent** (Claude Code / Antigravity) và model (hoặc để Mặc định), rồi bấm **Analyze**. Tiến trình agent hiện trực tiếp; xong thì overlay được vẽ lên chart.
   Cuối phân tích có **Setup**: quyết định *Vào lệnh* / *Chờ setup* / *Đứng ngoài*, tối đa 2 setup (entry, SL, TP, R:R ≥ `SETUP_MIN_RR`, mặc định 2). Click thẻ setup để chỉ vẽ setup đó.
4. Tab **Lịch sử**: mở lại các phân tích cũ trên dữ liệu hiện tại.

`http://127.0.0.1:5173/?demo=1` vẽ một phân tích giả để kiểm tra renderer (`?demo=enter`, `?demo=aside` cho các quyết định khác).

### Dùng từ Claude Code / agy tương tác

Mở Claude Code tại thư mục project (file `.mcp.json` khai báo MCP server `wyckoff`; với `agy` là `.agents/mcp_config.json`), khi `npm run dev` đang chạy:

> Phân tích Wyckoff BTCUSDT khung 4h, khung phụ 1d và 5m, rồi submit_analysis

Kết quả tự hiện lên UI (qua SSE `/api/events`).

## Kiến trúc

```
apps/web      React + lightweight-charts v5: chart, overlay renderer, panel phân tích
apps/server   Fastify: klines (Binance + cache SQLite), điều phối phân tích, validator, runner `claude -p`
apps/mcp      MCP server stdio: get_analysis_request, get_klines, get_features, get_chart_screenshot, submit_analysis
packages/shared  Contract dùng chung (zod schema AnalysisSubmission/AnalysisResult, timeframes)
prompts/wyckoff.md  System prompt phương pháp Wyckoff
```

Luồng: UI `POST /api/analyses` → server spawn `claude -p --mcp-config .mcp.json --strict-mcp-config --tools "" --allowedTools "mcp__wyckoff__*"` → agent gọi tool MCP → `submit_analysis` → validator (snap time/giá về nến thật, kiểm tra top-down, kiểm tra setup + tính lại R:R) → SQLite → SSE → UI vẽ.

Chi tiết contract: [SPEC.md](SPEC.md). Plan: [plans/wyckoff-chart-agent.md](plans/wyckoff-chart-agent.md).

## Lệnh

| Lệnh | Mô tả |
|---|---|
| `npm run dev` | Server + web (watch) |
| `npm test` | Vitest |
| `npm run typecheck` | `tsc` cho mọi workspace |
| `npm run lint` | ESLint |
| `npm run build:web` | Build web tĩnh |
| `npx tsx scripts/screenshot.ts [url] [out.png]` | Chụp ảnh UI (dùng Chrome đã cài) |
| `npm run pm2:start` / `pm2:restart` / `pm2:stop` / `pm2:logs` | Chạy nền bằng pm2 (xem bên dưới) |

## Chạy bằng pm2

```bash
npm run pm2:start      # build web rồi chạy wca-server (:8787) + wca-web (:5173, vite preview + proxy /api)
npm run pm2:logs       # xem log
npm run pm2:restart    # sau khi pull/sửa code (build lại web)
npm run pm2:stop
pm2 save && pm2 startup   # tự chạy lại khi khởi động máy (làm theo lệnh pm2 in ra)
```

* Mở `http://127.0.0.1:5173` như khi dev. MCP `wyckoff` không chạy bằng pm2 — agent tự spawn qua stdio.
* Không chạy cùng lúc với `npm run dev` (trùng cổng 5173/8787).
* Server chạy **không watch**: sửa code server → `npm run pm2:restart`.
* pm2 lấy PATH từ shell lúc `pm2 start`. Nếu log báo không tìm thấy `claude`/`agy`, đặt `CLAUDE_BIN`/`AGY_BIN` là đường dẫn tuyệt đối trong `.env` rồi restart.
