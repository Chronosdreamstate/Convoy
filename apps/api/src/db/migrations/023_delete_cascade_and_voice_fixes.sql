-- Migration 023: FK ON DELETE fixes for reachable delete paths + voice message
-- NOT NULL bug fix.
--
-- Context: a prior pass fixed FK-blocks-delete gaps for user deletion
-- (account.routes.ts DELETE /account) and vehicle deletion. This migration
-- fixes three more gaps found by tracing every DELETE endpoint in
-- apps/api/src/*/*.routes.ts against the FKs defined in 001-022:
--
-- 1. ptt_log.channel_id -> ptt_channels(id) had no ON DELETE action.
--    DELETE /groups/:id/channels/:channelId (ptt/ptt.routes.ts) does
--    `DELETE FROM ptt_channels WHERE id = $1` with no cleanup of ptt_log
--    rows. Any channel that was ever used for at least one PTT transmission
--    (i.e. has ptt_log rows) fails that delete with:
--      "update or delete on table ptt_channels violates foreign key
--       constraint ptt_log_channel_id_fkey" (reproduced against the live DB).
--    ptt_log.channel_id is already nullable and application code already
--    guards `if (log.channel_id)` (socket/socket.handler.ts), so SET NULL is
--    safe -- the historical transmission log entry survives, just loses its
--    channel attribution once the channel itself is gone.
--
-- 2. group_photos.user_id -> users(id) had no ON DELETE action.
--    DELETE /account (account.routes.ts) hard-deletes a user's data but never
--    touches group_photos, so deleting a user who has ever posted a group
--    photo fails with a FK violation (reproduced against the live DB).
--    group_messages.user_id (011_group_chat.sql) already cascades on user
--    delete for the same "hard-delete all user content" reasoning (Req 36.3)
--    -- group_photos should behave the same way.
--
-- 3. group_events.created_by -> users(id) had no ON DELETE action, and the
--    column is NOT NULL. DELETE /account never touches group_events either,
--    so deleting a user who ever created a group event also fails with a FK
--    violation (reproduced against the live DB). Unlike group_photos (solely
--    the poster's content) an event belongs to the whole group and has other
--    members' event_rsvps cascading from it (006_event_rsvps.sql) -- cascading
--    the delete would destroy other members' RSVPs too. SET NULL instead
--    (matching the existing convoy_groups.leader_id / speed_cameras.reporter_id
--    pattern), which requires dropping the NOT NULL constraint first.
--
-- 4. group_messages.text was NOT NULL, but voice messages (013_voice_messages.sql)
--    are sent with `text: undefined` and rely on audio_url instead
--    (groups/chat.routes.ts sendMessageSchema .refine() requires audioUrl,
--    not text, when type = 'voice'). INSERT ... VALUES ($1,$2,text ?? null,...)
--    therefore inserts NULL into a NOT NULL column for every voice message,
--    reproduced against the live DB as:
--      "null value in column "text" of relation "group_messages" violates
--       not-null constraint"
--    -- i.e. POST /groups/:id/messages with type: 'voice' has always 500'd.
--    Fix: make text nullable and add a CHECK tying required content to type,
--    replacing the now-redundant length-only text CHECK from 011_group_chat.sql.

-- ---------------------------------------------------------------------------
-- 1. ptt_log.channel_id: NO ACTION -> SET NULL
-- ---------------------------------------------------------------------------
ALTER TABLE ptt_log DROP CONSTRAINT IF EXISTS ptt_log_channel_id_fkey;
ALTER TABLE ptt_log
  ADD CONSTRAINT ptt_log_channel_id_fkey
  FOREIGN KEY (channel_id) REFERENCES ptt_channels(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. group_photos.user_id: NO ACTION -> CASCADE
-- ---------------------------------------------------------------------------
ALTER TABLE group_photos DROP CONSTRAINT IF EXISTS group_photos_user_id_fkey;
ALTER TABLE group_photos
  ADD CONSTRAINT group_photos_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. group_events.created_by: NOT NULL + NO ACTION -> nullable + SET NULL
-- ---------------------------------------------------------------------------
ALTER TABLE group_events ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE group_events DROP CONSTRAINT IF EXISTS group_events_created_by_fkey;
ALTER TABLE group_events
  ADD CONSTRAINT group_events_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 4. group_messages.text: NOT NULL -> nullable, with a type-aware CHECK
-- ---------------------------------------------------------------------------
ALTER TABLE group_messages ALTER COLUMN text DROP NOT NULL;

ALTER TABLE group_messages DROP CONSTRAINT IF EXISTS group_messages_text_check;
ALTER TABLE group_messages
  ADD CONSTRAINT group_messages_text_check
  CHECK (text IS NULL OR char_length(text) BETWEEN 1 AND 500);

ALTER TABLE group_messages
  ADD CONSTRAINT group_messages_content_by_type_check
  CHECK (
    (type = 'text'  AND text IS NOT NULL) OR
    (type = 'voice' AND audio_url IS NOT NULL)
  );
