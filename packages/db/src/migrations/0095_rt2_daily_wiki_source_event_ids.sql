ALTER TABLE "rt2_v33_daily_wiki_pages" ADD COLUMN IF NOT EXISTS "source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
