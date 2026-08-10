CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_credential_id_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_agent_credential_unique_idx" ON "agent_credentials" USING btree ("agent_id","credential_id");
--> statement-breakpoint
CREATE INDEX "agent_credentials_agent_idx" ON "agent_credentials" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "agent_credentials_credential_idx" ON "agent_credentials" USING btree ("credential_id");
--> statement-breakpoint
INSERT INTO "agent_credentials" ("agent_id", "credential_id")
SELECT "id", "credential_id" FROM "agents" WHERE "credential_id" IS NOT NULL
ON CONFLICT DO NOTHING;
