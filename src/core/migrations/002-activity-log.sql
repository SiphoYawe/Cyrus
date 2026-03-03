CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  from_token TEXT NOT NULL,
  to_token TEXT NOT NULL,
  from_amount TEXT NOT NULL,
  to_amount TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  decision_report_id TEXT,
  action_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
