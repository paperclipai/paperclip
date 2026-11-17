CREATE TABLE "company_secret_deployment_assertions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"expected_latest_version" integer NOT NULL,
	"value_fingerprint_sha256" text NOT NULL,
	"previous_value_fingerprint_sha256" text NOT NULL,
	"asserted_by_agent_id" uuid,
	"origin_run_id" uuid,
	"origin_issue_id" uuid,
	"deployment_label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_secret_deployment_assertions_status_check" CHECK ("company_secret_deployment_assertions"."status" in ('pending', 'verified', 'consumed', 'expired')),
	CONSTRAINT "company_secret_deployment_assertions_fingerprint_check" CHECK ("company_secret_deployment_assertions"."value_fingerprint_sha256" <> "company_secret_deployment_assertions"."previous_value_fingerprint_sha256")
);
--> statement-breakpoint
ALTER TABLE "company_secret_deployment_assertions" ADD CONSTRAINT "company_secret_deployment_assertions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_deployment_assertions" ADD CONSTRAINT "company_secret_deployment_assertions_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_deployment_assertions" ADD CONSTRAINT "company_secret_deployment_assertions_asserted_by_agent_id_agents_id_fk" FOREIGN KEY ("asserted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_deployment_assertions" ADD CONSTRAINT "company_secret_deployment_assertions_origin_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secret_deployment_assertions" ADD CONSTRAINT "company_secret_deployment_assertions_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_secret_deployment_assertions_secret_status_idx" ON "company_secret_deployment_assertions" USING btree ("secret_id","status");--> statement-breakpoint
CREATE INDEX "company_secret_deployment_assertions_expiry_idx" ON "company_secret_deployment_assertions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "company_secret_deployment_assertions_company_idx" ON "company_secret_deployment_assertions" USING btree ("company_id");