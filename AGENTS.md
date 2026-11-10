# AGENTS.md — Quy tắc cho AI Agent trong `wyckoff-chart-agent`

## Quy trình

* **Duyệt plan trước khi code**: Feature mới / thay đổi hành vi, contract, config, flow → tạo/cập nhật `plans/<feature>.md` (Requirements/Spec, Technical Design, Implementation Steps, Tests/Acceptance, Approval Status). Gửi tóm tắt và **dừng** tới khi người dùng xác nhận rõ (`duyệt`, `approve`, `apply`). Trước đó chỉ được đọc và sửa file plan.
* **Đổi phạm vi giữa chừng** → cập nhật plan, xin duyệt lại.
* **Đọc trước khi sửa**: [SPEC.md](SPEC.md), plan liên quan, `apps/server/src/config.ts`.
* **Thứ tự**: contract (`packages/shared`) → pure logic + test trong `tests/` → tích hợp server/MCP/UI → kiểm chứng.
* **Kiểm chứng trước khi kết thúc**: `npm run typecheck`, `npm run lint`, `npm test`; thay đổi UI thì chụp ảnh bằng `scripts/screenshot.ts`. Báo đúng lệnh đã chạy và kết quả; không coi bước chưa chạy là đạt.
* **Đồng bộ đặc tả**: thay đổi contract/hành vi → cập nhật `SPEC.md`.
* **Không tự ý sửa `.gitignore`** bằng quy tắc phủ định `!`.

## Quy tắc kỹ thuật

* `packages/shared/src/analysis.ts` là **nguồn chân lý** của contract agent ↔ server ↔ UI. Đổi schema phải cập nhật validator, renderer, prompt và test.
* Agent chỉ đọc **nến đã đóng** (`closedOnly=true`). Nến đang chạy chỉ để hiển thị.
* Mọi toạ độ agent trả về phải qua `validateSubmission` trước khi lưu/vẽ. Không tin R:R agent tự tính.
* Phân tích luôn **top-down khung lớn → khung nhỏ** (`sortTopDown`); khung lớn quyết định bối cảnh.
* Runner `claude -p` chỉ được phép dùng tool `mcp__wyckoff__*` (`--tools ""`, `--strict-mcp-config`). Runner `agy` giữ đủ 3 lớp khoá quyền trong `agyRunner.ts` (custom agent `tools: [view_file]` + `excludeDefaultComponents`, workspace rỗng `data/agy-workspace`, `--settings` allow `mcp(wyckoff/*)` / deny shell, ghi file, MCP khác). Đổi phiên bản agy hoặc cấu hình này phải kiểm chứng lại bằng agy thật (thử đọc file ngoài workspace, ghi file, chạy shell, gọi MCP khác). Không mở rộng quyền file/shell/web cho agent headless.
* API `/internal/*` chỉ nhận request từ localhost kèm header `x-wca-token` (`data/internal-token`).
* Không paste hàng trăm dòng nến hoặc JSON sàn vào prompt khi debug; chỉ trích 3–5 nến liên quan.
