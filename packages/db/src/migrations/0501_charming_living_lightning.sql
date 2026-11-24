CREATE TABLE "issue_connection_content_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_actor_type" text NOT NULL,
	"requested_by_actor_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_object_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"log_store" text,
	"object_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_connection_content_deletions" ADD CONSTRAINT "issue_connection_content_deletions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_connection_content_deletions_issue_idx" ON "issue_connection_content_deletions" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_connection_content_deletions_pending_idx" ON "issue_connection_content_deletions" USING btree ("not_before") WHERE "issue_connection_content_deletions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "stored_object_deletions_due_idx" ON "stored_object_deletions" USING btree ("not_before","id");--> statement-breakpoint
CREATE INDEX "stored_object_deletions_company_idx" ON "stored_object_deletions" USING btree ("company_id");