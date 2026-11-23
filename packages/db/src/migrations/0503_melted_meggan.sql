CREATE TABLE "google_pending_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid,
	"grant_id" uuid,
	"source_secret_id" uuid,
	"subject" text NOT NULL,
	"profile" text NOT NULL,
	"token_material" jsonb NOT NULL,
	"token_sha256" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_outcome" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"give_up_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "google_pending_revocations_due_idx" ON "google_pending_revocations" USING btree ("next_attempt_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "google_pending_revocations_token_idx" ON "google_pending_revocations" USING btree ("company_id","token_sha256");