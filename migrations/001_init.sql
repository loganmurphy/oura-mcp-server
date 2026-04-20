-- Oura data cache
-- Keyed by (metric, date_key) where date_key is YYYY-MM-DD for date-based tools
-- or '__singleton__' for personal_info.
--
-- TTL is enforced in application code:
--   today     → 1 hour  (data still updating)
--   yesterday → 6 hours (Oura may retroactively adjust)
--   older     → 24 hours (stable)
--   singleton → 24 hours

CREATE TABLE IF NOT EXISTS oura_cache (
  metric     TEXT    NOT NULL,
  date_key   TEXT    NOT NULL,
  data       TEXT    NOT NULL,  -- JSON-stringified item(s) for that day
  fetched_at INTEGER NOT NULL,  -- Unix ms
  PRIMARY KEY (metric, date_key)
);
