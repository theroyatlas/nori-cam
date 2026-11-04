-- Nori site (D1). Stores NO visitor content and NO plain IPs: only salted-hash rate counters, a spend total and a result cache.

-- one random salt per UTC day; the salt of an old day is useless once the day has rolled over
CREATE TABLE IF NOT EXISTS daily_salt (
  day  TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);

-- model calls per hashed IP in 10-minute buckets (bucket = floor(epoch_ms / 600000))
CREATE TABLE IF NOT EXISTS rate_hits (
  ip_hash TEXT NOT NULL,
  bucket  INTEGER NOT NULL,
  n       INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, bucket)
);

-- spend per UTC day in micro-USD (integer, 1e-6 USD) at the official prices, from the real usage of each reply
CREATE TABLE IF NOT EXISTS usage_daily (
  day       TEXT PRIMARY KEY,
  micro_usd INTEGER NOT NULL DEFAULT 0,
  calls     INTEGER NOT NULL DEFAULT 0
);

-- 24 h result cache: key = sha256(view + sorted options + sorted edits); body = view result without the option ids
CREATE TABLE IF NOT EXISTS decide_cache (
  key        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
