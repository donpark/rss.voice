CREATE TABLE IF NOT EXISTS rate_limits (
  tenant_id TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  window_started INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, rate_key)
);
