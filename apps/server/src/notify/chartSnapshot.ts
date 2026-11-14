import type { Browser } from 'playwright-core';
import type { SnapshotShot } from './telegramFormat.ts';

// Chụp chart kết quả phân tích bằng Chrome headless mở trang web `?snapshot=<id>&tf=<tf>[&hide=action,levels]`.
// Mỗi lần chụp dùng context mới (localStorage trống) → ảnh ổn định, không đụng cài đặt của người dùng.

export interface ChartSnapshotOptions {
  webUrl: string;
  /** Channel Playwright (`chrome`); undefined = Chromium của Playwright. */
  channel?: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
  /** Đóng browser sau bấy nhiêu ms không dùng. */
  idleCloseMs?: number;
}

export type CaptureFn = (analysisId: string, shots: readonly SnapshotShot[]) => Promise<Buffer[]>;

export class ChartSnapshotter {
  private browser: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private busy = 0;

  constructor(private readonly opts: ChartSnapshotOptions) {}

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const { chromium } = await import('playwright-core');
      this.browser = chromium.launch({ channel: this.opts.channel, headless: true }).catch(err => {
        this.browser = null;
        throw err;
      });
    }
    return this.browser;
  }

  capture: CaptureFn = async (analysisId, shots) => {
    this.busy++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      const browser = await this.getBrowser();
      const out: Buffer[] = [];
      for (const shot of shots) out.push(await this.captureOne(browser, analysisId, shot));
      return out;
    } finally {
      this.busy--;
      if (!this.busy) this.idleTimer = setTimeout(() => void this.close(), this.opts.idleCloseMs ?? 60_000);
    }
  };

  private async captureOne(browser: Browser, analysisId: string, { tf, hide }: SnapshotShot): Promise<Buffer> {
    const ctx = await browser.newContext({
      viewport: { width: this.opts.width ?? 1600, height: this.opts.height ?? 900 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    try {
      const page = await ctx.newPage();
      const q = new URLSearchParams({ snapshot: analysisId, tf });
      if (hide.length) q.set('hide', hide.join(','));
      const url = `${this.opts.webUrl}/?${q}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.opts.timeoutMs ?? 20_000 });
      // Trang đặt `body[data-snapshot=ready|error]` khi chart + overlay đã vẽ xong.
      await page.waitForSelector('body[data-snapshot]', { state: 'attached', timeout: this.opts.timeoutMs ?? 20_000 });
      const state = await page.getAttribute('body', 'data-snapshot');
      if (state !== 'ready') {
        const err = (await page.getAttribute('body', 'data-snapshot-error')) ?? '';
        throw new Error(`Trang snapshot lỗi (${tf}): ${err.slice(0, 200)}`);
      }
      return await page.locator('.chart-wrap').screenshot({ type: 'png' });
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const b = this.browser;
    this.browser = null;
    if (b) await (await b.catch(() => null))?.close().catch(() => {});
  }
}
