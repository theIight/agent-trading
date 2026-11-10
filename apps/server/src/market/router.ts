import { describeInstrument, type Candle, type InstrumentInfo, type MarketSource } from '@wca/shared';
import type { FetchKlinesParams, MarketDataProvider } from './provider.ts';

export interface RouterOptions {
  binance: MarketDataProvider;
  oanda?: MarketDataProvider | null;
  tiingoOkx?: MarketDataProvider | null;
  /** Symbol đi OANDA (khi có provider). */
  oandaSymbols?: readonly string[];
  /** Symbol đi Tiingo + OKX (khi có provider). */
  tiingoOkxSymbols?: readonly string[];
  oandaPrice?: 'M' | 'B' | 'A';
}

/** Định tuyến symbol → provider. Ưu tiên Tiingo+OKX, rồi OANDA, còn lại Binance. */
export class RoutingProvider implements MarketDataProvider {
  readonly name = 'router';
  /** Giới hạn chung (Binance 1500) để KlineService clamp nhất quán. */
  readonly maxLimit = 1500;
  private readonly oandaSet: Set<string>;
  private readonly tiingoSet: Set<string>;

  constructor(private readonly opts: RouterOptions) {
    this.oandaSet = new Set(opts.oanda ? (opts.oandaSymbols ?? []) : []);
    this.tiingoSet = new Set(opts.tiingoOkx ? (opts.tiingoOkxSymbols ?? []) : []);
  }

  sourceOf(symbol: string): MarketSource {
    if (this.tiingoSet.has(symbol)) return 'tiingo-okx';
    if (this.oandaSet.has(symbol)) return 'oanda';
    return 'binance-futures';
  }

  instrument(symbol: string): InstrumentInfo {
    return describeInstrument(symbol, this.sourceOf(symbol), this.opts.oandaPrice ?? 'M');
  }

  fetchKlines(params: FetchKlinesParams): Promise<Candle[]> {
    const src = this.sourceOf(params.symbol);
    if (src === 'tiingo-okx') return this.opts.tiingoOkx!.fetchKlines(params);
    if (src === 'oanda') return this.opts.oanda!.fetchKlines(params);
    return this.opts.binance.fetchKlines(params);
  }
}
