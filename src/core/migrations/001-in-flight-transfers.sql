CREATE TABLE IF NOT EXISTS in_flight_transfers (
  id TEXT PRIMARY KEY,
  tx_hash TEXT,
  bridge TEXT NOT NULL,
  from_chain INTEGER NOT NULL,
  to_chain INTEGER NOT NULL,
  from_token TEXT NOT NULL,
  to_token TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  quote_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
