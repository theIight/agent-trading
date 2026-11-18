import { afterEach, describe, expect, it } from 'vitest';
import type { Candle, PriceAlert, ProgressEvent } from '@wca/shared';
import { openDb, type Db } from '../apps/server/src/db/index.ts';
import {
  calculatePnlPct,
  calculateRiskReward,
  evaluatePositionCandles,
  evaluatePositionPrice,
} from '../apps/server/src/alerts/alertLogic.ts';
import { AlertRepo } from '../apps/server/src/alerts/alertRepo.ts';
import { AlertWatcher } from '../apps/server/src/alerts/alertWatcher.ts';
import { SetupHistoryRepo } from '../apps/server/src/alerts/setupHistoryRepo.ts';

const T0 = 1700000000;

const candle = (time: number, low: number, high: number, close = (low + high) / 2): Candle => ({
  time,
  open: (low + high) / 2,
  high,
  low,
  close,
  volume: 10,
});

describe('Setup TP/SL & History Tracking', () => {
  let db: Db;
  afterEach(() => db?.close());

  describe('Pure logic: calculateRiskReward & calculatePnlPct', () => {
    it('calculates correct R:R and PnL for LONG', () => {
      // Entry 100, SL 90 (risk 10), TP1 120 (reward 20) -> RR 2.0, PnL +20%
      expect(calculateRiskReward('LONG', 100, 90, 120)).toBe(2);
      expect(calculatePnlPct('LONG', 100, 120)).toBe(20);

      // Entry 100, SL 90, SL hit at 90 -> RR -1.0, PnL -10%
      expect(calculateRiskReward('LONG', 100, 90, 90)).toBe(-1);
      expect(calculatePnlPct('LONG', 100, 90)).toBe(-10);
    });

    it('calculates correct R:R and PnL for SHORT', () => {
      // Entry 100, SL 110 (risk 10), TP1 80 (reward 20) -> RR 2.0, PnL +20%
      expect(calculateRiskReward('SHORT', 100, 110, 80)).toBe(2);
      expect(calculatePnlPct('SHORT', 100, 80)).toBe(20);

      // Entry 100, SL 110, SL hit at 110 -> RR -1.0, PnL -10%
      expect(calculateRiskReward('SHORT', 100, 110, 110)).toBe(-1);
      expect(calculatePnlPct('SHORT', 100, 110)).toBe(-10);
    });
  });

  describe('evaluatePositionCandles & evaluatePositionPrice', () => {
    const longAlert: Pick<PriceAlert, 'direction' | 'stopLoss' | 'takeProfits'> & { entryPrice: number } = {
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 90,
      takeProfits: [110, 120],
    };

    it('evaluates LONG hitting TP1 then TP2 across candles', () => {
      const candles: Candle[] = [
        candle(T0 + 60, 98, 105),
        candle(T0 + 120, 104, 112), // hits TP1 (110)
        candle(T0 + 180, 111, 125), // hits TP2 (120)
      ];

      const res = evaluatePositionCandles(longAlert, candles, new Set(), T0);
      expect(res.hitTps).toHaveLength(2);
      expect(res.hitTps[0]).toEqual({
        index: 0,
        price: 110,
        time: T0 + 120,
        rr: 1,
        pnlPct: 10,
      });
      expect(res.hitTps[1]).toEqual({
        index: 1,
        price: 120,
        time: T0 + 180,
        rr: 2,
        pnlPct: 20,
      });
      expect(res.slHit).toBeUndefined();
    });

    it('stops at SL if hit before TP', () => {
      const candles: Candle[] = [
        candle(T0 + 60, 95, 102),
        candle(T0 + 120, 88, 96), // hits SL (90)
        candle(T0 + 180, 85, 115), // shouldn't reach TP because position was stopped out
      ];

      const res = evaluatePositionCandles(longAlert, candles, new Set(), T0);
      expect(res.hitTps).toHaveLength(0);
      expect(res.slHit).toBeDefined();
      expect(res.slHit?.price).toBe(90);
      expect(res.slHit?.time).toBe(T0 + 120);
      expect(res.slHit?.rr).toBe(-1);
    });

    it('evaluates tick price correctly', () => {
      const hitRes = evaluatePositionPrice(longAlert, 112, T0 + 10, new Set());
      expect(hitRes.hitTps).toHaveLength(1);
      expect(hitRes.hitTps[0]?.index).toBe(0);

      // If already hit TP1, checks TP2
      const nextHit = evaluatePositionPrice(longAlert, 121, T0 + 20, new Set([0]));
      expect(nextHit.hitTps).toHaveLength(1);
      expect(nextHit.hitTps[0]?.index).toBe(1);

      // SL hit
      const slRes = evaluatePositionPrice(longAlert, 89, T0 + 30, new Set());
      expect(slRes.slHit).toBeDefined();
      expect(slRes.slHit?.price).toBe(89);
    });
  });

  describe('SetupHistoryRepo', () => {
    it('creates history records and aggregates performance summary', () => {
      db = openDb(':memory:');
      const repo = new SetupHistoryRepo(db);

      const fakeAlert: PriceAlert = {
        id: 1,
        analysisId: 'ana-1',
        symbol: 'BTCUSDT',
        setupIndex: 0,
        direction: 'LONG',
        entryType: 'LIMIT',
        tf: '15m',
        entryLow: 99,
        entryHigh: 101,
        stopLoss: 90,
        takeProfits: [110, 120],
        riskReward: 2,
        validUntil: T0 + 3600,
        armedAt: T0,
        status: 'TRIGGERED',
        statusAt: T0 + 60,
        entryPrice: 100,
        entryAt: T0 + 60,
      };

      // 1. Create from alert
      const rec = repo.createFromAlert(fakeAlert, 100, T0 + 60);
      expect(rec.id).toBeDefined();
      expect(rec.status).toBe('OPEN');
      expect(rec.entryPrice).toBe(100);

      // 2. Hit TP1
      const afterTp1 = repo.recordTpHit(1, {
        index: 0,
        price: 110,
        time: T0 + 120,
        riskReward: 1.0,
        pnlPct: 10,
      }, false);
      expect(afterTp1?.status).toBe('OPEN');
      expect(afterTp1?.hitTps).toHaveLength(1);
      expect(afterTp1?.realizedRr).toBe(1.0);

      // 3. Hit TP2 (final)
      const afterTp2 = repo.recordTpHit(1, {
        index: 1,
        price: 120,
        time: T0 + 180,
        riskReward: 2.0,
        pnlPct: 20,
      }, true);
      expect(afterTp2?.status).toBe('TP_FULL');
      expect(afterTp2?.realizedRr).toBe(2.0);
      expect(afterTp2?.exitPrice).toBe(120);

      // 4. Create second trade (hits SL)
      const fakeAlert2: PriceAlert = {
        ...fakeAlert,
        id: 2,
        analysisId: 'ana-2',
        symbol: 'BTCUSDT',
      };
      repo.createFromAlert(fakeAlert2, 100, T0 + 300);
      const afterSl = repo.recordSlHit(2, 90, T0 + 400, -1.0, -10);
      expect(afterSl?.status).toBe('SL_HIT');
      expect(afterSl?.realizedRr).toBe(-1.0);

      // 5. Check performance summary
      const summary = repo.getSummary('BTCUSDT');
      expect(summary.totalTrades).toBe(2);
      expect(summary.openTrades).toBe(0);
      expect(summary.closedTrades).toBe(2);
      expect(summary.winTrades).toBe(1);
      expect(summary.lossTrades).toBe(1);
      expect(summary.winRate).toBe(50);
      expect(summary.totalRealizedRr).toBe(1.0); // 2.0 - 1.0
      expect(summary.avgRealizedRr).toBe(0.5);
    });
  });

  describe('AlertWatcher TP/SL Integration', () => {
    it('evaluates running position, emits setup_tp & setup_sl events, and updates repo', async () => {
      db = openDb(':memory:');
      const alertRepo = new AlertRepo(db);
      const historyRepo = new SetupHistoryRepo(db);

      const events: ProgressEvent[] = [];
      const messages: string[] = [];

      const mockSender = {
        sendMessage: async (_chatId: string, text: string) => {
          messages.push(text);
          return {};
        },
      };

      let klineCandles: Candle[] = [];
      const watcher = new AlertWatcher({
        repo: alertRepo,
        historyRepo,
        klines: { getKlines: async () => ({ candles: klineCandles }) },
        isCrypto: () => true,
        getRecord: () => null,
        maxAgeH: 72,
        sender: mockSender,
        destinationOf: () => ({ chatId: '123' }),
        now: () => (T0 + 300) * 1000,
      });

      watcher.subscribe(e => events.push(e));

      // 1. Insert alert and trigger entry
      alertRepo.replaceAndInsert('BTCUSDT', 'ana-1', [{
        analysisId: 'ana-1',
        symbol: 'BTCUSDT',
        setupIndex: 0,
        direction: 'LONG',
        entryType: 'LIMIT',
        tf: '15m',
        entryLow: 99,
        entryHigh: 101,
        stopLoss: 90,
        takeProfits: [110, 120],
        riskReward: 2.0,
        validUntil: T0 + 3600,
        armedAt: T0,
      }], T0);

      const armed = alertRepo.armed()[0]!;
      alertRepo.transition(armed.id, 'TRIGGERED', T0 + 60, { price: 100 });
      historyRepo.createFromAlert(alertRepo.get(armed.id)!, 100, T0 + 60);

      expect(alertRepo.listInTrade('BTCUSDT')).toHaveLength(1);
      expect(historyRepo.getByAlertId(armed.id)?.status).toBe('OPEN');

      // 2. Feed candle that hits TP1
      klineCandles = [
        candle(T0 + 60, 99, 102),
        candle(T0 + 120, 101, 112), // hits TP1 (110)
      ];

      await watcher.check();

      // Check that setup_tp event was fired
      const tpEv = events.find(e => e.kind === 'setup_tp');
      expect(tpEv).toBeDefined();
      expect(messages.some(m => m.includes('chạm <b>TP1</b>'))).toBe(true);

      const inTradeAfterTp1 = alertRepo.get(armed.id);
      expect(inTradeAfterTp1?.status).toBe('TP_HIT');
      expect(inTradeAfterTp1?.hitTps).toHaveLength(1);

      // 3. Feed candle that hits SL after TP1
      klineCandles = [
        candle(T0 + 180, 89, 105), // hits SL (90)
      ];

      await watcher.check();

      const slEv = events.find(e => e.kind === 'setup_sl');
      expect(slEv).toBeDefined();
      expect(messages.some(m => m.includes('chạm <b>Stop Loss</b>'))).toBe(true);

      const afterSl = alertRepo.get(armed.id);
      expect(afterSl?.status).toBe('SL_HIT');

      const histRec = historyRepo.getByAlertId(armed.id);
      expect(histRec?.status).toBe('TP_PARTIAL'); // had TP1 before SL
    });
  });
});
