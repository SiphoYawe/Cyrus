-- Stat arb positions table for pair trade P&L tracking
CREATE TABLE IF NOT EXISTS stat_arb_positions (
  position_id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL,
  long_symbol TEXT NOT NULL,
  short_symbol TEXT NOT NULL,
  long_size REAL NOT NULL,
  short_size REAL NOT NULL,
  long_entry_price REAL NOT NULL,
  short_entry_price REAL NOT NULL,
  long_exit_price REAL,
  short_exit_price REAL,
  leverage INTEGER NOT NULL,
  hedge_ratio REAL NOT NULL,
  entry_z_score REAL,
  exit_z_score REAL,
  entry_timestamp INTEGER NOT NULL,
  exit_timestamp INTEGER,
  long_realized_pnl REAL,
  short_realized_pnl REAL,
  cumulative_funding REAL DEFAULT 0,
  total_fees REAL DEFAULT 0,
  net_pnl REAL,
  return_percent REAL,
  exit_reason TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  direction TEXT NOT NULL,
  signal_source TEXT,
  margin_used REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stat_arb_pair_id ON stat_arb_positions(pair_id);
CREATE INDEX IF NOT EXISTS idx_stat_arb_status ON stat_arb_positions(status);
CREATE INDEX IF NOT EXISTS idx_stat_arb_exit_reason ON stat_arb_positions(exit_reason);
