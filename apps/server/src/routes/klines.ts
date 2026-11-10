import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isTimeframe, normalizeSymbol, type MarketSource, type Timeframe } from '@wca/shared';
import type { KlineService } from '../market/klineService.ts';
import type { LiveEvent } from '../market/livePoller.ts';
import type { RoutingProvider } from '../market/router.ts';

const querySchema = z.object({
  symbol: z.string().min(2).max(30),
  tf: z.string().refine(isTimeframe, 'Khung không hỗ trợ'),
  limit: z.coerce.number().int().min(1).max(1500).default(500),
  endTime: z.coerce.number().int().positive().optional(),
  closedOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => v === 'true'),
});

/** Nguồn realtime phía server (OANDA poll, Tiingo WebSocket + OKX). */
export interface LiveSource {
  subscribe(symbol: string, tf: Timeframe, listener: (e: LiveEvent) => void): () => void;
}

export function registerKlineRoutes(
  app: FastifyInstance,
  klines: KlineService,
  router?: RoutingProvider,
  lives: Partial<Record<MarketSource, LiveSource>> = {},
): void {
  app.get('/api/instruments/:symbol', async req => {
    const symbol = normalizeSymbol((req.params as { symbol: string }).symbol);
    return router ? router.instrument(symbol) : { symbol, source: 'binance-futures' };
  });

  // Realtime qua SSE cho nguồn không có WebSocket trình duyệt (OANDA).
  app.get('/api/live', async (req, reply) => {
    const { symbol: rawSymbol, tf } = req.query as { symbol?: string; tf?: string };
    if (!rawSymbol || !tf || !isTimeframe(tf)) return reply.code(400).send({ error: 'Cần symbol và tf hợp lệ' });
    const symbol = normalizeSymbol(rawSymbol);
    const live = router ? lives[router.sourceOf(symbol)] : undefined;
    if (!live) return reply.code(400).send({ error: `${symbol} dùng WebSocket Binance trực tiếp, không qua /api/live` });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const unsubscribe = live.subscribe(symbol, tf, e => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get('/api/klines', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues.map(i => i.message).join('; ') });
    }
    const q = parsed.data;
    try {
      return await klines.getKlines({
        symbol: normalizeSymbol(q.symbol),
        tf: q.tf as Timeframe,
        limit: q.limit,
        endTime: q.endTime,
        closedOnly: q.closedOnly,
      });
    } catch (err) {
      req.log.error({ err }, 'getKlines failed');
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
