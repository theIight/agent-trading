# Tự động Alert Take Profit, Stop Loss & Lưu Lịch sử Đánh giá Hiệu quả Setup (kèm tinh chỉnh dấu `>` bé xíu)

## Bối cảnh & Yêu cầu từ Người dùng

1. **Tinh chỉnh dấu `>` trên trục giá**:
   - Thu nhỏ kích thước dấu `>` ở vạch giá trên trục giá bên phải bé xíu nhất có thể (thay ký tự to tiêu chuẩn bằng ký hiệu chevron mini `›` thanh mảnh hoặc render mũi tên mini 4px), giúp trục giá gọn gàng, tinh tế và giống TradingView.
2. **Tự động Alert Take Profit & Stop Loss cho Trade Setup**:
   - Hiện tại hệ thống chỉ canh và báo khi giá chạm vùng Entry (trạng thái `TRIGGERED`), sau đó dừng lại.
   - Khi giá đã khớp Entry, người dùng cần hệ thống **tiếp tục tự động theo dõi lệnh**:
     - **Chạm Take Profit (TP1, TP2, TP3...)**: Kích hoạt alert thông báo (Telegram + Web UI): `🎯 [SYMBOL] Chạm TP1 (giá X, +Y.Y R · +Z.Z%)`!
     - **Chạm Stop Loss (SL)**: Kích hoạt alert thông báo (Telegram + Web UI): `🛑 [SYMBOL] Chạm Stop Loss (giá X, -1.0 R)`!
3. **Lưu lịch sử và Đánh giá độ hiệu quả của Setup**:
   - Ghi lại toàn bộ hành trình khớp lệnh và kết quả của từng setup:
     - Giá khớp entry thực tế, thời điểm khớp.
     - Các mốc TP đã chạm (thời gian, giá, R:R tại mỗi mốc).
     - Kết quả cuối cùng: `TP_FULL` (chạm đủ TP), `TP_PARTIAL` (chạm 1 phần TP rồi quay đầu), `SL_HIT` (chạm SL), `INVALIDATED` (chạm SL trước entry).
     - R:R thực tế đạt được (Realized R:R) và % PnL.
   - Cung cấp API và hiển thị thống kê hiệu quả setup:
     - Win rate (tỷ lệ thắng %), Tổng số R tích lũy, R:R trung bình, số lệnh Thắng / Thua.
     - Nhật ký lịch sử các trade setup đã hoàn thành.

---

## Requirements / Spec

### 1. Vòng đời Setup Trade (Setup Lifecycle)
- **`ARMED`**: Đang canh chờ giá chạm vùng Entry `[entryLow, entryHigh]`.
  - Nếu giá chạm SL trước khi chạm entry -> `INVALIDATED` (hủy setup trước khi vào lệnh, giữ nguyên luật hiện tại).
  - Nếu hết hạn -> `EXPIRED`.
  - Nếu có phân tích mới cùng symbol -> `REPLACED`.
- **`TRIGGERED` (Vào lệnh / Khớp Entry)**:
  - Giá chạm vùng entry -> Thông báo `🔔 Chạm entry` (đã có).
  - **Thay đổi mới**: Thay vì kết thúc, alert chuyển sang giai đoạn **Quản lý lệnh đang chạy (`IN_TRADE`)**.
- **`IN_TRADE` (Theo dõi TP / SL)**:
  - **Với lệnh LONG**:
    - Mỗi khi `high >= takeProfits[i]` (với TP chưa chạm):
      - Ghi nhận chạm `TP[i]`.
      - Báo Telegram & Web Toast: `🎯 <SYMBOL> chạm TP<i+1> <giá> (+<R>R)`.
      - Nếu đã chạm mốc TP cuối cùng -> Lệnh hoàn thành `TP_FULL`.
    - Nếu `low <= stopLoss`:
      - Báo Telegram & Web Toast: `🛑 <SYMBOL> chạm Stop Loss <giá> (-1.0R)`.
      - Lệnh kết thúc: nếu trước đó đã chạm TP1/TP2 -> `TP_PARTIAL`, nếu chưa chạm TP nào -> `SL_HIT`.
  - **Với lệnh SHORT**:
    - Mỗi khi `low <= takeProfits[i]` (với TP chưa chạm):
      - Ghi nhận chạm `TP[i]`.
      - Báo Telegram & Web Toast: `🎯 <SYMBOL> chạm TP<i+1> <giá> (+<R>R)`.
      - Nếu đã chạm mốc TP cuối cùng -> Lệnh hoàn thành `TP_FULL`.
    - Nếu `high >= stopLoss`:
      - Báo Telegram & Web Toast: `🛑 <SYMBOL> chạm Stop Loss <giá> (-1.0R)`.
      - Lệnh kết thúc: `TP_PARTIAL` (nếu đã có TP) hoặc `SL_HIT`.

### 2. Ghi nhận Lịch sử & Thống kê Hiệu quả Setup
- Bảng cơ sở dữ liệu `setup_history`:
  - `id`: INTEGER PK
  - `alert_id`: ID bảng `price_alerts`
  - `analysis_id`: ID phân tích gốc
  - `symbol`: Tên mã (BTCUSDT, ETHUSDT...)
  - `direction`: LONG | SHORT
  - `entry_type`: LIMIT | STOP | MARKET
  - `tf`: Khung thời gian setup (1m, 5m, 15m, 1h...)
  - `entry_price`: Giá khớp entry
  - `stop_loss`: Giá cắt lỗ
  - `take_profits`: Mảng JSON các mức TP
  - `hit_tps`: Mảng JSON các mốc TP đã chạm `[{ index, price, time, rr }]`
  - `exit_price`: Giá thoát lệnh
  - `exit_at`: Thời gian thoát lệnh (unix giây)
  - `status`: `IN_TRADE` | `TP_FULL` | `TP_PARTIAL` | `SL_HIT`
  - `realized_rr`: R:R thực tế đạt được
  - `pnl_pct`: % thay đổi giá từ entry đến exit
- API Thống kê:
  - `GET /api/setups/history`: Danh sách lịch sử lệnh kèm bộ lọc theo symbol, status.
  - `GET /api/setups/performance`: Thống kê tổng hợp (tổng setup, win rate, tổng R, avg R:R).

### 3. Tinh chỉnh Dấu `>` trên Trục giá
- Trong `ChartAlertsPrimitive.ts`, thay ký tự `>` tiêu chuẩn bằng ký hiệu `›` (Single Right-Pointing Angle Quotation Mark, mã Unicode `\u203A`) hoặc mũi tên mini 4px.
- Kích cỡ hiển thị nhỏ gọn, sắc nét, không chiếm không gian nhãn trục giá.

---

## Technical Design

### 1. Contract & Schema (`packages/shared`)
- File `packages/shared/src/alerts.ts`:
  - Mở rộng `PriceAlertStatus`: thêm `IN_TRADE`, `TP_FULL`, `TP_PARTIAL`, `SL_HIT`.
  - Định nghĩa kiểu `SetupHistoryRecord`:
    ```ts
    export interface SetupHitTp {
      index: number;
      price: number;
      time: number;
      riskReward: number;
    }

    export interface SetupHistoryRecord {
      id: number;
      alertId: number;
      analysisId: string;
      symbol: string;
      setupIndex: number;
      direction: 'LONG' | 'SHORT';
      entryType: 'MARKET' | 'LIMIT' | 'STOP';
      tf: string;
      entryPrice: number;
      entryAt: number;
      stopLoss: number;
      takeProfits: number[];
      hitTps: SetupHitTp[];
      exitPrice?: number;
      exitAt?: number;
      status: 'IN_TRADE' | 'TP_FULL' | 'TP_PARTIAL' | 'SL_HIT';
      realizedRr?: number;
      pnlPct?: number;
      note?: string;
    }
    ```
- File `packages/shared/src/events.ts`:
  - Thêm sự kiện SSE:
    ```ts
    | { kind: 'setup_tp'; alert: PriceAlert; tpIndex: number; price: number; rr: number }
    | { kind: 'setup_sl'; alert: PriceAlert; price: number; rr: number }
    ```

### 2. Backend Server (`apps/server`)
- **Database SQLite** (`apps/server/src/db/index.ts`):
  - Tạo bảng `setup_history` và index theo `(symbol, status)`.
  - Bổ sung cột vào `price_alerts`: `entry_price REAL`, `entry_at INTEGER`, `hit_tps TEXT` (JSON).
- **Pure Logic** (`apps/server/src/alerts/alertLogic.ts`):
  - Hàm `evaluateTradePosition(alert, candles)`:
    - Kiểm tra giá chạm các mức TP chưa khớp.
    - Kiểm tra giá chạm SL.
    - Tính toán Realized R:R dựa trên khoảng cách `|entry - SL|` và các TP đã chạm.
- **Repository** (`apps/server/src/alerts/setupHistoryRepo.ts` & `alertRepo.ts`):
  - Lưu và cập nhật tiến trình lệnh: tạo mới khi khớp entry, cập nhật khi chạm TP, chốt khi chạm SL hoặc full TP.
- **Watcher** (`apps/server/src/alerts/alertWatcher.ts`):
  - Lắng nghe nến 1m và đường nhanh realtime:
    - Nếu alert đang `ARMED`: kiểm tra chạm entry (như cũ). Khi chạm entry -> khởi tạo theo dõi vị thế `IN_TRADE` và lưu `setup_history`.
    - Nếu alert đang `IN_TRADE`: kiểm tra chạm TP / SL. Khi chạm TP -> gửi thông báo Telegram + SSE. Khi chạm SL hoặc hết TP -> cập nhật kết quả cuối cùng.
- **API Routes** (`apps/server/src/routes/setups.ts`):
  - `GET /api/setups/history`: Lấy danh sách lịch sử lệnh.
  - `GET /api/setups/performance`: Trả về dữ liệu thống kê tổng hợp hiệu quả.

### 3. Frontend Web (`apps/web`)
- **Thu nhỏ dấu `>`**:
  - Cập nhật `apps/web/src/chart/ChartAlertsPrimitive.ts`: dùng ký tự chevron mini `›` và font chữ mini.
- **Hiển thị Trạng thái Setup & Hiệu quả**:
  - Cập nhật `AnalysisPanel.tsx`: Thẻ setup hiển thị trạng thái động:
    - Đang canh entry 🔔
    - Đang chạy lệnh 🟢 (đã vào ở giá X)
    - Đã chạm TP1 / TP2 🎯 (+X.X R)
    - Đã dính SL 🛑
  - Bổ sung modal hoặc panel con "Hiệu quả Setup": Hiển thị Win rate %, Tổng R đạt được, danh sách lệnh đã đóng.

---

## Implementation Steps

1. **Contract**:
   - Mở rộng types trong `packages/shared/src/alerts.ts` và `events.ts`.
2. **Thu nhỏ dấu `>`**:
   - Cập nhật `ChartAlertsPrimitive.ts` với ký tự `›` bé xíu.
3. **Database & Backend Repository**:
   - Migration bảng `setup_history` và cột mở rộng trong `apps/server/src/db/index.ts`.
   - Viết `setupHistoryRepo.ts` quản lý CRUD và tính toán thống kê hiệu quả.
4. **Pure Logic & Unit Tests**:
   - Viết logic đánh giá TP/SL và tính R:R trong `alertLogic.ts`.
   - Viết unit tests kiểm tra chạm TP1, chạm TP2, chạm SL, tính R:R trong `tests/setupHistory.test.ts`.
5. **Watcher Tích hợp**:
   - Mở rộng `alertWatcher.ts` để theo dõi cả alert `ARMED` lẫn `IN_TRADE`.
   - Gửi thông báo Telegram khi chạm TP / SL.
6. **API Routes & Web UI**:
   - Viết routes `/api/setups/history` và `/api/setups/performance`.
   - Cập nhật giao diện `AnalysisPanel.tsx` hiển thị trạng thái TP/SL và bảng thống kê hiệu quả.
7. **Đồng bộ Đặc tả & Kiểm chứng**:
   - Cập nhật `SPEC.md`.
   - Chạy `npm run typecheck`, `npm run lint`, `npm test`.
   - Chụp ảnh màn hình kiểm chứng giao diện dấu `›` mini và trạng thái setup.

---

## Tests / Acceptance

- **Dấu `>` mini**: Dấu hiển thị trên trục giá có kích thước bé xíu, thanh mảnh `›`, không chiếm chỗ.
- **Unit tests**:
  - Setup sau khi chạm entry chuyển sang `IN_TRADE`.
  - Giá tăng chạm TP1 (LONG) -> ghi nhận `hit_tps` chứa TP1, tính đúng R:R.
  - Giá tăng chạm tiếp TP2 -> cập nhật `hit_tps`.
  - Giá giảm chạm SL -> kết thúc lệnh, ghi nhận `realized_rr` và thời điểm thoát.
  - Setup chạm SL trước entry -> giữ nguyên `INVALIDATED`, không tính vào lệnh đã chạy.
  - Thống kê tính đúng Win rate, Tổng R.
- **Thực tế**:
  - Alert gửi tin nhắn Telegram rõ ràng khi chạm TP và khi chạm SL.
  - Lịch sử được lưu bền vững vào SQLite `setup_history`.

---

## Approval Status

- Đã duyệt (2026-11-18, "ok"). Nhánh `feat/setup-tp-sl-tracking`.
- Đã hoàn thành triển khai và kiểm chứng:
  - `npm run typecheck`: OK (0 errors)
  - `npm run lint`: OK (0 warnings/errors)
  - `npm test`: 38 test files, 371/371 unit tests passed
  - Đã cập nhật SPEC.md và khởi động lại PM2 thành công
  - Giao diện trực quan đã kiểm chứng qua screenshot Playwright.
