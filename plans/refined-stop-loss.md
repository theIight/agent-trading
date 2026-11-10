# Plan — SL hai tầng: entry tinh chỉnh trên khung nhỏ (mục A)

## Approval Status

- [x] Đã duyệt (2026-11-09)

## 1. Requirements / Spec

Hiện SL của setup đặt theo cấu trúc khung lớn (vd trên AR 4H), nên khoảng cách SL thường khoảng 400–800 giá với BTC dù vào lệnh trên khung nhỏ. Người dùng muốn SL khoảng 100–200 để tối ưu R:R.

Giải pháp (chỉ mục A; không làm B "nút tinh chỉnh entry" và C "giới hạn SL trong validator"):

- Mỗi setup **giữ nguyên** vùng entry và `stopLoss` cấu trúc (SL tầng 1).
- Thêm `refinedEntry` tuỳ chọn (SL tầng 2): khi giá vào vùng entry, chờ tín hiệu kích hoạt trên khung nhỏ (1m/5m), đặt SL ngay sau đỉnh/đáy của tín hiệu đó, cộng đệm theo ATR của khung ấy.
- Tín hiệu chưa hình thành nên SL tầng 2 là **ước lượng** khoảng cách (`estStopDistance`), không phải giá cố định. Panel và chart ghi rõ "≈".
- Hiển thị cả hai R:R để người dùng tự chọn: R:R cấu trúc và R:R tinh chỉnh (ước lượng).
- **R:R tối thiểu 2R vẫn xét theo SL cấu trúc** (không đổi hành vi hiện tại). R:R tinh chỉnh chỉ để tham khảo. Muốn xét 2R theo SL tinh chỉnh thì báo lại.

### Trường mới `setup.refinedEntry?`

| Trường | Ý nghĩa |
|---|---|
| `tf` | Khung tinh chỉnh, ≤ khung chính (thường 1m hoặc 5m) |
| `trigger` | Tín hiệu trên khung nhỏ: `SETUP_TRIGGERS` + `CHOCH` |
| `condition` | Điều kiện cụ thể, vd "UT 1m quét trên 75.2k rồi CHoCH xuống, volume giảm dần" |
| `stopRule` | Cách đặt SL, vd "Trên đỉnh UT 1m + 0.3 ATR(1m)" |
| `estStopDistance` | Khoảng cách entry → SL tinh chỉnh ước lượng (đơn vị giá) |
| `atr` | Server điền: ATR14 của `tf` tại `asOf` |
| `riskReward`, `riskRewardTp1` | Server tính: \|TP − giữa vùng entry\| / `estStopDistance` |

## 2. Technical Design

- **Contract** (`packages/shared/src/analysis.ts`):
  - Thêm `refinedEntrySchema` và `REFINED_TRIGGERS = [...SETUP_TRIGGERS, 'CHOCH']`.
  - `tradeSetupSchema.refinedEntry` là optional.
- **Validator** (`validate/tradePlan.ts`). Context thêm `atrByTf` (ATR14 theo khung, tính từ nến đã nạp). Kiểm tra `refinedEntry` sau khi setup đã hợp lệ:
  - `tf` lớn hơn khung chính, hoặc không có dữ liệu → bỏ `refinedEntry` + warning.
  - `estStopDistance` < 0.5 × ATR(tf) → nâng lên 0.5 × ATR + warning ("quá chặt, nằm trong nhiễu").
  - `estStopDistance` ≥ khoảng cách SL cấu trúc (từ giữa vùng entry) → bỏ `refinedEntry` + warning (không chặt hơn thì vô nghĩa).
  - Tính `atr`, `riskReward`, `riskRewardTp1` (làm tròn 2 số; `atr` làm tròn theo độ lớn giá). Không dùng cho ngưỡng R:R tối thiểu.
- **`referencedTfs`**: thêm `setup.tf` và `refinedEntry.tf` để server nạp nến các khung này khi validate.
- **Prompt**: thêm phần "Entry tinh chỉnh":
  - Gọi `get_features` khung 1m/5m để lấy ATR (được phép dùng khung ngoài danh sách top-down, chỉ cho mục đích này).
  - `estStopDistance` = biên độ điển hình của nến kích hoạt + đệm 0.3–0.5 ATR.
  - Chỉ thêm `refinedEntry` khi cấu trúc khung nhỏ đủ rõ để có tín hiệu.
  - Không thay thế SL cấu trúc.
- **MCP**: mô tả `submit_analysis` nhắc `refinedEntry`.
- **UI**:
  - Thẻ setup thêm khối "Entry tinh chỉnh (1m)": điều kiện, cách đặt SL, "SL ≈ 150 (1.8 ATR 1m) → R:R ≈ 9.5 (TP1 3.2)".
  - Chart: trong công cụ Long/Short, vẽ thêm đường chấm đỏ mảnh tại giữa vùng entry ± `estStopDistance`, nhãn "SL 1m ≈".
  - Demo `?demo=1` có `refinedEntry`.

## 3. Implementation Steps

1. Contract `refinedEntrySchema`.
2. Validator `refinedEntry` + `atrByTf`, `referencedTfs`; test trong `tests/tradePlan.test.ts` và `tests/validate.test.ts`.
3. Prompt + mô tả MCP.
4. UI: thẻ setup, overlay model (đường SL tinh chỉnh), demo; test `tests/overlayModel.test.ts`.
5. SPEC.md (3.1, 4, 9), README.
6. Kiểm chứng: typecheck, lint, test, build:web; chụp ảnh `?demo=1`; 1 lần chạy thật.

## 4. Tests / Acceptance Criteria

1. Unit test:
   - `refinedEntry` hợp lệ → có `atr` và R:R tinh chỉnh đúng công thức.
   - `estStopDistance` quá chặt → nâng lên 0.5 ATR.
   - `estStopDistance` ≥ SL cấu trúc → bỏ.
   - `tf` lớn hơn khung chính → bỏ.
   - Ngưỡng 2R vẫn xét theo SL cấu trúc.
2. Overlay: có đường "SL … ≈" khi setup có `refinedEntry`; không có `refinedEntry` → giống hiện tại.
3. Chạy thật: agent nộp được `refinedEntry` (ví dụ SL ≈ 100–250 với BTC trên 1m/5m), UI hiển thị đúng.
4. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:web` đạt.

## 5. Ngoài phạm vi

- B: nút "Tinh chỉnh entry" chạy agent khi giá đã vào vùng để có SL chính xác.
- C: giới hạn độ rộng vùng entry / khoảng cách SL trong validator.

## 6. Tiến độ (2026-11-09)

- [x] 1. Contract `refinedEntrySchema`, `REFINED_TRIGGERS`
- [x] 2. Validator + `atrByTf`, `referencedTfs`; test tradePlan / validate
- [x] 3. Prompt + mô tả MCP
- [x] 4. UI: khối "Entry tinh chỉnh" trong thẻ setup, đường "SL 1m ≈" trên chart, demo; test overlay
- [x] 5. SPEC.md
- [x] 6. Kiểm chứng: typecheck, lint, test (70), build:web; ảnh `?demo=1`; chạy thật 1D → 4H → 5m (63s): Short LPSY, SL cấu trúc cách 900 (R:R 5.06), SL tinh chỉnh 5m ≈ 350 (1.65 ATR 5m, R:R ≈ 13), 0 warning.

Ghi chú: agent chọn khung tinh chỉnh 5m nên SL ≈ 350; muốn ~100–200 với BTC cần tín hiệu trên 1m (ATR 1m ≈ 85 lúc đo).
