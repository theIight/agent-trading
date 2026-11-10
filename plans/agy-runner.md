# Plan — Chọn agent phân tích: Claude Code hoặc Antigravity (`agy`)

## Approval Status

- [x] Đã duyệt (2026-11-09) — model mặc định agy: gemini-4-argon-high

## 1. Requirements / Spec

- Mỗi lần bấm Analyze, người dùng chọn **agent**:
  - **Claude Code** (`claude -p`, như hiện tại, mặc định).
  - **Antigravity** (`agy -p`). Model chọn trong danh sách `agy models`: Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus/Sonnet 5.5, GPT-OSS…
- Có thể chọn model cho từng agent (tuỳ chọn; để trống thì dùng mặc định trong config).
- UI ghi nhớ lựa chọn (localStorage).
- Lịch sử hiển thị phân tích do agent/model nào làm.
- Hai agent dùng chung MCP server `wyckoff`, prompt, validator và contract. Kết quả hiển thị giống hệt nhau.
- **Bảo mật bắt buộc:** agent headless chỉ được dùng tool `wyckoff`. Không được chạy shell, ghi file, duyệt web hay dùng MCP khác.

## 2. Khảo sát `agy` 1.4.12 (đã thử trong thư mục tạm, không đụng vào project)

| Hạng mục | Kết quả |
|---|---|
| Headless | `agy -p "<prompt>" --output-format stream-json --model <id>` |
| Output | NDJSON gồm `init` (danh sách tool, permission_mode), `step_update` (`step_type`: `user_input`, `agent_response` + `text_delta`, `tool` + `tool_info{name, parameters, error}`), `result` (`status`, `response`, `finished_reason`, `usage`). Exit code 3 khi lỗi. |
| MCP theo thư mục | `agy` tự nạp `<workspace>/.agents/mcp_config.json` (`{"mcpServers":{...}}`). MCP được gọi qua tool chung `call_mcp_tool` (ServerName, ToolName). |
| Quyền mặc định | Setting toàn cục của máy này là `toolPermission: always-proceed`, nghĩa là headless **chạy được shell, ghi file, browser**. Phải ghi đè. |
| Khoá quyền | `--settings '<json>'` chỉ áp cho phiên, không lưu. Đã kiểm chứng `{"toolPermission":"request-review","permissions":{"allow":["mcp(wyckoff/*)"],"deny":["command(*)","write_file(*)", …]}}` → gọi `wyckoff` OK; ghi file, shell, crawl web đều bị từ chối. |
| Lưu ý | Một tool bị **tự động** từ chối (không khớp rule nào) sẽ **kết thúc cả lượt chạy**. Tool khớp rule `deny` thì agent nhận lỗi và chạy tiếp. Vì vậy cần `deny` rõ ràng mọi nhóm tool. |
| System prompt | Không có `--append-system-prompt`, nên ghép `prompts/wyckoff.md` vào đầu prompt. |

## 3. Technical Design

### Config (`.env` / `config.ts`)

- `AGENT_RUNNERS=claude-code,agy`: các agent được bật.
- `AGENT_RUNNER`: mặc định `claude-code`.
- `AGY_BIN=agy`, `AGY_MODEL`: mặc định để trống (dùng model mặc định của agy). Đề xuất `gemini-4-argon-high`.
- `AGENT_MODEL` giữ nguyên, dùng cho Claude.

### Runner

- `apps/server/src/runner/agyRunner.ts` (`AgyRunner implements AgentRunner`):
  - spawn `agy -p <system prompt + user prompt> --output-format stream-json [--model] --settings <JSON khoá quyền> --disable-slash-commands`, cwd = project root.
  - Timeout và hủy (SIGTERM → SIGKILL) dùng chung logic với `ClaudeCodeRunner`. Tách helper `spawnAgent` nếu cần.
  - Env cho MCP: `WCA_SERVER_URL`, `WCA_INTERNAL_TOKEN`.
- `runner/agyStreamParser.ts`: chuyển NDJSON của agy thành `step`/`text` (tiếng Việt, cùng kiểu với `streamParser.ts`; vd `call_mcp_tool wyckoff/get_klines 1d` → "Đọc nến 1D"). `result.status != SUCCESS` hoặc exit ≠ 0 → lỗi.
- **JSON khoá quyền** (`buildAgySettings()`, có unit test):
  - `toolPermission: "request-review"`.
  - `allow: ["mcp(wyckoff/*)"]`.
  - `deny`: `command(*)`, `write_file(*)`, `execute_url(*)`, `read_url(*)`, `mcp(<mọi MCP khác>/*)` và các nhóm browser/subagent. Danh sách tên rule chốt lúc triển khai bằng test thực tế với `agy`.
  - Thứ tự ưu tiên giữa `deny mcp(*)` và `allow mcp(wyckoff/*)` sẽ kiểm chứng. Nếu `deny` thắng thì liệt kê các MCP khác từ `agy mcp list` lúc khởi động.
- **Registry runner**: `buildApp` tạo map `{ 'claude-code': ClaudeCodeRunner, agy: AgyRunner }` theo `AGENT_RUNNERS`. Kiểm tra binary có trong PATH lúc khởi động; thiếu thì đánh dấu không khả dụng.

### MCP config cho agy

- Thêm `.agents/mcp_config.json` (commit, tương tự `.mcp.json` của Claude) khai báo server `wyckoff`.
- Nếu agy chạy stdio với đường dẫn tương đối không ổn định, server tự sinh file này lúc khởi động với đường dẫn tuyệt đối. File sinh ra nằm trong `.gitignore`. Kiểm chứng khi triển khai.
- Lợi ích phụ: mở `agy` tương tác tại project cũng dùng được MCP `wyckoff` (giống Claude Code tương tác).

### API / contract

- `POST /api/analyses` thêm `runner?` (mặc định `AGENT_RUNNER`) và `model?` (đã có). Runner không bật hoặc không khả dụng → 400.
- `GET /api/runners` → `[{id, label, available, defaultModel, models[]}]`. `models` của agy lấy từ `agy models --output-format json` (cache 10 phút), của Claude là alias `opus` / `sonnet` / `haiku`.
- `AnalysisRecord` / DB: thêm cột `runner`. `AnalysisResult.model` ghi `agy · gemini-4-argon-high` hoặc `claude-code · opus`. Bản ghi cũ coi là `claude-code`.
- Hàng đợi vẫn chạy tuần tự 1 job/lần cho cả hai agent.

### UI (tab Phân tích)

- Thêm khối **Agent**: 2 nút chọn (Claude Code / Antigravity) và dropdown model của agent đó ("Mặc định" + danh sách). Agent không khả dụng thì disable kèm tooltip.
- Tab Lịch sử và meta kết quả hiện agent · model.

### Ảnh chart

- Chưa rõ `agy` có nhận ảnh từ MCP (`get_chart_screenshot`) hay không. Sẽ kiểm chứng; nếu không nhận thì ẩn tuỳ chọn "Gửi kèm ảnh chart" khi chọn agy.

## 4. Implementation Steps

1. Config + `buildAgySettings` + `agyStreamParser` + test (`tests/agyRunner.test.ts`).
2. `AgyRunner`, registry runner, `.agents/mcp_config.json`. Kiểm chứng khoá quyền với `agy` thật (thử ghi file, chạy shell, gọi MCP khác đều bị chặn).
3. Service / DB / API: `runner` trong request và bản ghi, `GET /api/runners`. Cập nhật test analysisService.
4. UI chọn agent + model, lịch sử.
5. SPEC.md (mục 5–7), README, AGENTS.md (quy tắc quyền cho agy).
6. Kiểm chứng: typecheck, lint, test, build:web; chụp ảnh UI; **1 lần chạy thật với agy** (1D → 4H → 5m) và 1 lần với Claude để chắc không hỏng.

## 5. Tests / Acceptance Criteria

1. Unit test:
   - `buildAgySettings` có `allow mcp(wyckoff/*)` và đủ các `deny`.
   - Parser chuyển đúng các event mẫu (init, tool DONE/ERROR, text, result SUCCESS/ERROR).
   - Args/timeout của `AgyRunner`.
   - Service chọn đúng runner; runner không bật → lỗi.
2. Kiểm chứng an toàn (thủ công, ghi kết quả vào plan): agy headless từ project không ghi được file, không chạy được shell, không gọi được MCP khác.
3. Chạy thật với agy: nộp `tradePlan` hợp lệ qua `submit_analysis`, UI hiển thị đúng, lịch sử ghi "agy · <model>".
4. Claude Code vẫn chạy như cũ.
5. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:web` đều đạt.

## 6. Ngoài phạm vi

- Chạy song song nhiều agent cùng lúc, hoặc so sánh kết quả 2 agent trên cùng dữ liệu.
- Runner gọi API trực tiếp (Claude API / Gemini API) không qua CLI.

## 7. Tiến độ (2026-11-09)

- [x] 1. Config (`AGENT_RUNNERS`, `AGY_BIN`, `AGY_MODEL`, `AGY_TIMEOUT_MS`), `buildAgySettings`, `agyStreamParser`, test `tests/agyRunner.test.ts`
- [x] 2. `AgyRunner`, `spawnAgent` dùng chung (refactor `ClaudeCodeRunner`), registry runner trong `buildApp`, `.agents/mcp_config.json` cho agy tương tác
- [x] 3. Service / DB (cột `runner`, `model`) / `GET /api/runners`, test chọn runner
- [x] 4. UI chọn agent + model, lịch sử ghi agent · model
- [x] 5. SPEC.md (5, 6.1, 6.2), README, AGENTS.md
- [x] 6. Kiểm chứng: typecheck, lint, test (78), build:web; ảnh UI; chạy thật agy `gemini-4-argon-high` (API, ~6 phút, DONE, 0 warning) và `gemini-3.8-flash-high` (UI + ảnh chart, 92s, DONE); Claude Code hồi quy (71s, DONE, 0 warning)

### Thay đổi so với thiết kế (phát hiện khi kiểm chứng với agy 1.4.12)

- `--settings` một mình không đủ: `search_web` và đọc file trong workspace không đi qua permission; rule theo đường dẫn (`read_file(<dir>/*)`) không khớp. → Thêm 2 lớp: custom agent `wyckoff-analyst` (`excludeDefaultComponents`, `tools: [view_file]`) và workspace rỗng `data/agy-workspace`.
- `deny mcp(*)` thắng `allow mcp(wyckoff/*)` → liệt kê MCP khác từ `agy mcp list`.
- Custom agent cần `view_file` để đọc schema MCP (agy nạp lười); đã kiểm chứng đọc ngoài workspace (file canary, file project, setting agy) đều bị từ chối, chỉ thư mục schema MCP của agy được phép.
- `agy models` chưa có `--output-format json` → parse text.
- Timeout riêng `AGY_TIMEOUT_MS=600000` (Gemini Argon High mất ~6 phút; 300s bị timeout ở lần chạy đầu).
- Prompt thêm quy tắc không nộp bản thử (Gemini Flash từng nộp placeholder "test" trước khi đọc dữ liệu).
- `supportsScreenshot = true` cho agy: `get_chart_screenshot` gọi thành công; chưa xác minh model thực sự "nhìn" được ảnh.
