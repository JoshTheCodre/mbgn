import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'supporter' CHECK (role IN ('supporter','contestant','admin')),
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  frozen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS contestants (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  full_name TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  state TEXT NOT NULL,
  location TEXT NOT NULL,
  bio TEXT NOT NULL,
  photo_file TEXT,
  tiktok TEXT,
  instagram TEXT,
  facebook TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','suspended','disqualified')),
  status_reason TEXT,
  code TEXT UNIQUE,
  code_seq INTEGER UNIQUE,
  total_votes INTEGER NOT NULL DEFAULT 0 CHECK (total_votes >= 0),
  position INTEGER,
  previous_position INTEGER,
  last_vote_at TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contestants_status ON contestants(status, total_votes DESC);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  votes INTEGER NOT NULL CHECK (votes > 0),
  price INTEGER NOT NULL CHECK (price > 0),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  -- Empty for someone who paid directly without a wallet.
  user_id INTEGER REFERENCES users(id),
  email TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'wallet' CHECK (mode IN ('wallet','direct')),
  -- What the payment should vote for once confirmed. Empty for a plain wallet top-up.
  vote_contestant_id INTEGER REFERENCES contestants(id),
  vote_quantity INTEGER,
  votes_status TEXT CHECK (votes_status IN ('counted','kept','held')),
  via_link INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT,
  credits INTEGER NOT NULL CHECK (credits > 0),
  amount INTEGER NOT NULL CHECK (amount > 0),
  provider TEXT NOT NULL,
  provider_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','review')),
  paid_amount REAL,
  payment_method TEXT,
  return_to TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id),
  supporter_email TEXT NOT NULL,
  payment_id INTEGER UNIQUE REFERENCES payments(id),
  contestant_id INTEGER NOT NULL REFERENCES contestants(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','void')),
  idempotency_key TEXT,
  via_link INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT,
  created_at TEXT NOT NULL,
  voided_at TEXT,
  void_reason TEXT,
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','vote','refund')),
  payment_id INTEGER REFERENCES payments(id),
  vote_id INTEGER REFERENCES votes(id),
  created_at TEXT NOT NULL
);
-- The database itself refuses a second credit for the same payment.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_credit_per_payment
  ON wallet_ledger(payment_id) WHERE kind = 'purchase';
CREATE INDEX IF NOT EXISTS votes_contestant ON votes(contestant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS votes_user ON votes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS votes_email ON votes(supporter_email, created_at DESC);

CREATE TABLE IF NOT EXISTS rank_snapshots (
  taken_at TEXT NOT NULL,
  contestant_id INTEGER NOT NULL REFERENCES contestants(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (taken_at, contestant_id)
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  contestant_id INTEGER REFERENCES contestants(id),
  message TEXT NOT NULL,
  amount INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id DESC);

CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  details TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  contestant_id INTEGER REFERENCES contestants(id),
  payment_id INTEGER REFERENCES payments(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_visits (
  contestant_id INTEGER NOT NULL REFERENCES contestants(id),
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (contestant_id, day, source)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY,
  competition TEXT NOT NULL,
  published_at TEXT NOT NULL,
  standings TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS simulated_provider (
  reference TEXT PRIMARY KEY,
  amount INTEGER NOT NULL,
  paid_at TEXT
);
`;

const DEFAULT_SETTINGS = {
  competition_name: 'Most Beautiful Girl Online Nigeria',
  vote_price: '500',
  voting_status: 'open',
  voting_starts_at: '',
  voting_ends_at: '',
  results_published_at: '',
  next_code_seq: '1',
  large_vote_threshold: '1000',
};

const DEFAULT_PACKAGES = [[1, 500], [5, 2500], [10, 5000], [20, 10000], [50, 25000], [100, 50000]];

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const putSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) putSetting.run(key, value);

  if (db.prepare('SELECT COUNT(*) AS n FROM packages').get().n === 0) {
    const putPackage = db.prepare('INSERT INTO packages (votes, price) VALUES (?, ?)');
    for (const [votes, price] of DEFAULT_PACKAGES) putPackage.run(votes, price);
  }
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
