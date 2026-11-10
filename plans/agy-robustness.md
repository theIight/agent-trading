# Plan — Giảm lỗi khi chạy bằng agy (Gemini)

## Approval Status

- [x] Đã duyệt (2026-11-09) — ngưỡng: summary ≥ 80 ký tự, ≥ 100 nến

## 1. Vấn đề (từ log hội thoại agy, phân tích 712cc4b6, gemini-3.8-flash-medium, 1D → 1H → 1m)

1. Model **không đọc schema** `submit_analysis` mà dò bằng cách nộp thử: `analysis: {}`, sau đó `summary: "test"`, `topDown: []`, `primaryTf: "1m"` (sai, khung chính là 1h). Mỗi lần chỉ sửa 1 lỗi.
2. MCP SDK chỉ báo 1–2 lỗi validate mỗi lần, kéo dài vòng thử–sai.
3. Model **đọc quá ít nến** (15–25 nến/khung, mặc định 300); đọc `limit: 15` thì bị lỗi (min 20).
4. Bản nộp placeholder vẫn qua được validator (lần Flash trước: DONE với nội dung "test").

## 2. Thay đổi đề xuất

### A. Đưa schema vào prompt (chỉ agy)

- File custom agent `wyckoff-analyst.md` thêm phụ lục "Định dạng submit_analysis": khung JSON mẫu đầy đủ (mọi trường bắt buộc, enum hợp lệ, ví dụ 1 event / range / phase / level / scenario / setup + refinedEntry).
- Khung mẫu sinh tự động từ một hằng số trong `packages/shared` (có test parse qua `analysisSubmissionSchema` để không lệch contract).
- Prompt người dùng của agy nhắc lại: `symbol`, `primaryTf`, đủ khung `topDown`.
- Claude Code không đổi (Claude đã thấy schema đầy đủ qua MCP).

### B. Báo đủ mọi lỗi trong 1 lần

- MCP `submit_analysis`: `analysis` nhận object bất kỳ (`z.record`) thay vì schema chặt, để server `validateSubmission` trả **toàn bộ** lỗi kèm đường dẫn trong 1 lần.
- Nếu agent đặt các trường kết quả ở cấp ngoài cùng (thiếu wrapper `analysis`), MCP tự gom lại.
- Server vẫn validate đầy đủ như cũ, nên không giảm an toàn.

### C. Chặn bản nộp placeholder (validator, áp dụng cả 2 agent)

Trả **lỗi** về agent (không lưu) khi:
- `summary` < 80 ký tự.
- `note` của bất kỳ bước `topDown` nào < 15 ký tự.
- `tradePlan.reason` < 20 ký tự.
- Các trường văn bản trên chỉ là từ placeholder (`test`, `todo`, `tbd`, `...`, `n/a`).
- `schematic` ≠ `UNCLEAR` mà `events` rỗng.

### D. Số nến tối thiểu

- `get_klines` / `get_features`: `limit` nhỏ hơn 100 thì **tự nâng lên 100** thay vì báo lỗi (min 20 hiện tại). Output ghi chú "(đã nâng limit lên 100)". Mặc định vẫn 300.
- Prompt: phải đọc ít nhất `barsPerTf` nến cho khung chính và khung HTF.

### E. Chuẩn hoá khung thời gian

- `tfSchema` chấp nhận chữ hoa (`1D`, `1H`, `4H`, `1W`) → đổi thành chữ thường. Prompt người dùng hiện in nhãn `1D`/`1H` nên model dễ chép sai.
- Riêng `1M` giữ nguyên là lỗi (mơ hồ giữa tháng và phút).

### F. UI

- Model chứa `flash` hoặc `low` hiển thị nhãn "(nhanh, kém chính xác)" trong dropdown.

## 3. Implementation Steps

1. Shared: `tfSchema` preprocess; hằng số khung JSON mẫu + test.
2. Validator: chặn placeholder (C) + test.
3. MCP: `submit_analysis` nhận object lỏng / gom trường ngoài cùng (B); clamp `limit` (D).
4. agyRunner: phụ lục schema trong file agent, prompt nhắc (A); test.
5. Prompt chung: số nến tối thiểu; UI nhãn model (F).
6. SPEC / plan; kiểm chứng: typecheck, lint, test, build; **chạy thật agy Flash Medium và Argon High** cùng bộ khung 1D → 1H → 1m; Claude hồi quy.

## 4. Acceptance

- agy Flash Medium: không còn nộp `analysis: {}` / placeholder được chấp nhận. Số lần `submit_analysis` bị từ chối ≤ 2. Đọc ≥ 100 nến mỗi khung.
- agy Argon High: DONE, 0–ít warning.
- Claude Code vẫn DONE.
- Unit test cho C, D, E và khung JSON mẫu khớp schema.

## 5. Ghi chú

- Flash là model nhỏ; dù sửa xong, chất lượng phân tích vẫn kém Argon High / Claude. Plan này chỉ nhắm vào việc nộp đúng định dạng và đủ dữ liệu.

## 6. Tiến độ (2026-11-09)

- [x] A. Phụ lục định dạng (`SUBMISSION_EXAMPLE` trong shared, test khớp schema) + nhắc ràng buộc trong prompt agy
- [x] B. MCP `submit_analysis`: union schema + looseObject, gom trường ngoài cùng; server trả đủ lỗi
- [x] C. Validator chặn placeholder (summary ≥ 80, note ≥ 15, reason ≥ 20, từ placeholder, schematic ≠ UNCLEAR cần event)
- [x] D. `limit` < 100 tự nâng; prompt yêu cầu `barsPerTf`
- [x] E. `normalizeTfInput` (validator, service, MCP `get_klines`/`get_features`)
- [x] F. UI nhãn "nhanh, kém chính xác" cho model flash / -low / haiku
- [x] Kiểm chứng: typecheck, lint, test (85), build:web. Chạy thật 1D → 1H → 1m:
  - agy Flash Medium: 300 nến/khung, 1 lần nộp bị từ chối (3 lỗi báo cùng lúc), DONE 133s, 6 events, 0 warning (trước: 15–25 nến, ≥ 4 lần nộp sai, bị hủy).
  - agy Argon High: DONE 324s, 0 lần từ chối, 16 events, 0 warning.
  - Claude Code Opus: DONE 71s, 0 lần từ chối, 0 warning.

## 7. Bổ sung — nộp đúng ngay lần đầu với Flash (đã duyệt 2026-11-09)

### Đã làm (chỉ prompt agy, không đổi contract)

- Tách `runner/agyFormat.ts`:
  - `REQUIRED_FIELDS_TEXT` liệt kê trường bắt buộc của từng object, sinh tự động từ zod.
  - `buildAgySkeleton` là khung Arguments điền sẵn analysisId / symbol / primaryTf / topDown (tf, role) cho từng lượt.
  - Checklist trước khi nộp.
  - Cảnh báo không chép số liệu ví dụ.
- Kết quả 5 lượt `gemini-3.8-flash-medium`:
  - Lỗi lần nộp đầu chỉ còn **thiếu `analysis.symbol`** (4/5 lượt). Lượt thứ 5 nộp đúng ngay.
  - Trước đó còn lỗi `primaryTf`, `scenarios[].bias`, `topDown` và placeholder; giờ đã hết.
  - Cả 5 lượt DONE sau ≤ 1 lần sửa, 0–1 warning.

### Đề xuất (cần duyệt vì đổi hành vi validator)

- `AnalysisService.submit` khi **có `analysisId`**: nếu bản nộp thiếu `symbol` hoặc `primaryTf` thì điền từ bản ghi phân tích, kèm warning "Server điền symbol/primaryTf từ yêu cầu phân tích".
- Có giá trị mà **sai** thì vẫn báo lỗi như cũ.
- Nộp không có `analysisId` (agent tương tác) thì vẫn bắt buộc đủ hai trường.
- Lý do: hai trường này thừa khi đã có `analysisId`, nên server điền không làm mất an toàn.
- Test: thiếu `symbol` + có `analysisId` → DONE kèm warning; sai `symbol` → lỗi; thiếu `symbol` + không có `analysisId` → lỗi.
- Kiểm chứng: chạy lại 3 lượt Flash Medium, kỳ vọng 0 lần bị từ chối.
- [x] Đã làm: `AnalysisService.submit` điền `symbol`/`primaryTf` khi có `analysisId` (+ test). Chạy lại 3 lượt Flash Medium (1D→1H→1m, 4H→1D→5m, 1H→15m→1m): **0 lần bị từ chối**, DONE 104–121s, warning duy nhất là "Server điền symbol từ yêu cầu phân tích".

## 8. Bổ sung — tham số mặc định cho tool MCP (đã duyệt 2026-11-09)

### Vấn đề

Flash vẫn gọi tool đầu tiên thiếu tham số hiển nhiên (`get_analysis_request` không có `analysisId`; `get_features`/`get_klines` không có `symbol`). Nó tự sửa ở lần gọi sau, nhưng mỗi lượt tốn thêm 1–2 vòng và hiện "Tool lỗi" trên UI.

### Đề xuất

- **Runner truyền ngữ cảnh lượt chạy cho MCP** qua biến môi trường:
  - `WCA_ANALYSIS_ID`, `WCA_SYMBOL`, `WCA_PRIMARY_TF`.
  - agy: ghi vào `env` của server `wyckoff` trong `data/agy-workspace/.agents/mcp_config.json` (file đã được ghi lại mỗi lượt).
  - Claude Code: thêm vào env của tiến trình `claude` (MCP con kế thừa, giống `WCA_SERVER_URL` hiện tại).
- **MCP dùng làm mặc định khi agent bỏ sót:**
  - `get_analysis_request.analysisId`, `get_chart_screenshot.analysisId` → `WCA_ANALYSIS_ID`.
  - `get_klines.symbol`, `get_features.symbol` → `WCA_SYMBOL`.
  - `submit_analysis.analysisId` → `WCA_ANALYSIS_ID`. Có biến này thì bản nộp luôn gắn vào lượt đang chạy, không tạo bản ghi tương tác mới.
- **Phiên tương tác** (không có biến môi trường): hành vi giữ nguyên. Thiếu tham số thì báo lỗi rõ ràng bằng tiếng Việt thay vì lỗi zod.
- **Hiển thị tiến trình:** "Đọc nến 1m (5 → 100 nến)" khi `limit` bị nâng.

### Test / kiểm chứng

- Unit test hàm chọn mặc định (có/không có env).
- Test args của runner có env ngữ cảnh.
- Chạy lại 3 lượt Flash Medium (1D → 1H → 1m…): kỳ vọng 0 "Tool lỗi" do thiếu tham số và 0 lần nộp bị từ chối.
- Claude hồi quy 1 lượt.
- [x] Đã làm (mục 8): `RUN_CONTEXT_ENV` + `MIN_KLINE_BARS` (shared), `runContextEnv` cho cả 2 runner, `resolveParam` trong MCP (mặc định analysisId/symbol từ env, lỗi tiếng Việt khi phiên tương tác thiếu), dòng tiến trình "(5 → 100 nến)"; test (89).
  - 3 lượt Flash Medium (1D→1H→1m 108s, 4H→1D→5m 125s, 1H→15m→1m 222s): **0 tool lỗi, 0 lần nộp bị từ chối, 0 warning**.
  - Claude Code hồi quy (1D→1H→1m): DONE 198s, 0 tool lỗi, 0 lần từ chối, 0 warning.
