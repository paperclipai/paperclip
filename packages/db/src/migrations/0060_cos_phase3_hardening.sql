-- Phase 3 hardening: unique constraint on user participants.
-- The existing unique (room_id, agent_id) index treats NULL as distinct
-- in Postgres, so two rows with agent_id=NULL and the same user_id are
-- allowed. Add a partial unique index for user-only participants.
CREATE UNIQUE INDEX "room_participants_room_user_uniq"
  ON "room_participants" ("room_id", "user_id")
  WHERE "agent_id" IS NULL AND "user_id" IS NOT NULL;
