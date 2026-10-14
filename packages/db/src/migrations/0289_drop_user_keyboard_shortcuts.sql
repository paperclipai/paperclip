-- Drop the per-user keyboard shortcut preference. Keyboard shortcuts are now
-- always enabled for every signed-in user, so the column lost its last reader
-- when the Profile settings toggle and the /api/auth/preferences routes were
-- removed.
ALTER TABLE "user" DROP COLUMN IF EXISTS "keyboard_shortcuts";
