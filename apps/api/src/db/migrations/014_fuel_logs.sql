CREATE TABLE IF NOT EXISTS fuel_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TIMESTAMPTZ NOT NULL,
  gallons     NUMERIC(8,3) NOT NULL CHECK (gallons > 0),
  price_per_gallon NUMERIC(8,3) NOT NULL CHECK (price_per_gallon > 0),
  notes       TEXT,
  location    TEXT,
  mpg         NUMERIC(8,2),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fuel_logs_user ON fuel_logs(user_id, date DESC);
