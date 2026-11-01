CREATE TABLE IF NOT EXISTS "agent_file_roots" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"entries" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_file_roots_company_id_agent_id_pk" PRIMARY KEY("company_id","agent_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_file_roots" ADD CONSTRAINT "agent_file_roots_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
