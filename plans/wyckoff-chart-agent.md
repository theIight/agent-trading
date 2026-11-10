# Plan: Wyckoff Chart Agent

> Project mới: `~/SSD/projects/wyckoff-chart-agent`
> Mục tiêu: bỏ bước chụp ảnh TradingView thủ công. UI hiển thị chart giống TradingView, agent đọc dữ liệu nến trực tiếp, phân tích Wyckoff rồi **vẽ kết quả lên chính chart đó** (sự kiện, phase, trading range, kịch bản dự đoán, kế hoạch hành động).

---

## 1. Requirements / Spec

### 1.1. Chức năng bắt buộc (MVP)
1. **Chart giống TradingView**
   - Nến OHLC + volume, dark/light theme, crosshair, zoom/pan, thang giá bên phải.
   - Mặc định `BTCUSDT` (Binance USDⓈ-M Futures); đổi được symbol và timeframe hiển thị: `1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W`.
   - **Chọn bộ khung phân tích tự do** (không cố định 3 khung): xem mục 2.5.
   - Nến realtime (nến đang chạy cập nhật qua WebSocket).
2. **Phân tích bằng agent — kích hoạt từ UI**
   - Người dùng bấm nút `Analyze` trên UI → server chạy **Claude Code headless** (`claude -p`) gắn MCP server của project → agent lấy dữ liệu OHLCV nhiều khung qua tool MCP, phân tích theo Wyckoff, nộp kết quả qua tool → UI vẽ.
   - Không cần `ANTHROPIC_API_KEY`: dùng Claude Code đã đăng nhập trên máy.
   - Vẫn dùng được từ Claude Code tương tác (gõ "phân tích BTC 4h"), kết quả cũng tự đẩy lên UI.
   - Agent **không cần ảnh chụp**: nhận dữ liệu số + đặc trưng đã tính sẵn (swing, ATR, volume). Ảnh chart (chụp từ chính UI bằng `takeScreenshot()`) chỉ là đầu vào phụ, tùy chọn.
3. **Overlay kết quả lên chart**
   - **Sự kiện Wyckoff**: PS, SC/BC, AR, ST, Spring/UTAD, Test, SOS/SOW, LPS/LPSY, BU/JAC… → marker có nhãn tại đúng nến.
   - **Trading Range**: hộp chữ nhật TRH/TRL, đường Creek/Ice.
   - **Phase A–E**: dải nền theo thời gian.
   - **Dự đoán**: 1–3 kịch bản (đường nét đứt kéo sang tương lai), mỗi kịch bản có xác suất + điểm vô hiệu.
   - **Hành động**: công cụ Long/Short Position như TDV (vùng Entry / SL / TP1 / TP2, R:R) hoặc "Đứng ngoài" kèm điều kiện kích hoạt.
4. **Panel phân tích**: tóm tắt, bias, danh sách sự kiện (click → chart cuộn tới nến), lý do, độ tin cậy.
5. **Lịch sử**: lưu mỗi lần phân tích; mở lại để xem overlay cũ trên dữ liệu hiện tại (so sánh dự đoán vs thực tế).

### 1.2. Ngoài phạm vi MVP
- Tự động đặt lệnh (đã có ở `pumping-token-detect`; project này chỉ phân tích/hiển thị).
- Indicator tùy biến kiểu Pine Script, công cụ vẽ tay đầy đủ như TDV.
- Đa người dùng / đăng nhập (giai đoạn đầu chạy local; deploy VPS làm sau).
- Phân tích định kỳ tự động + gửi Telegram (làm sau; hiện chỉ phân tích khi thao tác trên UI).
- Chế độ gọi Claude API trực tiếp (`@anthropic-ai/sdk`) — để sau, thiết kế runner dạng interface để thêm dễ dàng.
- Nguồn dữ liệu BingX — để sau (adapter).

### 1.3. Ràng buộc
- Dữ liệu agent đọc phải là **nến đã đóng**; nến đang chạy chỉ dùng để hiển thị.
- Mọi `time`/`price` agent trả về phải được **validate & snap** về nến có thật (giá nằm trong [low, high] của nến đó, sai số cho phép nhỏ) trước khi vẽ — chống agent "bịa" toạ độ.
- Không gửi hàng nghìn nến thô vào prompt: tối đa ~300–500 nến/khung, định dạng CSV gọn.

---

## 2. Technical Design

### 2.1. Kiến trúc tổng quan

```
┌──────────────── apps/web (React + Vite) ────────────────┐
│  lightweight-charts v5 (thư viện chart của TradingView)  │
│  ├─ CandlestickSeries + Volume histogram                 │
│  ├─ Overlay renderer: markers / box primitives / bands / │
│  │   forecast lines / position tool                      │
│  └─ Analysis panel + history                             │
└──────▲──────────── REST + SSE ──────────────▲────────────┘
       │ live klines (WS sàn, trực tiếp)      │
┌──────┴──────────── apps/server (Fastify) ───┴────────────┐
│  market/   : fetch + cache klines (SQLite)               │
│  features/ : swings, ATR, volume stats, BOS/CHoCH,       │
│              Wyckoff hints (port từ pumping-token-detect)│
│  runner/   : spawn `claude -p` headless, parse stream-json│
│              → tiến trình SSE                             │
│  validate/ : zod schema + snap time/price                │
│  mcp/      : MCP server (stdio) — tools cho agent        │
└──────▲───────────────────────────────────────────────────┘
       │ stdio MCP / HTTP nội bộ
┌──────┴──────────── Claude Code CLI (headless) ───────────┐
│  claude -p --mcp-config mcp.json --strict-mcp-config      │
│         --allowedTools "mcp__wyckoff__*"                  │
│         --output-format stream-json --verbose             │
└──────────────────────────────────────────────────────────┘
packages/shared : zod schema AnalysisResult + types dùng chung
```

### 2.2. Tech stack
| Thành phần | Lựa chọn | Lý do |
|---|---|---|
| Chart | `lightweight-charts` v5 (TradingView, Apache-2.0) | Giao diện gần như TDV, hỗ trợ series markers, price lines, custom primitives (vẽ box, band, position tool) |
| Frontend | React + Vite + TypeScript, Zustand cho state | Nhẹ, nhanh |
| Backend | Node 22 + Fastify + TypeScript | Cùng hệ sinh thái với repo hiện tại, tái dùng code JS |
| DB | SQLite (`better-sqlite3`) | Cache klines + lưu lịch sử phân tích, không cần server DB |
| Validate | `zod` (packages/shared) | Một schema dùng cho cả agent output, API và UI |
| Agent (giai đoạn 1) | **Claude Code CLI headless** (`claude -p`, đã có v2.1.x trên máy) + MCP server (`@modelcontextprotocol/sdk`, stdio) | Dùng gói Claude Code sẵn có, không cần API key; model cấu hình qua `--model` |
| Agent (sau) | Claude API (`@anthropic-ai/sdk`) qua cùng interface `AgentRunner` | Khi deploy VPS không có Claude Code đăng nhập |
| Test | Vitest (unit), Playwright (screenshot overlay) | |
| Monorepo | npm workspaces: `apps/web`, `apps/server`, `packages/shared` | |

### 2.3. Nguồn dữ liệu
- **Đã chốt: Binance USDⓈ-M Futures** public API (`/fapi/v1/klines`, WS `wss://fstream.binance.com/ws/btcusdt@kline_<tf>`) — không cần API key. Browser subscribe WS trực tiếp; server dùng REST cho agent.
- Adapter interface `MarketDataProvider { getKlines(symbol, tf, limit, endTime?) ; subscribe(symbol, tf, cb) }` để thêm BingX sau.
- Cache: bảng `klines(symbol, tf, open_time, o,h,l,c,v)`; chỉ fetch phần thiếu.

### 2.4. Contract trung tâm: `AnalysisResult` (packages/shared)
```ts
AnalysisResult = {
  id, symbol, createdAt, model,
  primaryTimeframe: '1h' | '4h' | ...,
  dataWindow: { tf, from, to }[],          // các khung agent đã đọc
  schematic: 'ACCUMULATION' | 'REACCUMULATION' | 'DISTRIBUTION' | 'REDISTRIBUTION' | 'UNCLEAR',
  currentPhase: 'A' | 'B' | 'C' | 'D' | 'E' | null,
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  confidence: 0..1,
  summary: string,                          // tiếng Việt
  topDown: { tf, role: 'HTF'|'PRIMARY'|'LTF', bias, phase, note }[],  // thứ tự khung lớn → nhỏ
  events: { type: WyckoffEventType, tf, time, price, confidence, note }[],
  ranges: { tf, start, end, top, bottom, label, creek?, ice? }[],
  phases: { phase: 'A'..'E', start, end }[],
  levels: { kind: 'SUPPORT'|'RESISTANCE'|'CREEK'|'ICE'|'INVALIDATION', price, note }[],
  scenarios: {
    name, probability,                      // tổng ≈ 1
    path: { time, price }[],                // time có thể ở tương lai
    trigger, invalidation: number, note
  }[],
  action: {
    type: 'LONG' | 'SHORT' | 'WAIT',
    entry?, stopLoss?, takeProfits?: number[], riskReward?,
    condition: string                       // vd "Chờ LPS retest 64.2k với volume thấp"
  },
  warnings: string[]                        // các chỗ validator đã sửa/loại
}
```
- `WyckoffEventType` là enum cố định (PS, SC, BC, AR, ST, SPRING, UTAD, TEST, SOS, SOW, LPS, LPSY, BU, JAC, UT, SHAKEOUT…).
- **Validator** (server, trước khi lưu/vẽ):
  - `time` của event/range/phase → snap về `open_time` gần nhất của khung `tf`; ngoài cửa sổ dữ liệu → loại + warning.
  - `price` của event phải trong `[low − ε, high + ε]` của nến đó (ε = 0.1×ATR); sai thì snap về high/low gần nhất + warning.
  - Trade plan: LONG phải `SL < entry < TP`, SHORT ngược lại; tính lại R:R ở server, không tin số agent tự tính.
  - Xác suất scenario chuẩn hóa về tổng 1.

### 2.5. Agent flow (Claude Code + MCP)
**Chọn khung phân tích (không cố định):**
- Khung hỗ trợ: `1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W`.
- Trên UI có bộ chọn trước khi bấm `Analyze`:
  - **Khung chính** (bắt buộc, 1 khung) — khung mà kết quả (events, range, phase, action) được vẽ chủ yếu; mặc định = khung đang xem trên chart.
  - **Khung phụ** (chọn nhiều, 0–3 khung) — làm ngữ cảnh khung lớn và/hoặc xác nhận khung nhỏ; tick chọn tự do trong danh sách trên.
  - Tổng tối đa 4 khung/lần phân tích (giới hạn kích thước context; cấu hình `AGENT_MAX_TFS`).
  - **Preset** lưu nhanh (sửa được, lưu localStorage): mặc định `4h + 1D + 5m`; thêm sẵn ví dụ `1h + 4h + 15m`, `1D + 1W + 4h`, `15m + 1h + 1m`.
- Số nến mỗi khung: mặc định 300 (`AGENT_BARS_PER_TF`); riêng `1W` lấy tối đa có sẵn (≤ 300).
- Server tự xếp vai trò theo độ dài khung so với khung chính (`HTF` nếu lớn hơn, `LTF` nếu nhỏ hơn) và ghi vào prompt để agent biết cách dùng.
- **Phân tích top-down bắt buộc (khung lớn → khung nhỏ)**:
  - Server sắp các khung đã chọn theo độ dài giảm dần (vd `1W → 1D → 4h → 5m`) và truyền thứ tự này vào prompt + `dataWindow`.
  - Agent phải đọc và kết luận bias/cấu trúc của khung lớn nhất trước, rồi lần lượt xuống khung nhỏ hơn; khung nhỏ chỉ dùng để **xác nhận / tìm điểm vào**, không được đảo ngược kết luận khung lớn trừ khi nêu rõ lý do (vd khung lớn đã phá cấu trúc).
  - Khi khung nhỏ mâu thuẫn khung lớn → ưu tiên khung lớn, ghi vào `warnings` / `tfConflicts`, `action` mặc định `WAIT` hoặc giảm `confidence`.
  - `AnalysisResult` có thêm `topDown: { tf, role: 'HTF'|'PRIMARY'|'LTF', bias, phase, note }[]` theo đúng thứ tự lớn → nhỏ; validator kiểm tra thứ tự và đủ mọi khung đã chọn. Panel UI hiển thị chuỗi này từ trên xuống.
- Agent vẫn có thể tự gọi `get_klines` cho khung khác trong danh sách hỗ trợ nếu cần, nhưng chỉ vẽ kết quả với `tf` hợp lệ.

1. UI bấm `Analyze` → `POST /api/analyses {symbol, primaryTf, contextTfs[]}` → server validate (khung hợp lệ, không trùng, tổng ≤ `AGENT_MAX_TFS`) → tạo bản ghi `analysis` trạng thái `RUNNING`, sinh `analysisId`.
2. `ClaudeCodeRunner` spawn:
   ```
   claude -p "<prompt Wyckoff + analysisId + symbol + khung>" \
     --mcp-config ./mcp.json --strict-mcp-config \
     --allowedTools "mcp__wyckoff__*" \
     --output-format stream-json --verbose [--model $AGENT_MODEL]
   ```
   - `--strict-mcp-config` + `--allowedTools` giới hạn agent chỉ dùng tool của project (không đọc/sửa file, không chạy shell).
   - Timeout cứng (mặc định 5 phút), kill process khi hết hạn hoặc người dùng bấm Cancel.
   - Chỉ chạy 1 phân tích cùng lúc (hàng đợi đơn giản).
3. MCP server (`mcp__wyckoff__*`) cung cấp tools:
   - `get_klines(symbol, tf, limit, endTime?)` — CSV gọn `i,time,o,h,l,c,v`, chỉ nến **đã đóng**.
   - `get_features(symbol, tf)` — swing high/low (fractal 2/2), nhãn HH/HL/LH/LL, BOS/CHoCH, ATR14, volume MA20, nến climax (≥ 1.5× MA20), ứng viên Trading Range — port từ `marketStructure.js` & `wyckoffPattern.js` của repo `pumping-token-detect` (chỉ pure function).
   - `get_chart_screenshot(analysisId)` (tùy chọn) — ảnh UI chụp bằng `chart.takeScreenshot()` gửi kèm request, để agent đối chiếu trực quan.
   - `submit_analysis(analysisId, AnalysisResult)` — validator chạy ngay trong tool; nếu lỗi schema trả lại lỗi chi tiết để agent sửa và nộp lại (tối đa 3 lần).
   - MCP server là tiến trình stdio do Claude Code spawn → gọi về Fastify qua HTTP nội bộ (`127.0.0.1`) để lấy dữ liệu và nộp kết quả (một nguồn dữ liệu/DB duy nhất).
4. Runner đọc `stream-json` → chuyển các tool call thành sự kiện tiến trình SSE ("Đang đọc 1D…", "Đang tính features 5m…", "Đã nộp kết quả").
5. Kết quả hợp lệ → lưu SQLite, trạng thái `DONE` → UI vẽ overlay. Process kết thúc mà chưa `submit_analysis` → `FAILED` kèm log.
6. **Dùng từ Claude Code tương tác**: cùng MCP server đăng ký trong Claude Code của bạn; `submit_analysis` không có `analysisId` sẽ tự tạo bản ghi mới và đẩy lên UI qua `/api/events`.
7. Interface `AgentRunner { run(request, onProgress): Promise<void>; cancel() }` để sau thêm `ClaudeApiRunner` khi deploy VPS.

### 2.6. Overlay renderer (apps/web)
| Thành phần | Cách vẽ trong lightweight-charts v5 |
|---|---|
| Event | `createSeriesMarkers` — arrow + text (`SC`, `Spring`…), màu theo loại (cầu xanh / cung đỏ) |
| Trading Range | Custom `ISeriesPrimitive` vẽ rectangle + nhãn |
| Creek / Ice / levels | `createPriceLine` (nét đứt, có title) |
| Phase A–E | Primitive vẽ dải nền dọc + nhãn ở đáy chart |
| Kịch bản | `LineSeries` nét đứt; thêm whitespace data ở tương lai để mở rộng time scale; độ đậm theo xác suất |
| Action | Primitive "Position tool" giống TDV: vùng xanh (entry→TP), đỏ (entry→SL), nhãn R:R |
- Mỗi layer bật/tắt riêng (Events / Range / Phases / Forecast / Action).
- Overlay gắn với `AnalysisResult.id`; đổi timeframe vẫn hiển thị event của khung khác nếu nằm trong cửa sổ (snap theo thời gian).

### 2.7. API server
| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/klines?symbol&tf&limit&endTime` | Klines (cache) |
| POST | `/api/analyses` `{symbol, primaryTf, contextTfs[], screenshot?, model?}` | Tạo bản ghi + spawn Claude Code, trả `analysisId` |
| POST | `/api/analyses/:id/cancel` | Kill process đang chạy |
| GET | `/api/analyses/:id/stream` | SSE tiến trình + kết quả |
| POST | `/internal/analyses/:id/result` | MCP nộp kết quả (chỉ bind `127.0.0.1`) |
| GET | `/api/analyses?symbol` | Lịch sử |
| GET | `/api/analyses/:id` | Một kết quả |
| GET | `/api/events` | SSE chung (kết quả đẩy từ MCP) |

### 2.8. Cấu trúc thư mục dự kiến
```
wyckoff-chart-agent/
  apps/web/src/{chart/, overlays/, panels/, store/, api/}
  apps/server/src/{market/, features/, runner/, validate/, db/}
  apps/mcp/src/            # MCP server stdio (tools mcp__wyckoff__*)
  mcp.json                 # config MCP cho claude -p và Claude Code tương tác
  prompts/wyckoff.md       # prompt hệ thống phương pháp Wyckoff
  packages/shared/src/{schema.ts, wyckoff.ts}
  tests/fixtures/          # klines mẫu BTC + AnalysisResult mẫu
  plans/  AGENTS.md  SPEC.md  .env.example
```

### 2.9. Config / env
```
AGENT_RUNNER=claude-code          # sau: claude-api
CLAUDE_BIN=claude
AGENT_MODEL=                      # rỗng = model mặc định của Claude Code
AGENT_TIMEOUT_MS=300000
MARKET_PROVIDER=binance-futures
DEFAULT_SYMBOL=BTCUSDT
DEFAULT_TF=4h
SUPPORTED_TFS=1m,5m,15m,30m,1h,4h,1d,1w
DEFAULT_CONTEXT_TFS=1d,5m         # preset mặc định cho khung chính 4h
AGENT_MAX_TFS=4                   # tổng khung chính + phụ
AGENT_BARS_PER_TF=300
HOST=127.0.0.1                    # local; VPS đổi sau
PORT=8787
DB_PATH=./data/app.db
```

---

## 3. Implementation Steps

| # | Milestone | Nội dung | Kết quả kiểm chứng |
|---|---|---|---|
| M0 | Scaffold | npm workspaces, TS, ESLint, Vitest, `.env.example`, `AGENTS.md`, `SPEC.md`, git init | `npm run lint`, `npm run typecheck` pass |
| M1 | Chart như TDV | Market provider Binance + cache SQLite; UI nến + volume, đổi TF/symbol, WS realtime, theme | Mở UI thấy BTC 4h realtime, đổi TF mượt |
| M2 | Contract + renderer | `AnalysisResult` zod; renderer cho 6 layer; nạp **fixture JSON viết tay** để vẽ (chưa cần agent) | Screenshot Playwright đúng các layer trên fixture |
| M3 | Feature engine | Port swings/ATR/BOS/CHoCH/climax/TR candidates thành pure function TS + test | Unit test với fixture nến BTC |
| M4 | Validator | Snap time/price, kiểm tra trade plan, chuẩn hóa xác suất | Unit test các case sai toạ độ, SL/TP ngược |
| M5 | MCP server | `apps/mcp`: `get_klines`, `get_features`, `get_chart_screenshot`, `submit_analysis`; prompt `prompts/wyckoff.md`; `mcp.json` | Đăng ký vào Claude Code tương tác, gõ "phân tích BTC 4h" → kết quả hợp lệ lưu DB |
| M6 | Claude Code runner | `ClaudeCodeRunner` spawn `claude -p`, parse stream-json → SSE, timeout/cancel, hàng đợi 1 job | Test parser với stream-json ghi sẵn; 1 lần chạy thật |
| M7 | Tích hợp UI | Bộ chọn khung chính + khung phụ + preset, nút Analyze/Cancel, progress stream, panel, click-to-event, history, toggle layer, đính kèm screenshot | Bấm Analyze trên UI → overlay xuất hiện ≤ ~3 phút |
| Sau MVP | Mở rộng | `ClaudeApiRunner` + deploy VPS (PM2); phân tích định kỳ + Telegram; chấm dự đoán đúng/sai; adapter BingX | Plan riêng khi làm |

Thứ tự bắt buộc: M2 + M3 + M4 (pure logic, có test) xong trước khi nối agent (M5, M6) và UI live (M7).

---

## 4. Tests / Acceptance Criteria
1. **Chart**: BTCUSDT (Binance Futures) hiển thị đúng OHLCV cho 8 timeframe (1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W); nến đang chạy cập nhật < 2s.
1b. **Chọn khung**: chọn được bất kỳ tổ hợp khung chính + 0–3 khung phụ; request sai (trùng khung, khung không hỗ trợ, > 4 khung) bị từ chối với thông báo rõ; agent nhận đúng các khung đã chọn kèm vai trò HTF/LTF.
2. **Renderer**: Từ fixture `AnalysisResult`, cả 6 layer vẽ đúng vị trí (snapshot Playwright); bật/tắt từng layer hoạt động.
3. **Validator**: 100% event được vẽ có `time` khớp nến thật và `price` trong biên nến (±ε); trade plan sai chiều bị loại kèm warning; R:R tính lại ở server.
4. **Feature engine**: swing/BOS/CHoCH khớp kết quả code cũ trên cùng fixture (test so sánh).
5. **Agent**: trên 3 bộ dữ liệu BTC lịch sử có cấu trúc Wyckoff rõ (chọn tay), agent trả kết quả hợp lệ schema 100% lần chạy; sự kiện chính (SC/BC, Spring/UTAD, SOS/SOW) nằm trong ±3 nến so với đánh dấu tay ở ≥ 2/3 bộ.
6. **End-to-end**: bấm Analyze trên UI → Claude Code headless chạy → thấy tiến trình stream → overlay + panel + action hiện trên chart; Cancel dừng được process; mở lại từ lịch sử vẽ đúng.
7. **MCP**: agent headless chỉ gọi được tool `mcp__wyckoff__*` (không có tool file/shell); từ Claude Code tương tác `submit_analysis` → UI cập nhật không cần reload.
8. `npm run lint`, `npm run typecheck`, `npm test` pass.

---

## 5. Quyết định đã chốt (2026-11-09)
1. **Agent**: Claude Code qua MCP trước. Phân tích kích hoạt từ nút trên UI → server chạy `claude -p` headless. Claude API để sau (khi deploy VPS).
2. **Dữ liệu**: Binance USDⓈ-M Futures.
3. **Khung**: không cố định. Hỗ trợ `1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W`; người dùng chọn 1 khung chính + 0–3 khung phụ trên UI. Preset mặc định `4h + 1D + 5m`.
4. **Môi trường**: chạy local trước (`127.0.0.1`), deploy VPS sau.
5. **Phân tích định kỳ / Telegram**: làm sau; hiện chỉ phân tích khi thao tác trên UI.

---

## 6. Approval Status
- [x] **Đã duyệt (2026-11-09)** — người dùng xác nhận "bắt đầu đi", kèm bổ sung phân tích top-down khung lớn → khung nhỏ (mục 2.5).

### Tiến độ
- [x] M0 Scaffold
- [x] M1 Chart như TDV
- [x] M2 Contract + renderer
- [x] M3 Feature engine
- [x] M4 Validator
- [x] M5 MCP server
- [x] M6 Claude Code runner
- [x] M7 Tích hợp UI

### Ghi chú triển khai (2026-11-09)
- MCP gọi `/api/klines?closedOnly=true` công khai và tự tính features (import trực tiếp `apps/server/src/features`), nên server chỉ cần API nội bộ cho `request`, `screenshot` và `submit`.
- Runner thêm `--tools ""` (tắt toàn bộ tool có sẵn) và `--no-session-persistence`, ngoài `--strict-mcp-config` + `--allowedTools`.
- Đã chạy thật 2 lần qua `claude -p`: BTCUSDT 4h+1d+5m (58s, 0 warning) và 1h+4h+15m có kèm ảnh chart (56s, bấm từ UI).
- Chưa làm: snapshot Playwright tự động trong CI cho renderer (đang kiểm tra bằng `scripts/screenshot.ts` + unit test của `buildOverlayModel`); chưa đo tiêu chí 5 (so với đánh dấu tay trên 3 bộ dữ liệu lịch sử).
