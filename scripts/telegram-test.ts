// Thử gửi một phân tích có sẵn vào Telegram (hoặc chỉ chụp ảnh + in caption nếu thêm --out).
// Dùng: npx tsx --env-file-if-exists=.env scripts/telegram-test.ts <analysisId> [--out <thư mục>] [--primary]
// Web để chụp: SNAPSHOT_WEB_URL (mặc định http://127.0.0.1:5173, phải đang chạy).
import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisRecord } from '@wca/shared';
import { config } from '../apps/server/src/config.ts';
import { ChartSnapshotter } from '../apps/server/src/notify/chartSnapshot.ts';
import { TelegramClient } from '../apps/server/src/notify/telegramClient.ts';
import { TelegramNotifier } from '../apps/server/src/notify/telegramNotifier.ts';
import { formatCaption, snapshotShots } from '../apps/server/src/notify/telegramFormat.ts';

const args = process.argv.slice(2);
const id = args.find(a => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
const mode = args.includes('--primary') ? 'primary' : config.telegramTfs;
if (!id) {
  console.error('Thiếu analysisId');
  process.exit(1);
}

const res = await fetch(`${config.snapshotWebUrl}/api/analyses/${encodeURIComponent(id)}`);
if (!res.ok) throw new Error(`Không lấy được phân tích: HTTP ${res.status}`);
const rec = (await res.json()) as AnalysisRecord;
const snap = new ChartSnapshotter({ webUrl: config.snapshotWebUrl, channel: config.snapshotChromeChannel });

try {
  if (outDir) {
    const plan = snapshotShots(rec, mode);
    const t0 = Date.now();
    const shots = await snap.capture(rec.id, plan);
    fs.mkdirSync(outDir, { recursive: true });
    shots.forEach((b, i) => fs.writeFileSync(path.join(outDir, `${rec.symbol}-${plan[i]!.tf}.png`), b));
    console.log(`Đã chụp ${shots.length} ảnh trong ${Date.now() - t0}ms → ${outDir}`);
    console.log(formatCaption(rec));
  } else {
    if (!config.telegramBotToken || !config.telegramChatId) throw new Error('Thiếu TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
    const n = new TelegramNotifier({
      chatId: config.telegramChatId,
      sender: new TelegramClient({ token: config.telegramBotToken, threadId: config.telegramThreadId }),
      capture: snap.capture,
      tfs: mode,
      notifyFailed: true,
    });
    n.enqueue(rec);
    await n.idle();
  }
} finally {
  await snap.close();
}
