ALTER TABLE crewbrief_waitlist_entries
ADD COLUMN IF NOT EXISTS last_active_date timestamp with time zone;

CREATE INDEX IF NOT EXISTS cb_waitlist_last_active_idx
ON crewbrief_waitlist_entries (last_active_date);
