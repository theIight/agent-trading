import { ORDERFLOW_KIND_LABELS, roundPrice } from '@wca/shared';
import { cvdText, type BinanceOrderflowSnapshot } from './calc.ts';

// Bản tóm tắt order flow Binance cho agent (MCP get_orderflow): gọn, không có dữ liệu thô.

const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

export function formatOrderflowForAgent(s: BinanceOrderflowSnapshot): string {
  const toApp = (p: number) => roundPrice(p - s.offset, p);
  const lines: string[] = [
    `Order flow ${s.symbol} — ${s.venue}, lấy lúc ${iso(s.asOf)}. Lịch sử sổ lệnh dùng để tính: ${Math.round(s.historyMin)} phút.`,
    `MỌI giá dưới đây ĐÃ quy đổi về giá chart = giá ${s.venue} − basis ${s.offset} (trung vị 60 phút giá nguồn − giá chart). Lúc lấy: giá nguồn ${s.spotPrice}, giá chart ${s.appPrice ?? 'không rõ'}` +
      (s.appPrice != null ? ` (chênh lệch thực tế ${roundPrice(s.spotPrice - s.appPrice, s.spotPrice)})` : '') +
      '. Sai số quy đổi cỡ vài bucket giá; entry/SL/TP vẫn lấy từ get_klines.',
    ...s.notes.map(n => `Lưu ý: ${n}`),
    '',
    'Mức (server tính, sẽ tự vẽ lên chart; KHÔNG chép vào orderflow.levels):',
  ];
  if (!s.levels.length) lines.push('- (không có)');
  for (const lv of s.levels) {
    const extra = lv.persistMin !== undefined ? `, đứng ${Math.round(lv.persistMin)} phút` : '';
    lines.push(`- ${ORDERFLOW_KIND_LABELS[lv.kind]} ${lv.price}${lv.size !== undefined ? ` · ${lv.size} ${s.unit}` : ''}${extra} — ${lv.note}`);
  }
  if (s.profile) lines.push('', `Volume profile 24h (bucket ${s.profile.bucket}): POC ${toApp(s.profile.poc.price)}, vùng giá trị ${toApp(s.profile.valueArea.low)}–${toApp(s.profile.valueArea.high)}.`);
  const cvd = cvdText(s.cvd, s.unit);
  if (cvd) lines.push('', cvd);
  if (s.bigTrades.length) {
    lines.push('', `Lệnh market lớn nhất 4 giờ qua (bên chủ động):`);
    for (const t of s.bigTrades) lines.push(`- ${iso(t.t)} ${t.side === 'BUY' ? 'MUA' : 'BÁN'} ${t.qty} ${s.unit} @ ${toApp(t.price)}`);
  }
  if (s.liquidation) lines.push('', s.liquidation);
  lines.push(
    '',
    'Cách dùng: order flow chỉ để xác nhận/bác bỏ kịch bản Wyckoff (spring/test/upthrust, hấp thụ, tường chặn). Không dùng làm toạ độ entry/SL/TP trừ khi trùng cấu trúc giá. ' +
      'Nộp orderflow = { summary, cvd } (tiếng Việt); không gửi levels/lastPrices.',
  );
  return lines.join('\n');
}
