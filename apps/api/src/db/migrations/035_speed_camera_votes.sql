-- One vote per user per speed camera.
--
-- POST /speed-cameras/:id/vote incremented upvotes/downvotes with no record of
-- who voted, and five downvotes deactivate a camera for everyone — so a single
-- user could delete community map data with five taps, and a vote replayed
-- from the offline queue counted twice. hazard_votes has enforced exactly this
-- since the initial schema; this brings cameras in line.
--
-- Existing upvotes/downvotes counts stay as they are: there is no record of
-- who cast them, so they cannot be backfilled. Users who voted before this
-- migration can vote once more, after which the constraint holds.

CREATE TABLE IF NOT EXISTS speed_camera_votes (
  camera_id UUID NOT NULL REFERENCES speed_cameras(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote      TEXT NOT NULL CHECK (vote IN ('confirm', 'deny')),
  voted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (camera_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_speed_camera_votes_user_id ON speed_camera_votes (user_id);
