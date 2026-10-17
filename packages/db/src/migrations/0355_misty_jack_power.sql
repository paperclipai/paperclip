CREATE TABLE "provider_quota_dispatch_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"adapter_type" text NOT NULL,
	"provider" text,
	"source_run_id" uuid,
	"hold_until" timestamp with time zone NOT NULL,
	"evidence" jsonb,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_quota_dispatch_holds_company_scope_uq" UNIQUE("company_id","scope_key")
);
--> statement-breakpoint
ALTER TABLE "provider_quota_dispatch_holds" ADD CONSTRAINT "provider_quota_dispatch_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_quota_dispatch_holds" ADD CONSTRAINT "provider_quota_dispatch_holds_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_quota_dispatch_holds_active_until_idx" ON "provider_quota_dispatch_holds" USING btree ("hold_until") WHERE "provider_quota_dispatch_holds"."released_at" is null;