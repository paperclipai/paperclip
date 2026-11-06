CREATE TABLE "user_delegates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"delegate_agent_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"revoked_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_delegates_status_check" CHECK ("user_delegates"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "user_delegates" ADD CONSTRAINT "user_delegates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_delegates" ADD CONSTRAINT "user_delegates_delegate_agent_id_agents_id_fk" FOREIGN KEY ("delegate_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_delegates_active_company_user_uq" ON "user_delegates" USING btree ("company_id","user_id") WHERE "user_delegates"."status" = 'active';--> statement-breakpoint
CREATE INDEX "user_delegates_company_agent_idx" ON "user_delegates" USING btree ("company_id","delegate_agent_id");