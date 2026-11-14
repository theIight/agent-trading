// Gợi ý ngưỡng order flow cho một symbol Binance USDⓈ-M futures từ dữ liệu công khai (không cần key, không ghi DB).
// Dùng: npx tsx scripts/orderflow-calibrate.ts <SYMBOL> [phút aggTrade, mặc định 10]
// Quy tắc (plans/orderflow-top-coins.md):
//   bucket   ≈ 0,02% giá, làm tròn về 1/2/5 × 10ⁿ và ≥ tick size;
//   bigTrade ≈ phân vị 99,5 của tổng lệnh chủ động cùng phía trong 1 giây (aggTrade);
//   absorb   ≈ 8 × bigTrade;
//   wallMin  ≈ phân vị 95 khối lượng mỗi bucket trong ±2% quanh giá (depth 1000 mức).
const REST = 'https://fapi.binance.com';
/** Nghỉ giữa các request REST (aggTrades weight 20) để giữ tốc độ vừa phải. */
const DELAY_MS = 1000;
const MAX_TRADE_PAGES = 40;

const symbol = (process.argv[2] ?? '').toUpperCase();
const windowMin = Number(process.argv[3] ?? 10);
if (!/^[A-Z0-9]+$/.test(symbol)) {
  console.error('Dùng: npx tsx scripts/orderflow-calibrate.ts <SYMBOL> [phút]');
  process.exit(1);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${REST}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Làm tròn về 1/2/5 × 10ⁿ gần nhất (theo thang log). */
function niceStep(x: number): number {
  const e = Math.floor(Math.log10(x));
  const cands = [1, 2, 5, 10].map(m => m * 10 ** e);
  return cands.reduce((best, c) => (Math.abs(Math.log(c / x)) < Math.abs(Math.log(best / x)) ? c : best));
}
/** Làm tròn 2 chữ số có nghĩa. */
const sig2 = (x: number) => (x > 0 ? Number(x.toPrecision(2)) : 0);
/** Bỏ nhiễu dấu phẩy động (0.30000000000000004 → 0.3). */
const clean = (x: number) => Number(x.toPrecision(12));
function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
}

type Filter = { filterType: string; tickSize?: string };
const info = await get<{ symbols: { symbol: string; status: string; filters: Filter[] }[] }>('/fapi/v1/exchangeInfo');
const meta = info.symbols.find(s => s.symbol === symbol);
if (!meta) throw new Error(`${symbol} không có trên Binance futures`);
const tick = Number(meta.filters.find(f => f.filterType === 'PRICE_FILTER')?.tickSize ?? 0);

await sleep(DELAY_MS);
const depth = await get<{ bids: [string, string][]; asks: [string, string][] }>(`/fapi/v1/depth?symbol=${symbol}&limit=1000`);
const bestBid = Number(depth.bids[0]![0]);
const bestAsk = Number(depth.asks[0]![0]);
const mid = (bestBid + bestAsk) / 2;
const bucket = clean(Math.max(tick, niceStep(mid * 0.0002)));

// Gom sổ lệnh theo bucket (giống collector: cận dưới = floor(price / bucket) × bucket), chỉ trong ±2% quanh giá.
const perBucket = new Map<string, number>();
for (const [side, levels] of [['B', depth.bids], ['A', depth.asks]] as const) {
  for (const [p, q] of levels) {
    const price = Number(p);
    if (Math.abs(price - mid) > mid * 0.02) continue;
    const key = `${side}${Math.floor(price / bucket + 1e-9)}`;
    perBucket.set(key, (perBucket.get(key) ?? 0) + Number(q));
  }
}
const bookLow = Number(depth.bids.at(-1)![0]);
const bookHigh = Number(depth.asks.at(-1)![0]);
const wallMin = sig2(quantile([...perBucket.values()], 0.95));

// aggTrades: lấy trang mới nhất rồi lùi theo fromId tới khi phủ đủ cửa sổ.
type Agg = { a: number; p: string; q: string; T: number; m: boolean };
const until = Date.now() - windowMin * 60_000;
let trades: Agg[] = [];
await sleep(DELAY_MS);
let page = await get<Agg[]>(`/fapi/v1/aggTrades?symbol=${symbol}&limit=1000`);
trades = page;
for (let i = 1; i < MAX_TRADE_PAGES && page.length && page[0]!.T > until; i++) {
  await sleep(DELAY_MS);
  const fromId = Math.max(0, page[0]!.a - 1000);
  page = (await get<Agg[]>(`/fapi/v1/aggTrades?symbol=${symbol}&fromId=${fromId}&limit=1000`)).filter(t => t.a < trades[0]!.a);
  trades = [...page, ...trades];
}
trades = trades.filter(t => t.T >= until);
const coveredMin = trades.length ? (trades.at(-1)!.T - trades[0]!.T) / 60_000 : 0;

// Tổng lệnh chủ động cùng phía mỗi giây (m=true → bên mua là maker → chủ động bán).
const perSec = new Map<string, number>();
for (const t of trades) {
  const key = `${Math.floor(t.T / 1000)}${t.m ? 'S' : 'B'}`;
  perSec.set(key, (perSec.get(key) ?? 0) + Number(t.q));
}
const p995 = quantile([...perSec.values()], 0.995);
const bigTrade = sig2(p995);
const absorb = sig2(8 * bigTrade);

console.log(
  JSON.stringify(
    {
      symbol,
      mid: clean(mid),
      tick,
      bucket,
      bigTrade,
      absorb,
      wallMin,
      offset: 0,
      measured: {
        aggTrades: trades.length,
        coveredMin: Math.round(coveredMin * 10) / 10,
        secSideGroups: perSec.size,
        p995SecQty: clean(p995),
        bigTradeUsd: Math.round(bigTrade * mid),
        bookRangePct: [clean(((bookLow - mid) / mid) * 100), clean(((bookHigh - mid) / mid) * 100)].map(x => Math.round(x * 100) / 100),
        wallBuckets: perBucket.size,
        wallMinUsd: Math.round(wallMin * mid),
      },
    },
    null,
    2,
  ),
);
