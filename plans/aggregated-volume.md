# Volume gộp nhiều sàn cho BTC (nến đã đóng): perp gộp + spot riêng, đánh dấu đột biến

## Bối cảnh
- Volume trên chart BTC hiện chỉ lấy từ Binance Futures.
- Đo trên 288 nến 5m ngày 2026-11-12:
  - OKX perp tương quan 0,93 với Binance futures;
  - Binance spot tương quan chỉ 0,46, có 17 lần đột biến, trong đó 10 lần Binance futures không có.
- Khối lượng 24h: Binance futures 118k BTC, OKX perp 69k, Bybit perp 49k, Binance spot 12,8k.
- Kết luận: cộng các perp vào chủ yếu làm cột cao hơn. Spot là nguồn thông tin khác và nhỏ hơn perp khoảng 18 lần, nên phải hiện **riêng**.
- Người dùng chốt (2026-11-12): đồng ý hướng này; **chỉ nến đã đóng**, nến đang chạy giữ nguyên như hiện tại.

## Requirements / Spec
1. **Nguồn** (symbol bật qua `VOLAGG_SYMBOLS`, mặc định `BTCUSDT`):
   - **Perp**: Binance Futures BTCUSDT (volume đã có sẵn trong nến chart) + OKX `BTC-USDT-SWAP` (`volCcy` = BTC) + Bybit linear `BTCUSDT` (`volume` = BTC).
   - **Spot**: Binance spot BTCUSDT.
   - Nến lấy bằng REST công khai, không cần key, **chỉ nến đã đóng**.
2. **Nến chart giữ nguyên Binance futures** (OHLC và cột volume hiện tại).
3. **Volume gộp** cho mỗi nến đã đóng của khung đang xem:
   - `perp` = Binance futures + OKX + Bybit;
   - `spot` = Binance spot;
   - kèm volume từng sàn (`venues`) để xem chi tiết.
   - Sàn nào thiếu nến đó (lỗi, chưa có lịch sử) → đánh dấu nến **chưa đầy đủ**, không tính đột biến cho nhóm bị thiếu.
4. **Đột biến**: tính riêng cho từng nhóm (perp, spot). Nến đột biến khi volume nhóm > `VOLAGG_SPIKE_X` (mặc định 3) × trung vị 20 nến đã đóng trước đó (cần đủ ≥ 15 nến có dữ liệu). Phân loại:
   - `BOTH`: cả perp và spot cùng đột biến;
   - `SPOT`: spot đột biến, perp bình thường. Thường là tiền thật vào/ra, đánh dấu rõ nhất;
   - `PERP`: perp đột biến, spot bình thường. Thường là đòn bẩy hoặc thanh lý.
5. **Chart (khi bật toggle "Volume gộp", mặc định tắt, nhớ trong localStorage):**
   - Cột volume xếp chồng thay cho cột volume hiện tại ở các nến đã đóng:
     - dưới là perp (màu theo nến tăng/giảm như hiện tại);
     - trên là spot (màu riêng, ví dụ vàng cam).
   - Nến đang chạy vẫn là cột volume Binance futures như cũ.
   - Dấu đột biến dưới cột volume: `S` cho spot (cam đậm), `P` cho perp (xám), `S+P` cho cả hai (đậm nhất).
   - Tooltip/legend khi rê chuột: volume từng sàn và perp/spot của nến.
   - Tắt toggle → về đúng như hiện tại.
6. **Agent** (làm sau phần chart):
   - `get_features` thêm `volumeAgg`:
     - với 20 nến gần nhất: perp, spot, tỷ lệ spot/perp so với trung vị;
     - danh sách nến đột biến trong khung (unix, loại BOTH/SPOT/PERP, bội số so với trung vị).
   - Prompt: với Wyckoff, đột biến spot (BOTH/SPOT) ở SC/BC/Spring/UTAD đáng tin hơn đột biến chỉ perp. Đột biến chỉ perp thường là thanh lý/đòn bẩy.
   - Volume Binance futures vẫn là cột `volume` gốc trong `get_klines`; không đổi contract nến.
7. **Phạm vi lịch sử**: theo số nến chart đang tải.
   - Bybit tối đa 1.000 nến mỗi lần gọi, OKX 300 (`history-candles` 100), Binance 1.000–1.500 → phân trang.
   - Server cache SQLite nên mỗi nến đã đóng chỉ tải một lần.

## Technical Design
- **Contract** `packages/shared/src/volumeAgg.ts`:
  - `VolumeAggBar {time, perp, spot, venues: {binanceFut, okx, bybit, binanceSpot}, complete: boolean}`;
  - `VolumeSpike {time, kind: 'BOTH'|'SPOT'|'PERP', perpX, spotX}`;
  - `VolumeAggResponse {symbol, tf, bars[], spikes[], notes[]}`.
- **Server** `apps/server/src/volumeAgg/`:
  - `sources.ts`: fetch nến đã đóng từng sàn theo khung (map tf → tham số từng sàn), quy về BTC.
  - `store.ts`: bảng `venue_volume(symbol, venue, tf, t, volume)` (PK symbol, venue, tf, t); chỉ tải phần thiếu.
  - `calc.ts` (pure, có test): `mergeBars`, `findSpikes` (trung vị 20, ngưỡng, phân loại, xử lý nến thiếu).
  - API `GET /api/volume-agg/:symbol?tf=&limit=` (≤ 1000 nến đã đóng); `/api/config.volumeAgg = {symbols}`.
- **Web**:
  - `useVolumeAggStore`: tải khi đổi symbol/khung và khi có nến mới đóng (theo `time` của nến cuối đã đóng thay đổi), không poll liên tục;
  - `ChartController`: khi bật thì thêm 1 histogram series (spot) chồng lên volume perp. Cột perp = setData theo volume perp của nến đã đóng; nến đang chạy giữ dữ liệu live;
  - dấu đột biến bằng primitive nhỏ dưới vùng volume;
  - toggle trong `LayerToggles`.
- **Agent**: `features/index.ts` nhận thêm volume gộp (server truyền vào khi symbol bật), MCP `get_features` in kèm. Prompt cập nhật.
- SPEC, README, `.env.example`.

## Implementation Steps
1. Contract + `calc.ts` + test (gộp, thiếu sàn, trung vị 20, phân loại BOTH/SPOT/PERP).
2. `sources.ts` + store + test parse từng sàn (đơn vị BTC, chỉ nến đã đóng, phân trang).
3. API + cache; kiểm tra thật với 1m/15m/1h/4h/1d: tổng perp khớp tổng 3 sàn.
4. Web: series spot chồng, dấu đột biến, toggle, legend.
5. Agent: `get_features` + prompt.
6. typecheck, lint, test; chụp BTC 5m/1H bật "Volume gộp".

## Tests / Acceptance
- Tắt toggle: chart giống hệt hiện tại. Bật: nến đã đóng có cột perp + spot xếp chồng, nến đang chạy không đổi.
- Nến có sàn bị thiếu không bị báo đột biến sai cho nhóm đó.
- Đột biến SPOT hiện đúng ở các nến spot > 3× trung vị khi perp bình thường (đối chiếu số liệu thật).
- `get_features` có `volumeAgg`; agent thấy loại đột biến.
- Đổi khung/symbol không gọi lại sàn cho nến đã cache.

## Ghi chú triển khai
- OKX `history-candles` bị 429 khi phân trang liên tục → nghỉ 150ms giữa các trang + thử lại khi 429 (1/2/4s). OKX khung ngày/tuần dùng `1Dutc`/`1Wutc` (mặc định theo giờ HK).
- Kiểm tra thật: 1m/5m/1h/1d/1w đủ 4 sàn; OKX ngày 11/11 = 72.825,79 BTC khớp ticker; gọi lại không tải lại nến đã cache.
- Cột perp khi bật volume gộp dùng màu đặc (đã trộn với nền): màu trong suốt để lộ cột cam phía sau, nhìn như spot rất lớn.
- Hoãn thử lại chỉ áp cho đúng khoảng nến vừa thử (bản đầu hoãn mọi nến cũ hơn → tải thêm lịch sử bị thiếu 300/800 nến).
- Dấu đột biến dùng series markers trên cột spot (không cần primitive riêng).
- Mật độ đột biến ở ngưỡng 3×: 1m ~14% số nến, 5m ~9%, 1h ~10% (chỉnh `VOLAGG_SPIKE_X` nếu thấy dày).

## Approval Status
Đã duyệt (2026-11-12, "ok").
