# Plan — Trade Setup sau phân tích (có lựa chọn Đứng ngoài)

## Approval Status

- [x] Đã duyệt (2026-11-09)

## 1. Requirements / Spec

Sau khi phân tích top-down, agent phải đưa ra **quyết định giao dịch** rõ ràng kèm **setup cụ thể**, hoặc chủ động **đứng ngoài** khi bối cảnh chưa rõ.

Hiện tại `action` chỉ có một lệnh `LONG/SHORT/WAIT`, và `WAIT` gộp hai trường hợp khác nhau:
- "chờ một setup cụ thể" (đã biết vào ở đâu)
- "không có gì để làm"

Thay đổi:

1. **Quyết định (`tradePlan.decision`)**
   - `ENTER`: có setup vào được ngay ở giá hiện tại (lệnh market).
   - `WAIT_FOR_SETUP`: có 1–2 setup chờ điều kiện (giá về vùng entry hoặc xuất hiện sự kiện Wyckoff), chưa vào ngay.
   - `STAND_ASIDE`: đứng ngoài. Không có setup đủ rõ ràng, hoặc bối cảnh nhiễu / mâu thuẫn khung lớn.
   - Kèm `reason` (tiếng Việt) và `reconsiderWhen` (điều kiện hoặc mức giá cần theo dõi để quay lại phân tích; bắt buộc khi `STAND_ASIDE`).

2. **Setup (`tradePlan.setups[]`, tối đa 2: thường là 1 setup chính thuận khung lớn + 1 setup phương án B)**

   | Trường | Ý nghĩa |
   |---|---|
   | `name` | Tên ngắn, vd "Short LPSY retest Ice" |
   | `direction` | `LONG` / `SHORT` |
   | `entryType` | `MARKET` (vào ngay) / `LIMIT` (chờ giá hồi về vùng) / `STOP` (chờ phá vỡ) |
   | `tf` | Khung xác nhận entry (thường là khung LTF hoặc khung chính) |
   | `trigger` | Sự kiện Wyckoff cần thấy để vào (`SPRING`, `LPS`, `LPSY`, `BU`, `JAC`, `SOS`, `SOW`, `UTAD`, `TEST`, `OTHER`) + mô tả điều kiện volume/spread |
   | `entryLow`, `entryHigh` | Vùng entry (bằng nhau = một giá) |
   | `stopLoss` | Đặt sau điểm vô hiệu cấu trúc |
   | `takeProfits[1..3]` | Các mục tiêu |
   | `validUntil?` | Hết hạn setup (unix giây, tương lai); quá hạn mà chưa kích hoạt thì setup bị huỷ |
   | `scenario?` | Tên kịch bản trong `scenarios` mà setup dựa vào |
   | `confidence` | Độ tin cậy 0..1 |
   | `rationale` | Lý do theo Wyckoff |
   | `riskReward` | Server tính |

3. **Tương thích ngược**
   - `action` không còn do agent gửi. Server **suy ra** `action` từ `tradePlan` để lịch sử và code cũ vẫn chạy:
     - `ENTER` → LONG/SHORT của setup chính.
     - Còn lại → `WAIT`, kèm `condition` = trigger hoặc lý do.
   - Bản ghi cũ không có `tradePlan` → UI hiển thị như hiện tại (dựa trên `action`).

## 2. Technical Design

### Contract (`packages/shared/src/analysis.ts`)

- Thêm `tradeSetupSchema` và `tradePlanSchema` `{decision, reason, reconsiderWhen, setups[≤2]}`.
- `analysisSubmissionSchema`: thêm `tradePlan` (bắt buộc), `action` thành optional (bỏ qua nếu agent gửi).
- `AnalysisResult`: `tradePlan` có thể thiếu (bản ghi cũ); `action` luôn có (do server suy ra).
- Export `TradeSetup`, `TradePlan`.

### Validator (`apps/server/src/validate`)

Kiểm tra từng setup. Lỗi chiều giá → **bỏ setup** kèm warning (không đổi chiều lệnh):

- LONG: `SL < entryLow ≤ entryHigh < mọi TP`. SHORT: ngược lại. Nếu `entryLow > entryHigh` thì đảo lại.
- So với giá đóng cửa gần nhất `P` của khung chính:
  - `MARKET`: `P` phải nằm trong vùng entry (± 0.25 × ATR14). Nếu không, đổi sang `LIMIT` hoặc `STOP` theo vị trí và ghi warning.
  - `LIMIT` LONG: vùng entry nằm dưới hoặc chứa `P`. `STOP` LONG: vùng entry nằm trên `P`. SHORT thì ngược lại. Nếu sai, tự sửa `entryType` và ghi warning.
  - `P` đã vượt qua SL (setup đã vô hiệu) → bỏ setup.
- `validUntil` ≤ `asOf` → bỏ trường này kèm warning.
- `scenario` không khớp tên kịch bản nào → bỏ trường này.
- R:R tính theo **giữa vùng entry** `(entryLow + entryHigh) / 2`, dùng TP xa nhất, làm tròn 2 chữ số. Tính thêm `riskRewardTp1`.
- Setup ngược bias của khung HTF → chỉ ghi warning (giữ hành vi hiện tại).
- Hạ cấp quyết định:
  - `ENTER` mà không còn setup `MARKET` hợp lệ → `WAIT_FOR_SETUP` (nếu còn setup) hoặc `STAND_ASIDE`.
  - `WAIT_FOR_SETUP` mà 0 setup → `STAND_ASIDE`.
  - `STAND_ASIDE` vẫn giữ setup agent gửi để tham khảo (hiển thị mờ), không coi là khuyến nghị.
  - Mỗi lần hạ cấp đều ghi warning.
- **R:R tối thiểu 2R** (config `SETUP_MIN_RR=2`): setup có R:R (TP xa nhất, giữa vùng entry) < 2 → **bỏ setup** kèm warning; nếu không còn setup thì hạ cấp quyết định như trên.
- Suy ra `action` từ `tradePlan` như mục 1.3.

### Prompt (`prompts/wyckoff.md`)

- Thêm bước 5 "Setup" sau top-down:
  - Setup chính phải **thuận bias khung lớn nhất có xu hướng rõ**.
  - Entry gắn với một sự kiện Wyckoff trên khung xác nhận.
  - SL đặt sau Spring/LPS hoặc UTAD/LPSY, có đệm theo ATR.
  - TP lấy từ Creek/Ice, biên range đối diện, hoặc mục tiêu Cause–Effect.
- Tiêu chí **bắt buộc `STAND_ASIDE`**:
  - Schematic khung chính `UNCLEAR`.
  - Khung HTF mâu thuẫn nhau.
  - Giá nằm giữa range ở Phase B mà không có sự kiện test.
  - Không đặt được SL hợp lý cho R:R ≥ ngưỡng.
  - `confidence` < 0.5.
- Khi đứng ngoài, phải ghi `reconsiderWhen` cụ thể (mức giá hoặc sự kiện cần thấy).
- Nguyên tắc: **thà đứng ngoài còn hơn ép setup**.

### MCP

- `submit_analysis` không đổi (schema tự cập nhật theo zod).
- `get_analysis_request` thêm `lastClose` của khung chính và `minRiskReward` để agent biết ngưỡng.

### UI

- **Panel kết quả:** thay thẻ "Hành động" bằng thẻ **Setup**.
  - Badge quyết định: `VÀO LỆNH` (xanh/đỏ theo chiều), `CHỜ SETUP` (vàng), `ĐỨNG NGOÀI` (xám).
  - Kèm lý do, và `reconsiderWhen` khi đứng ngoài.
  - Mỗi setup một thẻ: chiều, loại lệnh, trigger, vùng entry, SL, TP, R:R, hạn, kịch bản liên quan, lý do.
  - Click thẻ → chỉ vẽ setup đó trên chart (bấm lại để vẽ tất cả).
- **Chart, layer "Setup"** (đổi tên từ "Hành động"):
  - Setup `MARKET`: công cụ Long/Short như hiện tại.
  - Setup chờ: vùng entry tô dải mờ.
    - Công cụ Long/Short vẽ nét đứt, bắt đầu từ `asOf` và kéo dài tới `validUntil` (hoặc 25 nến nếu không có hạn).
    - Nhãn `Chờ LPS · LIMIT`.
  - `STAND_ASIDE`: không vẽ công cụ. Setup tham khảo chỉ vẽ khi bật "Hiện setup tham khảo".
- **Tab Lịch sử:** hiện quyết định thay vì `action.type`.

## 3. Implementation Steps

1. Contract `tradeSetupSchema` / `tradePlanSchema`, cập nhật type. Thêm config `SETUP_MIN_RR`.
2. Pure function `validateTradePlan(plan, ctx)` (tách file `validate/tradePlan.ts`) và `deriveAction(plan)`. Viết test `tests/tradePlan.test.ts`.
3. Nối vào `validateSubmission`, cập nhật `tests/validate.test.ts` và fixture.
4. MCP `get_analysis_request` thêm `lastClose`, `minRiskReward`. Cập nhật prompt.
5. UI:
   - `buildOverlayModel` vẽ setups và chọn setup.
   - Thẻ Setup trong panel; tab Lịch sử.
   - Bản demo `?demo=1` có 2 setup và thêm một biến thể đứng ngoài.
   - Fallback cho bản ghi cũ.
6. Cập nhật `SPEC.md` (mục 3, 4, 7, 9), README.
7. Kiểm chứng: typecheck, lint, test, build:web; chụp ảnh UI bằng `scripts/screenshot.ts` (demo và một bản ghi cũ); **1 lần chạy thật** qua nút Analyze.

## 4. Tests / Acceptance Criteria

1. Unit test validator:
   - LONG/SHORT đúng chiều → giữ setup, R:R tính theo giữa vùng entry.
   - R:R < 2 → bỏ setup, có warning; quyết định hạ cấp nếu hết setup.
   - Sai chiều → bỏ setup và có warning.
   - Sửa `entryType` khi MARKET/LIMIT/STOP không khớp vị trí giá.
   - Bỏ setup đã vượt SL.
   - Hạ cấp `ENTER` → `WAIT_FOR_SETUP` → `STAND_ASIDE`.
   - `STAND_ASIDE` thiếu `reconsiderWhen` → lỗi trả về agent.
   - `deriveAction` đúng cho cả 3 quyết định.
2. Bản ghi cũ (không có `tradePlan`) vẫn mở được và hiển thị đúng.
3. Overlay model: setup chờ vẽ nét đứt kèm dải entry; `STAND_ASIDE` không vẽ gì khi tắt "tham khảo"; chọn 1 setup chỉ vẽ setup đó.
4. Chạy thật một lần: agent nộp `tradePlan` hợp lệ (bất kể là quyết định nào), UI hiển thị đúng, console không có lỗi.
5. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:web` đều đạt.

## 5. Ngoài phạm vi (làm sau)

- Theo dõi trạng thái setup theo thời gian thực (đã kích hoạt / chạm TP / chạm SL / hết hạn) và chấm điểm dự đoán.
- Gửi setup qua Telegram, đặt lệnh tự động.

## 6. Quyết định của người dùng (2026-11-09)

1. R:R tối thiểu **2R** — dưới ngưỡng thì bỏ setup.
2. Tối đa **2 setup** (chính + phương án B).
3. R:R tính theo **giữa vùng entry**.

## 7. Tiến độ (2026-11-09)

- [x] 1. Contract + config `SETUP_MIN_RR`
- [x] 2. `validate/tradePlan.ts` (`validateTradePlan`, `deriveAction`) + `tests/tradePlan.test.ts`
- [x] 3. Nối vào `validateSubmission`, cập nhật test validate / analysisService
- [x] 4. MCP `get_analysis_request` thêm `lastClose`, `minRiskReward`; prompt mục "Setup giao dịch"
- [x] 5. UI: thẻ Setup, chọn setup, setup tham khảo, lịch sử, demo `?demo=1|enter|aside`, fallback bản ghi cũ
- [x] 6. SPEC.md, README
- [x] 7. Kiểm chứng: typecheck, lint, test, build:web; ảnh 3 biến thể demo; 1 lần chạy thật (1D → 4H → 5m, 57s, WAIT_FOR_SETUP, Short LPSY, R:R 5.69, 0 warning)

Ghi chú triển khai (ngoài plan, đã áp dụng):
- Bỏ setup khi giá hiện tại đã vượt TP xa nhất (setup đã chạy xong).
- Setup `STOP` chưa kích hoạt: giá nằm ngoài SL không coi là vô hiệu.
