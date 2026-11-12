import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { BookmapUiConfig } from '@wca/shared';
import { AnalysisRepo } from './analysis/repo.ts';
import { AnalysisService } from './analysis/service.ts';
import { config, type AppConfig } from './config.ts';
import { openDb, type Db } from './db/index.ts';
import { BinanceFuturesProvider } from './market/binanceFutures.ts';
import { LivePoller } from './market/livePoller.ts';
import { OandaProvider } from './market/oanda.ts';
import { OkxVolumeClient } from './market/okx.ts';
import { RoutingProvider } from './market/router.ts';
import { RequestQuota, TiingoFxClient } from './market/tiingo.ts';
import { TiingoOkxLive, TiingoOkxProvider } from './market/tiingoOkx.ts';
import { KlineService } from './market/klineService.ts';
import type { MarketDataProvider } from './market/provider.ts';
import { fromRoot, ROOT } from './paths.ts';
import { registerAnalysisRoutes } from './routes/analyses.ts';
import { registerKlineRoutes } from './routes/klines.ts';
import { AgyRunner } from './runner/agyRunner.ts';
import { ClaudeCodeRunner } from './runner/claudeCodeRunner.ts';
import type { AgentRunner } from './runner/types.ts';
import { BinanceOrderflow } from './orderflow/binanceOrderflow.ts';
import { BookCollector } from './orderflow/collector.ts';

export interface AppDeps {
  config?: AppConfig;
  db?: Db;
  provider?: MarketDataProvider;
  /** Thay runner thật (test). */
  runners?: AgentRunner[];
  logger?: boolean;
  dataDir?: string;
  /** false = không chạy collector order flow Binance (test). */
  orderflow?: boolean;
}

/** Token cho API nội bộ (MCP ↔ server); lưu file để MCP chạy từ Claude Code tương tác cũng đọc được. */
function ensureInternalToken(dataDir: string): string {
  const file = path.join(dataDir, 'internal-token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** Đổi tên symbol trước khi gọi provider (vd XAUUSD → XAUUSDT khi XAUUSD_SOURCE=binance). */
function aliasProvider(p: MarketDataProvider, alias: Record<string, string>): MarketDataProvider {
  return { name: p.name, maxLimit: p.maxLimit, fetchKlines: params => p.fetchKlines({ ...params, symbol: alias[params.symbol] ?? params.symbol }) };
}

export async function buildApp(deps: AppDeps = {}) {
  const cfg = deps.config ?? config;
  const dataDir = deps.dataDir ?? fromRoot('data');
  const db = deps.db ?? openDb(fromRoot(cfg.dbPath));
  const tiingoOkx = new TiingoOkxProvider({
    tiingo: new TiingoFxClient({ token: cfg.tiingoApiToken, quota: new RequestQuota(cfg.tiingoMaxPerHour, cfg.tiingoMaxPerDay) }),
    okx: new OkxVolumeClient({ instId: cfg.okxVolumeInst }),
    tickerOf: s => (s === 'XAUUSD' ? cfg.tiingoXauTicker : s.toLowerCase()),
  });
  const binance = deps.provider ?? new BinanceFuturesProvider();
  const router = new RoutingProvider({
    binance: cfg.xauusdSource === 'binance' ? aliasProvider(binance, { XAUUSD: 'XAUUSDT' }) : binance,
    oanda: new OandaProvider({ token: cfg.oandaApiToken, env: cfg.oandaEnv, price: cfg.oandaPrice }),
    tiingoOkx,
    oandaSymbols: cfg.oandaSymbols.filter(s => s !== 'XAUUSD' || cfg.xauusdSource === 'oanda'),
    tiingoOkxSymbols: cfg.xauusdSource === 'tiingo-okx' ? ['XAUUSD'] : [],
    oandaPrice: cfg.oandaPrice,
  });
  const provider: MarketDataProvider = router;
  const lives = {
    oanda: new LivePoller(router, cfg.livePollMs),
    'tiingo-okx': new TiingoOkxLive(tiingoOkx),
  };
  const klines = new KlineService(db, provider, cfg.klineMemoryTtlMs);
  const repo = new AnalysisRepo(db);
  repo.failStaleRunning();
  const internalToken = ensureInternalToken(dataDir);
  const serverUrl = `http://127.0.0.1:${cfg.port}`;
  const mcpEnv = { WCA_SERVER_URL: serverUrl, WCA_INTERNAL_TOKEN: internalToken };
  const runners =
    deps.runners ??
    cfg.agentRunners.map((id): AgentRunner =>
      id === 'agy'
        ? new AgyRunner({ agyBin: cfg.agyBin, model: cfg.agyModel, timeoutMs: cfg.agyTimeoutMs, env: mcpEnv, root: ROOT, serverUrl })
        : new ClaudeCodeRunner({ claudeBin: cfg.claudeBin, model: cfg.agentModel, timeoutMs: cfg.agentTimeoutMs, env: mcpEnv }),
    );
  const collectors =
    deps.orderflow === false
      ? []
      : cfg.orderflowBinanceSymbols.map(
          symbol =>
            new BookCollector({
              symbol,
              sourceSymbol: cfg.orderflowSources[symbol]?.symbol ?? symbol,
              market: cfg.orderflowSources[symbol]?.market ?? 'spot',
              db,
              bucket: cfg.orderflowBuckets[symbol] ?? 10,
              sampleSec: cfg.orderflowSampleSec,
              retainH: cfg.orderflowRetainH,
              resyncMin: cfg.orderflowResyncMinBySymbol[symbol] ?? cfg.orderflowResyncMin,
              bigTradeQty: cfg.orderflowBigTrade[symbol] ?? Number.POSITIVE_INFINITY,
              log: msg => console.log(msg),
            }),
        );
  const binanceOrderflow = collectors.length
    ? new BinanceOrderflow({
        collectors: Object.fromEntries(collectors.map(c => [c.symbol, c])),
        sources: cfg.orderflowSources,
        buckets: cfg.orderflowBuckets,
        absorptionQty: cfg.orderflowAbsorb,
        wallMin: cfg.orderflowWallMin,
        offsets: cfg.orderflowOffsets,
        chartCandles: symbol => klines.getKlines({ symbol, tf: '1m', limit: 1440, closedOnly: true }).then(r => r.candles),
      })
    : undefined;
  for (const c of collectors) c.start();

  const service = new AnalysisService(repo, klines, runners, {
    defaultRunner: cfg.agentRunner,
    instrumentOf: symbol => router.instrument(symbol),
    maxTfs: cfg.agentMaxTfs,
    barsPerTf: cfg.agentBarsPerTf,
    screenshotDir: path.join(dataDir, 'screenshots'),
    minRiskReward: cfg.setupMinRr,
    bookmap: { images: cfg.bookmapImages, offsets: cfg.bookmapOffsets, tolerances: cfg.bookmapTolerances, maxAgeMin: cfg.bookmapMaxAgeMin },
    binanceOrderflow,
  });

  const app: FastifyInstance = Fastify({ logger: deps.logger ?? true, bodyLimit: 15 * 1024 * 1024 });
  await app.register(cors, { origin: [/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/] });

  app.get('/api/health', async () => ({ ok: true, provider: provider.name, defaultRunner: service.defaultRunnerId, busy: service.isBusy() }));
  app.get('/api/runners', async () => ({ defaultRunner: service.defaultRunnerId, runners: await service.runnerInfos() }));
  app.get('/api/config', async () => ({
    defaultSymbol: cfg.defaultSymbol,
    defaultTf: cfg.defaultTf,
    supportedTfs: cfg.supportedTfs,
    defaultContextTfs: cfg.defaultContextTfs,
    setupMinRr: cfg.setupMinRr,
    oandaSymbols: cfg.oandaSymbols,
    oandaConfigured: Boolean(cfg.oandaApiToken),
    xauusdSource: cfg.xauusdSource,
    tiingoConfigured: Boolean(cfg.tiingoApiToken),
    agentMaxTfs: cfg.agentMaxTfs,
    bookmap: {
      symbols: service.bookmapSymbols,
      offsets: Object.fromEntries(service.bookmapSymbols.map(s => [s, cfg.bookmapOffsets[s] ?? 0])),
    } satisfies BookmapUiConfig,
    orderflow: { binanceSymbols: service.orderflowSymbols },
  }));
  registerKlineRoutes(app, klines, router, lives);
  registerAnalysisRoutes(app, service, repo, internalToken);

  app.addHook('onClose', async () => {
    for (const c of collectors) c.stop();
    db.close();
  });
  return { app, klines, db, service, repo, internalToken };
}
