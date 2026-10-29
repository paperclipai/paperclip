ALTER TABLE "routines" ADD COLUMN "activity_gate_policy" text DEFAULT 'always' NOT NULL;
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "activity_gate_scope" text DEFAULT 'company' NOT NULL;
