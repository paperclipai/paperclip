-- THEA-2270 — Per-routine fire cooldown (defense in depth against runaway webhook fires).
-- NULL = no cooldown (preserves existing behavior for every active routine).
ALTER TABLE "routines" ADD COLUMN "min_fire_interval_sec" integer;
--> statement-breakpoint
COMMENT ON COLUMN "routines"."min_fire_interval_sec" IS 'Minimum seconds between fires (NULL = no cooldown). Server-side defense in depth (THEA-2270).';
