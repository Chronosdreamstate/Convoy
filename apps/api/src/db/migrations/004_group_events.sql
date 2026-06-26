-- group_events: scheduled convoy events with RSVP countdown support

CREATE TABLE IF NOT EXISTS group_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID        NOT NULL REFERENCES convoy_groups(id) ON DELETE CASCADE,
  created_by    UUID        NOT NULL REFERENCES users(id),
  title         VARCHAR(100) NOT NULL,
  description   TEXT,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'upcoming'
                  CHECK (status IN ('upcoming', 'active', 'cancelled', 'completed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_group_events_group_upcoming
  ON group_events (group_id, scheduled_for)
  WHERE status = 'upcoming';
