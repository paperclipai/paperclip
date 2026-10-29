DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queues_id_company_uq' AND conrelid = 'public.decision_queues'::regclass) THEN
		ALTER TABLE "decision_queue_items" DROP CONSTRAINT IF EXISTS "decision_queue_items_queue_company_fk";
		DROP INDEX IF EXISTS "decision_queues_id_company_uq";
		ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_id_company_uq" UNIQUE("id","company_id");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_queue_items_queue_company_fk' AND conrelid = 'public.decision_queue_items'::regclass) THEN
		ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_queue_company_fk" FOREIGN KEY ("queue_id","company_id") REFERENCES "public"."decision_queues"("id","company_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
