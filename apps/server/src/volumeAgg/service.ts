import { VOLUME_VENUE_LABELS, VOLUME_VENUES, type Timeframe, type VolumeAggResponse, type VolumeVenue } from '@wca/shared';
import type { Db } from '../db/index.ts';
import { closedBarTimes, findSpikes, mergeBars } from './calc.ts';
import type { VenueSymbols, VolumeFetcher } from './sources.ts';

// Volume gộp: cache SQLite theo (symbol, sàn, khung, thời gian) — mỗi nến đã đóng chỉ tải một lần.

import { VOLAGG_MAX_BARS } from '@wca/shared';
export { VOLAGG_MAX_BARS };
/** Sàn lỗi / thiếu nến: không thử lại trong khoảng này (giây). */
const RETRY_SEC = 120;

export interface VolumeAggOptions {
  db: Db;
  symbols: Record<string, VenueSymbols>;
  spikeX: number;
  fetcher: VolumeFetcher;
  now?: () => number;
  log?: (msg: string) => void;
}

export class VolumeAggService {
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<VolumeAggResponse>>();
  /** Lần thử gần nhất theo `${symbol}:${venue}:${tf}` (tránh gọi lại liên tục khi sàn thiếu nến / lỗi). */
  private readonly attempts = new Map<string, { at: number; from: number; to: number; error?: string }>();

  constructor(private readonly opts: VolumeAggOptions) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get symbols(): string[] {
    return Object.keys(this.opts.symbols);
  }

  has(symbol: string): boolean {
    return symbol in this.opts.symbols;
  }

  get(symbol: string, tf: Timeframe, limit: number): Promise<VolumeAggResponse> {
    const n = Math.min(Math.max(Math.floor(limit) || 0, 1), VOLAGG_MAX_BARS);
    const key = `${symbol}:${tf}:${n}`;
    const hit = this.inflight.get(key);
    if (hit) return hit;
    const p = this.compute(symbol, tf, n).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private stored(symbol: string, venue: VolumeVenue, tf: Timeframe, from: number, to: number): Map<number, number> {
    const rows = this.opts.db
      .prepare('SELECT t, volume FROM venue_volume WHERE symbol = ? AND venue = ? AND tf = ? AND t >= ? AND t <= ?')
      .all(symbol, venue, tf, from, to) as { t: number; volume: number }[];
    return new Map(rows.map(r => [r.t, r.volume]));
  }

  private async venueVolumes(symbol: string, venue: VolumeVenue, tf: Timeframe, times: readonly number[]): Promise<{ map: Map<number, number>; error?: string }> {
    const from = times[0]!;
    const to = times.at(-1)!;
    const have = this.stored(symbol, venue, tf, from, to);
    const akey = `${symbol}:${venue}:${tf}`;
    const last = this.attempts.get(akey);
    // Nến đã yêu cầu ở lần thử gần đây mà sàn không có / lỗi → chưa thử lại (RETRY_SEC); nến mới hơn luôn tải.
    const recent = last && this.now() - last.at < RETRY_SEC;
    const missing = times.filter(t => !have.has(t) && !(recent && t >= last.from && t <= last.to));
    if (!missing.length) return { map: have, error: recent ? last.error : undefined };
    try {
      const fresh = await this.opts.fetcher(venue, this.opts.symbols[symbol]!, tf, missing[0]!, missing.at(-1)!);
      const insert = this.opts.db.prepare('INSERT OR REPLACE INTO venue_volume (symbol, venue, tf, t, volume) VALUES (?, ?, ?, ?, ?)');
      this.opts.db.transaction(() => {
        for (const [t, v] of fresh) insert.run(symbol, venue, tf, t, v);
      })();
      for (const [t, v] of fresh) have.set(t, v);
      this.attempts.set(akey, { at: this.now(), from: missing[0]!, to: missing.at(-1)! });
      return { map: have };
    } catch (err) {
      const error = (err as Error).message;
      this.attempts.set(akey, { at: this.now(), from: missing[0]!, to: missing.at(-1)!, error });
      this.opts.log?.(`[volume-agg] ${symbol} ${venue} ${tf}: ${error}`);
      return { map: have, error };
    }
  }

  private async compute(symbol: string, tf: Timeframe, limit: number): Promise<VolumeAggResponse> {
    if (!this.has(symbol)) throw new Error(`Chưa bật volume gộp cho ${symbol}`);
    const times = closedBarTimes(this.now(), tf, limit);
    const results = await Promise.all(VOLUME_VENUES.map(v => this.venueVolumes(symbol, v, tf, times)));
    const byVenue = Object.fromEntries(VOLUME_VENUES.map((v, i) => [v, results[i]!.map])) as Record<VolumeVenue, Map<number, number>>;
    const bars = mergeBars(times, byVenue);
    const notes: string[] = [];
    VOLUME_VENUES.forEach((v, i) => {
      const err = results[i]!.error;
      if (err) notes.push(`${VOLUME_VENUE_LABELS[v]}: lỗi tải (${err})`);
      else {
        const miss = bars.filter(b => b.venues[v] === null).length;
        if (miss) notes.push(`${VOLUME_VENUE_LABELS[v]}: thiếu ${miss}/${bars.length} nến`);
      }
    });
    return { symbol, tf, bars, spikes: findSpikes(bars, { x: this.opts.spikeX }), spikeX: this.opts.spikeX, notes };
  }
}
