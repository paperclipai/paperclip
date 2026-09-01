CREATE TABLE "formal_qa_scheduler_states" (
	"company_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"cursor" integer DEFAULT 1 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"next_eligible_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formal_qa_scheduler_states_stage_subject_id_pk" PRIMARY KEY("stage","subject_id")
);
--> statement-breakpoint
DROP INDEX "formal_qa_issuances_semantic_uq";--> statement-breakpoint
ALTER TABLE "formal_qa_preparations" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "formal_qa_preparations" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "formal_qa_preparations" ADD COLUMN "predecessor_preparation_id" uuid;--> statement-breakpoint
UPDATE "formal_qa_preparations"
SET "request_key" = "idempotency_key", "updated_at" = clock_timestamp()
WHERE "request_key" IS NULL;--> statement-breakpoint
ALTER TABLE "formal_qa_preparations" ALTER COLUMN "request_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "formal_qa_scheduler_states" ADD CONSTRAINT "formal_qa_scheduler_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "formal_qa_scheduler_states_stage_due_idx" ON "formal_qa_scheduler_states" USING btree ("stage","next_eligible_at","subject_id");--> statement-breakpoint
CREATE INDEX "formal_qa_scheduler_states_company_idx" ON "formal_qa_scheduler_states" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "formal_qa_preparations" ADD CONSTRAINT "formal_qa_preparations_predecessor_preparation_id_formal_qa_preparations_id_fk" FOREIGN KEY ("predecessor_preparation_id") REFERENCES "public"."formal_qa_preparations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_preparations_company_request_generation_uq" ON "formal_qa_preparations" USING btree ("company_id","request_key","generation");
--> statement-breakpoint
CREATE UNIQUE INDEX "formal_qa_preparations_company_request_live_uq" ON "formal_qa_preparations" USING btree ("company_id","request_key") WHERE "status" in ('prepared', 'issuing', 'issued');--> statement-breakpoint
CREATE OR REPLACE FUNCTION formal_qa_preparation_generation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.request_key = '' OR NEW.generation < 1
      OR (NEW.generation = 1 AND NEW.predecessor_preparation_id IS NOT NULL)
      OR (NEW.generation > 1 AND NOT EXISTS (
        SELECT 1 FROM formal_qa_preparations predecessor
        WHERE predecessor.id = NEW.predecessor_preparation_id
          AND predecessor.company_id = NEW.company_id
          AND predecessor.request_key = NEW.request_key
          AND predecessor.generation = NEW.generation - 1
          AND predecessor.status = 'expired'
      )) THEN
      RAISE EXCEPTION 'formal_qa_preparation_generation_invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.request_key IS DISTINCT FROM OLD.request_key
    OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.predecessor_preparation_id IS DISTINCT FROM OLD.predecessor_preparation_id
  ) THEN
    RAISE EXCEPTION 'formal_qa_preparation_generation_immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER formal_qa_preparation_generation_guard_trigger
BEFORE INSERT OR UPDATE ON formal_qa_preparations
FOR EACH ROW EXECUTE FUNCTION formal_qa_preparation_generation_guard();
