# Nâng ORDERFLOW_RETAIN_H lên 72H & Chức năng Alert giá trên Chart

## Bối cảnh & Yêu cầu từ Người dùng

1. **Nâng thời gian lưu trữ Order Flow**:
   - Tăng giới hạn lưu trữ dữ liệu sổ lệnh và lệnh khớp lớn (`ORDERFLOW_RETAIN_H`) từ **24 giờ lên 72 giờ** (3 ngày) tương đương với thời gian lưu trữ lệnh thanh lý (`LIQ_RETAIN_H`).
2. **Chức năng Alert giá thủ công trên Biểu đồ (Chart Price Alert)**:
   - **Thao tác tạo**: Chuột phải trên biểu đồ ở bất kỳ mức giá nào -> Chọn "Đặt alert giá `<price>`".
   - **Thiết lập alert**:
     - Cho phép chỉnh sửa mức giá.
     - Lựa chọn tần suất kích hoạt:
       - **Only once (Chỉ 1 lần)**: Khi giá chạm/cắt qua mức alert thì kích hoạt thông báo 1 lần, sau đó hoàn tất và gỡ bỏ đường nét đứt khỏi biểu đồ (cập nhật trạng thái `TRIGGERED`).
       - **Every time (Mỗi lần)**: Mỗi khi giá chạm/cắt qua mức alert đều kích hoạt thông báo, đường nét đứt vẫn được giữ nguyên trên biểu đồ để tiếp tục theo dõi (kèm cơ chế cooldown 60 giây chống spam liên tục).
     - Tùy chỉnh đường vạch nét đứt:
       - **Màu sắc**: Cho phép chọn bảng màu (Cam vàng, Xanh dương, Xanh lá, Đỏ, Tím, Trắng...).
       - **Độ đậm nhạt (Opacity / Độ trong suốt)**: Tùy chỉnh độ đậm nhạt của màu sắc (ví dụ: 100% - Đậm nhất, 75%, 50% - Vừa, 30% - Mờ nhạt). Màu của đường nét đứt và nhãn trục giá sẽ áp dụng độ trong suốt tương ứng (dùng `rgba(r, g, b, opacity)` hoặc hex alpha).
   - **Hiển thị trên biểu đồ**:
     - Vẽ đường vạch nét đứt ngang biểu đồ tại mức giá alert với màu sắc và độ đậm nhạt (opacity) đã cấu hình.
     - **Không hiển thị label text trên biểu đồ** (bỏ nhãn "Mỗi lần / 1 lần" và giá trên chart để biểu đồ thoáng, sạch sẽ, không che nến).
     - **Ở vạch giá (trục giá bên phải)**: Hiển thị ký hiệu badge `>` với màu alert tương ứng (giống TradingView) để dễ dàng nhận biết đó là mức giá có đặt alert.
     - **Quy tắc hiển thị nghiêm ngặt**: **Chỉ các alert thủ công trên biểu đồ này mới hiển thị đường nét đứt trên chart**. Các alert tự động theo setup giao dịch của Wyckoff AI Agent (`price_alerts`) tuyệt đối **không** hiển thị đường nét đứt này (giữ nguyên cách hiển thị thẻ setup trong bảng phân tích và vùng entry/SL/TP).
   - **Xóa alert trên biểu đồ**:
     - Cho phép xóa trực tiếp trên chart: Chuột phải vào chart hiển thị mục xóa alert tại giá đó (nếu chuột phải gần đường alert) hoặc mở danh sách alert đang có của mã để xóa nhanh bằng 1 click.
     - Danh sách nhỏ góc chart liệt kê các alert đang canh kèm nút `✕` để xóa tiện lợi.
   - **Cơ chế kích hoạt & Thông báo**:
     - Web UI: Phát âm thanh chuông cảnh báo (Web Audio API synth âm thanh chuông nhẹ) + Hiển thị Toast thông báo trên màn hình: `🔔 Alert [SYMBOL]: Giá đã chạm [price]!`.
     - Telegram (nếu bật bot Telegram): Server tự động gửi tin nhắn Telegram thông báo: `🔔 [SYMBOL] Alert giá chạm mức [price] (Loại: [Chỉ 1 lần | Mỗi lần])`.
   - **Lưu trữ dữ liệu (Persistence)**:
     - Lưu trữ vào cơ sở dữ liệu SQLite phía backend (`chart_alerts`), đồng bộ qua API REST để khi F5 trình duyệt, chuyển đổi mã hoặc mở trên nhiều tab, các đường alert nét đứt vẫn hiển thị đầy đủ và server vẫn tiếp tục canh giá khi đóng trình duyệt.

---

## Technical Design

### 1. Nâng giới hạn Order Flow
- Trong `apps/server/src/config.ts`:
  - Đổi giá trị mặc định: `orderflowRetainH: int('ORDERFLOW_RETAIN_H', 72)`.
- Cập nhật tài liệu `SPEC.md` phản ánh mốc 72 giờ (thay cho 24).

### 2. Contract & Schema dữ liệu (`packages/shared`)
- File `packages/shared/src/alerts.ts`:
  - Thêm kiểu `ChartAlertType = 'once' | 'every'`.
  - Thêm kiểu `ChartAlertStatus = 'ACTIVE' | 'TRIGGERED' | 'DISABLED'`.
  - Thêm interface:
    ```ts
    export interface ChartAlert {
      id: string;
      symbol: string;
      price: number;
      type: ChartAlertType;
      color: string;
      opacity: number; // 0.1 - 1.0 (độ đậm nhạt của màu nét đứt)
      status: ChartAlertStatus;
      createdAt: number;
      triggeredAt?: number | null;
      note?: string | null;
    }
    ```
- File `packages/shared/src/events.ts`:
  - Bổ sung sự kiện SSE cho chart alert:
    ```ts
    | { kind: 'chart_alert'; alert: ChartAlert; triggerPrice: number }
    ```

### 3. Backend Cơ sở dữ liệu & API (`apps/server`)
- **Database SQLite** (`apps/server/src/db/index.ts`):
  - Bổ sung bảng:
    ```sql
    CREATE TABLE IF NOT EXISTS chart_alerts (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      price REAL NOT NULL,
      type TEXT NOT NULL,
      color TEXT NOT NULL,
      opacity REAL NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      triggered_at INTEGER,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chart_alerts_status_symbol ON chart_alerts(status, symbol);
    ```
- **Repository** (`apps/server/src/alerts/chartAlertRepo.ts`):
  - `listActive(symbol?: string): ChartAlert[]`
  - `getById(id: string): ChartAlert | null`
  - `create(data: Omit<ChartAlert, 'id' | 'status' | 'createdAt'>): ChartAlert`
  - `delete(id: string): boolean`
  - `markTriggered(id: string, triggeredAt: number, isOnce: boolean): ChartAlert | null`
- **Watcher & Realtime Tracking** (`apps/server/src/alerts/chartAlertWatcher.ts`):
  - Lắng nghe giá realtime từ `PriceFeed` (cho symbol có order flow) và kiểm tra nến 1m/ticker định kỳ.
  - Khi giá chạm mức `price` (hoặc nến 1m có `low <= price && high >= price`):
    - Đổi trạng thái hoặc cập nhật `triggered_at` (cooldown 60s cho loại `every`).
    - Bắn sự kiện SSE `chart_alert` về các client web đang mở.
    - Nếu có cấu hình Telegram Bot, gửi thông báo Telegram về `TELEGRAM_CHAT_ID`.
- **API REST** (`apps/server/src/routes/chartAlerts.ts`):
  - `GET /api/chart-alerts?symbol=<symbol>`: Lấy danh sách alert đang active của symbol.
  - `POST /api/chart-alerts`: Tạo alert mới (body: `{ symbol, price, type, color, opacity }`).
  - `DELETE /api/chart-alerts/:id`: Xóa alert.

### 4. Frontend Web (`apps/web`)
- **Quản lý đường nét đứt trên Chart** (`apps/web/src/chart/ChartController.ts`):
  - Thêm phương thức quản lý price lines riêng biệt cho manual alerts:
    - `setChartAlerts(alerts: ChartAlert[])`: So khớp danh sách alert hiện tại, quy đổi `color` + `opacity` thành màu RGBA (vd `rgba(245, 158, 11, 0.7)`), gọi `candleSeries.createPriceLine({ price, color: rgbaColor, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '🔔' })` và lưu tham chiếu `IPriceLine` vào Map `Map<string, IPriceLine>`.
    - Khi alert bị xóa hoặc `once` trigger: tự động gọi `candleSeries.removePriceLine(line)`.
  - Đảm bảo tách biệt 100%: Logic vẽ setup trade của Wyckoff (`AnalysisPanel`, overlays) không đụng chạm đến hàm này, đảm bảo **không bao giờ** vẽ nét đứt cho setup alerts.
- **Store Zustand** (`apps/web/src/store/useChartAlertsStore.ts`):
  - Quản lý state `alerts: ChartAlert[]` cho symbol đang hiển thị.
  - Tự động fetch danh sách khi đổi symbol.
  - Action `createAlert(...)`, `deleteAlert(id)`, `onTrigger(alertId)`.
  - Nhận sự kiện SSE `chart_alert` từ server.
- **Âm thanh & Toast**:
  - `apps/web/src/chart/sound.ts`: Tạo âm thanh chuông báo bằng Web Audio API thuần (2 dao động sóng hình sin tần số hài hoà 587Hz -> 880Hz mô phỏng tiếng chuông trong trẻo, không phụ thuộc file mp3 ngoài).
  - Tích hợp Toast hiển thị trên màn hình khi alert kích hoạt.
- **Giao diện người dùng**:
  - `apps/web/src/components/ChartContextMenu.tsx`:
    - Thêm mục: `🔔 Đặt alert giá <price>`.
    - Nếu chuột phải ở gần một alert hiện có (hoặc có alert trên chart): hiện thêm mục `🗑️ Xóa alert giá <price>` hoặc mở danh sách alert.
  - `apps/web/src/components/ChartAlertDialog.tsx`:
    - Modal/Popover xuất hiện khi chọn "Đặt alert giá":
      - Ô nhập mức giá (pre-fill giá tại con trỏ).
      - Radio chọn: `Chỉ 1 lần (Only once)` vs `Mỗi lần (Every time)`.
      - Palette màu: Vàng cam `#f59e0b`, Xanh dương `#3b82f6`, Xanh lá `#10b981`, Đỏ `#ef4444`, Tím `#a855f7`, Trắng `#f8fafc`.
      - Độ đậm nhạt (Opacity): Dùng thanh trượt (slider) điều chỉnh từ 20% đến 100% kèm hiển thị % realtime.
      - Xem trước (preview) màu đường nét đứt trực tiếp trên dialog.
      - Nút "Tạo alert" và "Hủy".
  - `apps/web/src/components/ChartAlertsBadge.tsx`:
    - Một nút huy hiệu nhỏ gọn `🔔 <số alert>` ở góc biểu đồ. Click vào mở danh sách các alert đang theo dõi của symbol hiện tại kèm nút ✕ để xóa nhanh bất kỳ alert nào.

---

## Implementation Steps

1. **Cấu hình & Contract**:
   - Cập nhật `apps/server/src/config.ts`: nâng `orderflowRetainH` lên 72.
   - Thêm types `ChartAlert`, `ChartAlertType`, `ChartAlertStatus` vào `packages/shared/src/alerts.ts`.
   - Bổ sung event `chart_alert` vào `packages/shared/src/events.ts`.
2. **Backend**:
   - Thêm migration bảng `chart_alerts` vào `apps/server/src/db/index.ts`.
   - Viết `apps/server/src/alerts/chartAlertRepo.ts` và unit test `tests/chartAlert.test.ts`.
   - Viết `apps/server/src/alerts/chartAlertWatcher.ts` xử lý kiểm tra giá và gửi thông báo Telegram / SSE.
   - Viết route `apps/server/src/routes/chartAlerts.ts` và đăng ký vào `apps/server/src/app.ts`.
3. **Frontend**:
   - Viết helper phát chuông Web Audio `apps/web/src/chart/sound.ts`.
   - Mở rộng `apps/web/src/chart/ChartController.ts` hỗ trợ vẽ và xóa các đường `IPriceLine` nét đứt theo danh sách `ChartAlert`.
   - Tạo store `apps/web/src/store/useChartAlertsStore.ts`.
   - Tạo component `ChartAlertDialog.tsx` (thanh trượt slider cho opacity) và `ChartAlertsBadge.tsx`.
   - Cập nhật `ChartContextMenu.tsx` để có tùy chọn "Đặt alert giá" và xóa alert.
   - Gắn badge danh sách alert và dialog vào `ChartView.tsx`.
4. **Đồng bộ Đặc tả & Tài liệu**:
   - Cập nhật `SPEC.md` với thông số `ORDERFLOW_RETAIN_H=72` và mục "Alert giá thủ công trên biểu đồ".
5. **Kiểm chứng**:
   - `npm run typecheck`, `npm run lint`, `npm test`.
   - Chạy kiểm thử Playwright tạo alert, kiểm tra đường nét đứt trên chart, chụp ảnh màn hình bằng `scripts/screenshot.ts`.

---

## Tests / Acceptance

- **Unit tests**:
  - Kiểm tra `orderflowRetainH` có giá trị mặc định là 72.
  - CRUD `chartAlertRepo`: tạo alert, lấy theo symbol, xóa alert, cập nhật trạng thái khi trigger.
  - `chartAlertWatcher`: nến/tick chạm mức alert -> kích hoạt đúng; loại `once` chuyển sang TRIGGERED và chỉ báo 1 lần; loại `every` có cooldown và giữ nguyên ACTIVE.
- **Thử nghiệm giao diện & Tích hợp**:
  - Chuột phải tại mức giá bất kỳ -> Menu hiện "Đặt alert giá ...".
  - Mở dialog, chọn màu sắc (ví dụ xanh lá), kéo thanh trượt opacity ví dụ 50%, chọn "Chỉ 1 lần" hoặc "Mỗi lần" -> Biểu đồ vẽ đường nét đứt đúng màu và độ trong suốt (opacity), có nhãn chuông trên trục giá.
  - Kiểm tra các setup của AI Agent: không xuất hiện đường nét đứt trên chart.
  - Nhấp nút xóa trên badge hoặc menu -> Đường nét đứt biến mất ngay lập tức trên chart và trong database.
  - Khi giá chạm mức alert: phát âm thanh chuông + Toast thông báo trên Web + gửi Telegram (nếu bật bot).
  - Tải lại trang (F5): các đường alert nét đứt vẫn được hiển thị chính xác.

---

## Approval Status

Đã duyệt (2026-11-18, "dùng thanh trượt là được. xong apply"). Nhánh `feat/chart-price-alerts`.
