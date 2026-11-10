// Chụp ảnh UI để kiểm tra trực quan.
// Dùng: npx tsx scripts/screenshot.ts [url] [out.png] [waitMs]
// Mặc định dùng Chrome đã cài trên máy (channel 'chrome'); đặt PW_CHANNEL= để dùng Chromium của Playwright.
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const out = process.argv[3] ?? 'screenshot.png';
const waitMs = Number(process.argv[4] ?? 4000);

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const logs: string[] = [];
page.on('console', msg => {
  if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(waitMs);
await page.screenshot({ path: out });
await browser.close();
if (logs.length) console.log(logs.join('\n'));
console.log(`saved ${out}`);
