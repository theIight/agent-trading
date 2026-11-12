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
  return db;
}

function addColumnIfMissing(db: Db, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
