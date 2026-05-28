ALTER TABLE "routines" ADD COLUMN "execution_label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
