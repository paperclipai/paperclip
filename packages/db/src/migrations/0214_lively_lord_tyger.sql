CREATE TABLE "adapter_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"started_by_user_id" text NOT NULL,
	"provider_lease_id" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adapter_auth_sessions" ADD CONSTRAINT "adapter_auth_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_auth_sessions" ADD CONSTRAINT "adapter_auth_sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adapter_auth_sessions_company_status_idx" ON "adapter_auth_sessions" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_auth_sessions_company_adapter_active_uq" ON "adapter_auth_sessions" USING btree ("company_id","adapter_type") WHERE "adapter_auth_sessions"."status" IN ('starting', 'waiting_for_user', 'promoting');--> statement-breakpoint
CREATE INDEX "adapter_auth_sessions_environment_idx" ON "adapter_auth_sessions" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "adapter_auth_sessions_expires_idx" ON "adapter_auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "adapter_auth_sessions_provider_lease_idx" ON "adapter_auth_sessions" USING btree ("provider_lease_id");