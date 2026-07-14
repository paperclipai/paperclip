CREATE TABLE "delivery_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"declaration_id" text NOT NULL,
	"declaration_revision" integer NOT NULL,
	"target_kind" text NOT NULL,
	"target_fingerprint" text NOT NULL,
	"provider_key" text NOT NULL,
	"outcome" text NOT NULL,
	"delivery_method" text NOT NULL,
	"source_revision" text,
	"delivered_revision" text,
	"destination_ref_fingerprint" text,
	"workspace_dirty" boolean,
	"operation_id" text DEFAULT '' NOT NULL,
	"artifact_ids" jsonb DEFAULT '[]' NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_attestations" ADD CONSTRAINT "delivery_attestations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attestations" ADD CONSTRAINT "delivery_attestations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attestations" ADD CONSTRAINT "delivery_attestations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attestations_dedup_idx" ON "delivery_attestations" USING btree ("run_id","declaration_id","declaration_revision","delivery_method","operation_id");--> statement-breakpoint
CREATE INDEX "delivery_attestations_company_issue_idx" ON "delivery_attestations" USING btree ("company_id","issue_id","generated_at");--> statement-breakpoint
CREATE INDEX "delivery_attestations_run_idx" ON "delivery_attestations" USING btree ("run_id","generated_at");
