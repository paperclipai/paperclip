CREATE TABLE IF NOT EXISTS "cross_company_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cursor" bigserial NOT NULL,
  "source_company_id" uuid NOT NULL,
  "source_agent_id" uuid NOT NULL,
  "destination_company_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "message_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "acked_at" timestamp with time zone,
  "acked_by_agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cross_company_messages" ADD CONSTRAINT "cross_company_messages_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cross_company_messages" ADD CONSTRAINT "cross_company_messages_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cross_company_messages" ADD CONSTRAINT "cross_company_messages_destination_company_id_companies_id_fk" FOREIGN KEY ("destination_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cross_company_messages" ADD CONSTRAINT "cross_company_messages_acked_by_agent_id_agents_id_fk" FOREIGN KEY ("acked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cross_company_messages_cursor_uq"
  ON "cross_company_messages" USING btree ("cursor");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cross_company_messages_source_idempotency_uq"
  ON "cross_company_messages" USING btree ("source_company_id","destination_company_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cross_company_messages_destination_cursor_idx"
  ON "cross_company_messages" USING btree ("destination_company_id","cursor");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cross_company_messages_source_cursor_idx"
  ON "cross_company_messages" USING btree ("source_company_id","cursor");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cross_company_messages_destination_ack_cursor_idx"
  ON "cross_company_messages" USING btree ("destination_company_id","acked_at","cursor");
