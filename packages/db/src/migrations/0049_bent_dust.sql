CREATE TABLE "agent_permission_defaults" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"assign_default" boolean DEFAULT false NOT NULL,
	"comment_default" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grantee_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "board_api_keys_key_hash_idx";--> statement-breakpoint
ALTER TABLE "agent_permission_defaults" ADD CONSTRAINT "agent_permission_defaults_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_permission_grants" ADD CONSTRAINT "agent_permission_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_permission_grants" ADD CONSTRAINT "agent_permission_grants_grantee_id_agents_id_fk" FOREIGN KEY ("grantee_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_permission_grants" ADD CONSTRAINT "agent_permission_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_permission_grants_unique_idx" ON "agent_permission_grants" USING btree ("company_id","grantee_id","agent_id","permission");--> statement-breakpoint
CREATE INDEX "agent_permission_grants_grantee_idx" ON "agent_permission_grants" USING btree ("grantee_id");--> statement-breakpoint
CREATE INDEX "agent_permission_grants_agent_idx" ON "agent_permission_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_api_keys_key_hash_idx" ON "board_api_keys" USING btree ("key_hash");--> statement-breakpoint
INSERT INTO "agent_permission_defaults" ("company_id", "assign_default", "comment_default", "updated_at")
SELECT "id", false, false, now() FROM "companies"
ON CONFLICT ("company_id") DO NOTHING;