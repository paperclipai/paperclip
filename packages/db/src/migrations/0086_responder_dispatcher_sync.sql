-- Responder → Dispatcher Live Status Sync: eta + location in status payload (IUN-2981)

ALTER TABLE "responder_status_updates"
  ADD COLUMN IF NOT EXISTS "eta"  text,
  ADD COLUMN IF NOT EXISTS "lat"  double precision,
  ADD COLUMN IF NOT EXISTS "lng"  double precision;
