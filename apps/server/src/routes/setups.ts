import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SetupOutcome } from '@wca/shared';
import type { SetupHistoryRepo } from '../alerts/setupHistoryRepo.ts';

const historyQuerySchema = z.object({
  symbol: z.string().optional(),
  status: z.enum(['OPEN', 'TP_PARTIAL', 'TP_FULL', 'SL_HIT']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function registerSetupRoutes(app: FastifyInstance, repo: SetupHistoryRepo): void {
  app.get('/api/setups/history', async req => {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return { history: repo.listAll() };
    }
    const { symbol, status, limit } = parsed.data;
    const history = repo.listAll({
      symbol,
      status: status as SetupOutcome | undefined,
      limit,
    });
    return { history };
  });

  app.get('/api/setups/performance', async req => {
    const { symbol } = req.query as { symbol?: string };
    const summary = repo.getSummary(symbol);
    return { summary };
  });
}
