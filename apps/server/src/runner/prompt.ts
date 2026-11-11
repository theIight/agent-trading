import fs from 'node:fs';
import { tfLabel } from '@wca/shared';
import { fromRoot } from '../paths.ts';
import type { AgentRunRequest } from './types.ts';

export function loadSystemPrompt(): string {
  return fs.readFileSync(fromRoot('prompts/wyckoff.md'), 'utf8');
}

/** Tin nhắn người dùng gửi cho agent headless. */
export function buildUserPrompt(req: AgentRunRequest): string {
  const order = req.plan.map(p => `${tfLabel(p.tf)} (${p.tf}, ${p.role})`).join(' → ');
  return [
    `Phân tích Wyckoff cho ${req.instrument?.displayName ?? req.symbol} — symbol \`${req.symbol}\`, nguồn ${req.instrument?.sourceLabel ?? 'Binance Futures'}.`,
    ...(req.instrument?.volumeType === 'tick'
      ? ['Lưu ý: volume là TICK VOLUME (số lần đổi giá), không có nến cuối tuần — xem mục "Vàng / forex" trong system prompt.']
      : req.instrument?.volumeType === 'proxy'
        ? ['Lưu ý: giá vàng giao ngay (Tiingo), volume ghép từ hợp đồng OKX XAU-USDT-SWAP; volume = 0 là KHÔNG CÓ DỮ LIỆU (trước 04/2025) — xem mục "Vàng / forex" trong system prompt.']
        : []),
    `analysisId: ${req.analysisId}`,
    `Khung chính: ${req.primaryTf}`,
    `Thứ tự phân tích top-down (bắt buộc): ${order}`,
    `Số nến mặc định mỗi khung: ${req.barsPerTf}`,
    req.hasScreenshot ? 'Có ảnh chart: gọi get_chart_screenshot để đối chiếu.' : 'Không có ảnh chart.',
    ...(req.hasBookmap
      ? ['Có ảnh Bookmap (order flow): gọi get_bookmap_images sau khi đã phân tích khung lớn, làm theo mục "Bookmap (order flow)" trong system prompt và nộp trường `orderflow`.']
      : []),
    '',
    `Làm theo quy trình trong system prompt rồi gọi submit_analysis với analysisId="${req.analysisId}".`,
  ].join('\n');
}
