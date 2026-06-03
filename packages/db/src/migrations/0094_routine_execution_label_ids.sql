ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "execution_label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
