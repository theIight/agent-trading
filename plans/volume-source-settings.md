# Chọn nguồn volume theo sàn + nút cài đặt hiển thị chart

## Bối cảnh
- Volume gộp hiện chỉ có hai chế độ: tắt (Binance Futures), hoặc bật (perp 3 sàn + spot chồng lên, dấu S/P/S+P).
- Người dùng (2026-11-12): dấu S/P phải nhìn kỹ mới thấy. Muốn **chọn xem volume của từng sàn** (Binance spot, OKX, Bybit) để thấy ngay cây volume dài. Muốn thêm **nút cài đặt** để chỉnh cỡ chữ và các thông số hiển thị khác.

## Requirements / Spec

### A. Chọn nguồn volume (BTC)
1. Thay toggle "Volume gộp" bằng một ô chọn **"Volume:"** trên thanh toggle (nhớ trong localStorage):
   - `Binance Futures` (mặc định, như hiện tại khi tắt volume gộp);
   - `Gộp perp + spot` (như "Volume gộp" hiện tại: cột perp 3 sàn + phần spot cam, dấu S/P/S+P);
   - `Binance spot`;
   - `OKX perp`;
   - `Bybit perp`;
   - `Tổng 4 sàn` (perp + spot cộng chung một cột).
2. Chọn một nguồn đơn lẻ (spot / OKX / Bybit) hoặc Tổng 4 sàn:
   - cột volume các nến đã đóng là volume của nguồn đó (đơn vị BTC), màu theo nến tăng/giảm như bình thường, nên cây volume dài thấy ngay;
   - thang volume tự co giãn theo nguồn đã chọn;
   - **nến đang chạy**: chưa có volume của nguồn đó (chỉ có nến đã đóng), nên cột nến đang chạy để trống. Dòng ghi chú nhỏ: "Nến đang chạy chưa có volume <nguồn>";
   - **dấu đột biến** tính cho chính nguồn đó: volume > ngưỡng × trung vị 20 nến trước. Nhãn là chữ viết tắt của sàn (`SP` spot, `OKX`, `BB`, `Σ` tổng); nến nguồn đó thiếu dữ liệu thì không tính.
   - Legend khi rê chuột vẫn hiện volume từng sàn của nến.
3. Agent không đổi: `get_features.volumeAgg` vẫn là perp 3 sàn + spot. Lựa chọn trên chart chỉ để xem.

### B. Nút cài đặt hiển thị (⚙ trên thanh công cụ chart)
1. Bấm mở một bảng nhỏ. Mỗi mục có giá trị mặc định = như hiện tại, có nút **"Mặc định"** để đặt lại. Lưu localStorage theo trình duyệt, áp dụng ngay không cần tải lại.

   | Mục | Mặc định | Khoảng |
   |---|---|---|
   | Cỡ chữ nhãn đột biến volume | 9px | 7–14 |
   | Cỡ chữ nhãn order flow (số khối lượng tường, POC) | 10px | 8–14 |
   | Cỡ chữ nhãn phân tích (sự kiện, range, setup) | 11px | 9–15 |
   | Cỡ chữ trục giá / thời gian | 12px | 10–16 |
   | Ngưỡng đột biến volume trên chart | 3× | 2–6× (bước 0,5) |
   | Độ đậm heatmap thanh lý | 100% | 20–150% (nhân với độ đậm hiện tại) |
   | Bong bóng thanh lý: chỉ hiện cụm ≥ | 1× ngưỡng server | 1–5× |
   | Hiện đếm ngược đóng nến | bật | bật/tắt |
2. Ngưỡng đột biến ở đây chỉ đổi phần hiển thị trên chart. Đột biến gửi cho agent vẫn dùng `VOLAGG_SPIKE_X` của server.

## Technical Design
- **Shared** (pure, có test): `volumeSourceValue(bar, source)` lấy volume theo nguồn (null nếu thiếu); `findSeriesSpikes(values, x, window=20, minBars=15)` dùng chung với `findSpikes` của server (chuyển phần lõi trung vị sang `packages/shared`). Server `findSpikes` dùng lại lõi này, kết quả không đổi.
- **Web**:
  - `useChartSettingsStore` (zustand + localStorage, có kiểm tra khoảng giá trị);
  - `SettingsButton.tsx` (bảng nổi, đóng khi bấm ra ngoài / Esc);
  - các renderer đọc cỡ chữ từ settings (`OverlayPrimitive`, `SpikeLabelPrimitive`, `LiquidationPrimitive`, `CountdownPrimitive`, `layout.fontSize` của chart).
- `useVolumeAggStore`: `enabled` đổi thành `source` (giá trị cũ `wca:layerVolAgg=1` → `Gộp perp + spot`). Tải dữ liệu khi nguồn ≠ Binance Futures.
- `ChartController.setVolumeAggregate(data, source, spikeX)`:
  - nguồn đơn lẻ / tổng: một cột theo nguồn, ẩn cột spot chồng;
  - gộp: như hiện tại;
  - đột biến tính phía client theo ngưỡng trong settings.
- SPEC mục chart cập nhật.

## Implementation Steps
1. Shared: lõi đột biến + `volumeSourceValue` + test; server dùng lại (test cũ xanh).
2. Settings store + nút ⚙ + áp dụng cỡ chữ / ngưỡng / độ đậm / đếm ngược.
3. Ô chọn nguồn volume + ChartController + dấu đột biến theo nguồn + ghi chú nến đang chạy.
4. typecheck, lint, test; chụp BTC 5m với từng nguồn (spot / OKX / Bybit / tổng / gộp) và bảng cài đặt.

## Tests / Acceptance
- Chọn `Binance spot`: cột volume nến đã đóng bằng đúng volume spot (đối chiếu API); các nến spot đột biến hiện cây cao rõ và có dấu `SP`.
- Chọn `Binance Futures`: chart như hiện tại khi tắt volume gộp.
- Đổi cỡ chữ: nhãn đổi ngay; tải lại trang vẫn giữ. Bấm "Mặc định": về như cũ.
- Đổi ngưỡng đột biến trên chart không đổi `get_features.volumeAgg`.

## Ghi chú triển khai
- Dấu đột biến gắn vào cột volume chính: bản đầu gắn vào cột spot chồng (rỗng khi xem nguồn đơn lẻ) nên không quy đổi được toạ độ, không hiện dấu.
- Bảng ⚙ dùng `position: fixed` vì thanh công cụ có `overflow-x: auto` cắt mất bảng absolute.
- Đã kiểm tra thật BTC 5m nguồn Binance spot: cây spot cao + dấu `SP` ở 01:05, 01:15, 09:20 UTC khớp tính tay từ API.

## Approval Status
Đã duyệt (2026-11-12, "duyệt").
