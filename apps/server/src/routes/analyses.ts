import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { normalizeSymbol, type ProgressEvent } from '@wca/shared';
import type { AnalysisRepo } from '../analysis/repo.ts';
import { ServiceError, type AnalysisService } from '../analysis/service.ts';

const startSchema = z.object({
  symbol: z.string().min(2).max(30),
  primaryTf: z.string(),
  contextTfs: z.array(z.string()).max(8).default([]),
  screenshot: z.string().max(12_000_000).optional(),
  runner: z.string().optional(),
  model: z.string().max(80).optional(),
});

function openSse(req: FastifyRequest, reply: FastifyReply, subscribe: (send: (e: ProgressEvent) => void) => () => void) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const send = (e: ProgressEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const unsubscribe = subscribe(send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  return send;
}

export function registerAnalysisRoutes(app: FastifyInstance, service: AnalysisService, repo: AnalysisRepo, internalToken: string): void {
  // ---------- API cho UI ----------
  app.post('/api/analyses', async (req, reply) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    try {
      return service.start(parsed.data);
    } catch (err) {
      if (err instanceof ServiceError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/analyses', async req => {
    const { symbol, limit } = req.query as { symbol?: string; limit?: string };
    return repo.list(symbol ? normalizeSymbol(symbol) : undefined, Math.min(Number(limit) || 50, 200));
  });

  app.get('/api/analyses/:id', async (req, reply) => {
    const rec = repo.get((req.params as { id: string }).id);
    return rec ?? reply.code(404).send({ error: 'Không tìm thấy' });
  });

  app.post('/api/analyses/:id/cancel', async (req, reply) => {
    const ok = service.cancel((req.params as { id: string }).id);
    return ok ? { ok } : reply.code(404).send({ error: 'Không có phân tích đang chạy với id này' });
  });

  app.get('/api/analyses/:id/stream', (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = repo.get(id);
    if (!rec) return reply.code(404).send({ error: 'Không tìm thấy' });
    const send = openSse(req, reply, s => service.subscribe(s, id));
    // Nếu đã xong trước khi client kết nối, gửi ngay kết quả.
    if (rec.status !== 'RUNNING') send({ kind: 'result', analysisId: id, record: rec });
  });

  /** SSE chung: kết quả từ mọi nguồn (kể cả Claude Code tương tác). */
  app.get('/api/events', (req, reply) => {
    openSse(req, reply, s => service.subscribe(e => (e.kind === 'result' || e.kind === 'status' ? s(e) : undefined)));
  });

  // ---------- API nội bộ cho MCP (chỉ localhost + token) ----------
  app.register(async internal => {
    internal.addHook('onRequest', async (req, reply) => {
      const ip = req.socket.remoteAddress ?? '';
      const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!local || req.headers['x-wca-token'] !== internalToken) return reply.code(403).send({ error: 'forbidden' });
    });

    internal.get('/internal/analyses/:id/request', async (req, reply) => {
      try {
        return await service.getRequest((req.params as { id: string }).id);
      } catch (err) {
        if (err instanceof ServiceError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    });

    internal.get('/internal/analyses/:id/screenshot', async (req, reply) => {
      const file = service.screenshotPath((req.params as { id: string }).id);
      if (!fs.existsSync(file)) return reply.code(404).send({ error: 'Không có ảnh chart' });
      return reply.type('image/png').send(fs.readFileSync(file));
    });

    internal.post('/internal/submit', async req => {
      const body = (req.body ?? {}) as { analysisId?: string; analysis?: unknown };
      return service.submit(body.analysisId || undefined, body.analysis);
    });
  });
}
