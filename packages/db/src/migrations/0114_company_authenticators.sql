CREATE TABLE "company_authenticators" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "issuer" text,
  "account_name" text,
  "secret_id" uuid NOT NULL REFERENCES "company_secrets"("id") ON DELETE restrict,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "company_authenticators_company_idx" ON "company_authenticators" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_authenticators_company_name_uq" ON "company_authenticators" USING btree ("company_id", "name");
--> statement-breakpoint
CREATE TABLE "company_authenticator_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "authenticator_id" uuid NOT NULL REFERENCES "company_authenticators"("id") ON DELETE cascade,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE cascade,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "company_authenticator_agents_authenticator_idx" ON "company_authenticator_agents" USING btree ("authenticator_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_authenticator_agents_unique_uq" ON "company_authenticator_agents" USING btree ("authenticator_id", "agent_id");
