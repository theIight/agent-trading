import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS klines (
     symbol TEXT NOT NULL,
     tf TEXT NOT NULL,
     open_time INTEGER NOT NULL,
     open REAL NOT NULL,
     high REAL NOT NULL,
     low REAL NOT NULL,
     close REAL NOT NULL,
     volume REAL NOT NULL,
     PRIMARY KEY (symbol, tf, open_time)
   ) WITHOUT ROWID;`,
  `CREATE TABLE IF NOT EXISTS analyses (
     id TEXT PRIMARY KEY,
     symbol TEXT NOT NULL,
     primary_tf TEXT NOT NULL,
     tfs TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     finished_at INTEGER,
     result TEXT,
     error TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS idx_analyses_symbol ON analyses(symbol, created_at DESC);`,
  // Order flow Binance: mẫu sổ lệnh gom theo bucket (JSON) + lệnh khớp lớn.
  `CREATE TABLE IF NOT EXISTS book_samples (
     symbol TEXT NOT NULL,
     t INTEGER NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (symbol, t)
   ) WITHOUT ROWID;`,
  `CREATE TABLE IF NOT EXISTS big_trades (
     symbol TEXT NOT NULL,
     t INTEGER NOT NULL,
     price REAL NOT NULL,
     qty REAL NOT NULL,
     side TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_big_trades ON big_trades(symbol, t);`,
  // Thanh lý thật (đã gộp theo giây/sàn/phía) + open interest 5 phút cho heatmap thanh lý ước tính.
  `CREATE TABLE IF NOT EXISTS liquidations (
     symbol TEXT NOT NULL,
     venue TEXT NOT NULL,
     t INTEGER NOT NULL,
     side TEXT NOT NULL,
     price REAL NOT NULL,
     qty REAL NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_liquidations ON liquidations(symbol, t);`,
  `CREATE TABLE IF NOT EXISTS open_interest (
     symbol TEXT NOT NULL,
     t INTEGER NOT NULL,
     oi REAL NOT NULL,
     PRIMARY KEY (symbol, t)
   ) WITHOUT ROWID;`,
  // Volume nến đã đóng từng sàn (volume gộp).
  `CREATE TABLE IF NOT EXISTS venue_volume (
     symbol TEXT NOT NULL,
     venue TEXT NOT NULL,
     tf TEXT NOT NULL,
     t INTEGER NOT NULL,
     volume REAL NOT NULL,
     PRIMARY KEY (symbol, venue, tf, t)
   ) WITHOUT ROWID;`,
  // Alert chạm vùng entry của setup (crypto). Thời gian: unix giây.
  `CREATE TABLE IF NOT EXISTS price_alerts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     analysis_id TEXT NOT NULL,
     symbol TEXT NOT NULL,
     setup_index INTEGER NOT NULL,
     direction TEXT NOT NULL,
     entry_type TEXT NOT NULL,
     tf TEXT NOT NULL,
     entry_low REAL NOT NULL,
     entry_high REAL NOT NULL,
     stop_loss REAL NOT NULL,
     take_profits TEXT NOT NULL,
     risk_reward REAL,
     valid_until INTEGER NOT NULL,
     armed_at INTEGER NOT NULL,
     checked_until INTEGER,
     status TEXT NOT NULL,
     status_at INTEGER NOT NULL,
     trigger_price REAL,
     note TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS idx_price_alerts_status ON price_alerts(status, symbol);`,
  `CREATE INDEX IF NOT EXISTS idx_price_alerts_analysis ON price_alerts(analysis_id);`,
  // Tin Telegram đã gửi cho phân tích (album kết quả) để alert trả lời vào. thread_id: NULL = topic mặc định, 0 = không topic.
  `CREATE TABLE IF NOT EXISTS telegram_messages (
     analysis_id TEXT NOT NULL,
     chat_id TEXT NOT NULL,
     thread_id INTEGER,
     message_id INTEGER NOT NULL,
     sent_at INTEGER NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_messages ON telegram_messages(analysis_id, sent_at);`,
];

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  for (const sql of MIGRATIONS) db.exec(sql);
  addColumnIfMissing(db, 'analyses', 'runner', 'TEXT');
  addColumnIfMissing(db, 'analyses', 'model', 'TEXT');
  addColumnIfMissing(db, 'analyses', 'bookmap', 'INTEGER');
  addColumnIfMissing(db, 'analyses', 'orderflow_source', 'TEXT');
  addColumnIfMissing(db, 'price_alerts', 'arm_price', 'REAL');
  return db;
}

function addColumnIfMissing(db: Db, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
