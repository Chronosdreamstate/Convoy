-- Analytics events: anonymous, append-only, never store PII
CREATE TABLE IF NOT EXISTS analytics_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anonymous_id TEXT        NOT NULL,
  user_id      UUID        REFERENCES users(id) ON DELETE SET NULL,
  platform     TEXT        NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  event_name   TEXT        NOT NULL,
  props        JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_event_name ON analytics_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_anon ON analytics_events(anonymous_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics_events(user_id, created_at DESC) WHERE user_id IS NOT NULL;
