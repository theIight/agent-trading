import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChartAlertRepo } from '../alerts/chartAlertRepo.ts';
import type { ChartAlertWatcher } from '../alerts/chartAlertWatcher.ts';

const createAlertSchema = z.object({
  symbol: z.string().min(2).max(30),
  price: z.number().positive().finite(),
  type: z.enum(['once', 'every']),
  color: z.string().min(1).max(30),
  opacity: z.number().min(0.1).max(1),
  note: z.string().max(200).optional(),
});

export function registerChartAlertRoutes(
  app: FastifyInstance,
  repo: ChartAlertRepo,
  watcher?: ChartAlertWatcher | null,
): void {
  app.get('/api/chart-alerts', async req => {
    const { symbol } = req.query as { symbol?: string };
    return { alerts: repo.listActive(symbol ? symbol.toUpperCase() : undefined) };
  });

  app.post('/api/chart-alerts', async (req, reply) => {
    const parsed = createAlertSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const alert = repo.create(parsed.data);
    watcher?.refreshFeeds();
    return { alert };
  });

  app.delete('/api/chart-alerts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = repo.delete(id);
    if (!ok) return reply.code(404).send({ error: 'Alert không tồn tại' });
    watcher?.refreshFeeds();
    return { ok: true };
  });
}
