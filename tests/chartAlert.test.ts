import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../apps/server/src/db/index.ts';
import { ChartAlertRepo } from '../apps/server/src/alerts/chartAlertRepo.ts';
import { ChartAlertWatcher, isPriceHit } from '../apps/server/src/alerts/chartAlertWatcher.ts';
import { config } from '../apps/server/src/config.ts';

describe('orderflowRetainH config', () => {
  it('mặc định là 72 giờ', () => {
    expect(config.orderflowRetainH).toBe(72);
  });
});

describe('isPriceHit', () => {
  it('giá bằng đúng target', () => {
    expect(isPriceHit(100, 100)).toBe(true);
  });

  it('giá cắt qua target từ dưới lên', () => {
    expect(isPriceHit(100, 105, 95)).toBe(true);
  });

  it('giá cắt qua target từ trên xuống', () => {
    expect(isPriceHit(100, 95, 105)).toBe(true);
  });

  it('giá không chạm target', () => {
    expect(isPriceHit(100, 99, 90)).toBe(false);
    expect(isPriceHit(100, 110, 102)).toBe(false);
  });
});

describe('ChartAlertRepo', () => {
  it('tạo, lấy theo symbol, xóa, trigger', () => {
    const db = openDb(':memory:');
    const repo = new ChartAlertRepo(db);

    const a1 = repo.create({
      symbol: 'BTCUSDT',
      price: 68000,
      type: 'once',
      color: '#f59e0b',
      opacity: 0.8,
      note: 'kháng cự',
    });

    expect(a1.id).toBeDefined();
    expect(a1.symbol).toBe('BTCUSDT');
    expect(a1.price).toBe(68000);
    expect(a1.type).toBe('once');
    expect(a1.color).toBe('#f59e0b');
    expect(a1.opacity).toBe(0.8);
    expect(a1.status).toBe('ACTIVE');

    const activeBtc = repo.listActive('BTCUSDT');
    expect(activeBtc.length).toBe(1);
    expect(activeBtc[0]!.id).toBe(a1.id);

    const activeEth = repo.listActive('ETHUSDT');
    expect(activeEth.length).toBe(0);

    // Trigger once -> status chuyển thành TRIGGERED
    const trig = repo.markTriggered(a1.id, 1000, true);
    expect(trig?.status).toBe('TRIGGERED');
    expect(trig?.triggeredAt).toBe(1000);
    expect(repo.listActive('BTCUSDT').length).toBe(0);

    // Tạo every -> trigger giữ ACTIVE
    const a2 = repo.create({
      symbol: 'ETHUSDT',
      price: 3000,
      type: 'every',
      color: '#3b82f6',
      opacity: 0.5,
    });

    const trig2 = repo.markTriggered(a2.id, 2000, false);
    expect(trig2?.status).toBe('ACTIVE');
    expect(trig2?.triggeredAt).toBe(2000);
    expect(repo.listActive('ETHUSDT').length).toBe(1);

    // Xóa
    expect(repo.delete(a2.id)).toBe(true);
    expect(repo.listActive('ETHUSDT').length).toBe(0);
    expect(repo.get(a2.id)).toBeNull();
  });
});

describe('ChartAlertWatcher', () => {
  it('trigger qua tick giá và gửi sự kiện SSE', () => {
    const db = openDb(':memory:');
    const repo = new ChartAlertRepo(db);
    const now = 1000;

    const sendMessage = vi.fn().mockResolvedValue({});
    const watcher = new ChartAlertWatcher({
      repo,
      sender: { sendMessage },
      telegramChatId: '123456',
      now: () => now,
      cooldownSec: 60,
    });

    const events: unknown[] = [];
    watcher.subscribe(e => events.push(e));
    watcher.start();

    const alert = repo.create({
      symbol: 'BTCUSDT',
      price: 68000,
      type: 'once',
      color: '#f59e0b',
      opacity: 1,
    });

    // Tick chưa chạm
    watcher.onPriceTick('BTCUSDT', 67500);
    expect(events.length).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();

    // Tick cắt qua 68000
    watcher.onPriceTick('BTCUSDT', 68100);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      kind: 'chart_alert',
      alert: { id: alert.id, status: 'TRIGGERED' },
      triggerPrice: 68100,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      '123456',
      expect.stringContaining('BTCUSDT'),
      expect.any(Object)
    );

    // Đã TRIGGERED nên tick tiếp theo không báo lại
    watcher.onPriceTick('BTCUSDT', 68000);
    expect(events.length).toBe(1);

    watcher.stop();
  });

  it('loại every có cooldown không spam liên tục', () => {
    const db = openDb(':memory:');
    const repo = new ChartAlertRepo(db);
    let now = 1000;

    const watcher = new ChartAlertWatcher({
      repo,
      now: () => now,
      cooldownSec: 60,
    });

    const events: unknown[] = [];
    watcher.subscribe(e => events.push(e));
    watcher.start();

    repo.create({
      symbol: 'BTCUSDT',
      price: 68000,
      type: 'every',
      color: '#3b82f6',
      opacity: 0.7,
    });

    // Lần 1: chạm giá
    watcher.onPriceTick('BTCUSDT', 68000);
    expect(events.length).toBe(1);

    // Lần 2: 10 giây sau chạm lại -> đang trong cooldown 60s -> không bắn event
    now = 1010;
    watcher.onPriceTick('BTCUSDT', 68000);
    expect(events.length).toBe(1);

    // Lần 3: 65 giây sau chạm lại -> hết cooldown -> bắn event lần 2
    now = 1065;
    watcher.onPriceTick('BTCUSDT', 68000);
    expect(events.length).toBe(2);

    watcher.stop();
  });

  it('trigger qua nến 1m [low, high]', () => {
    const db = openDb(':memory:');
    const repo = new ChartAlertRepo(db);

    const watcher = new ChartAlertWatcher({
      repo,
      now: () => 1000,
    });

    const events: unknown[] = [];
    watcher.subscribe(e => events.push(e));
    watcher.start();

    const alert = repo.create({
      symbol: 'SOLUSDT',
      price: 150,
      type: 'once',
      color: '#10b981',
      opacity: 0.9,
    });

    // Nến không phủ 150
    watcher.onCandle('SOLUSDT', 140, 149, 148);
    expect(events.length).toBe(0);

    // Nến phủ 150 (low 148, high 152)
    watcher.onCandle('SOLUSDT', 148, 152, 151);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      kind: 'chart_alert',
      alert: { id: alert.id, status: 'TRIGGERED' },
      triggerPrice: 151,
    });

    watcher.stop();
  });
});
