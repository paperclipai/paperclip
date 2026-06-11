CREATE TABLE "tool_oauth_states" (
  "state" text PRIMARY KEY NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "code_verifier" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "tool_oauth_states"
  ADD CONSTRAINT "tool_oauth_states_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "tool_oauth_states"
  ADD CONSTRAINT "tool_oauth_states_connection_id_tool_connections_id_fk"
  FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id")
  ON DELETE cascade ON UPDATE no action;

CREATE INDEX "tool_oauth_states_company_idx" ON "tool_oauth_states" USING btree ("company_id");
CREATE INDEX "tool_oauth_states_connection_idx" ON "tool_oauth_states" USING btree ("connection_id");
CREATE INDEX "tool_oauth_states_expires_at_idx" ON "tool_oauth_states" USING btree ("expires_at");
