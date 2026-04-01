CREATE TABLE IF NOT EXISTS "seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"parent_seat_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"seat_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"operating_mode" text DEFAULT 'vacant' NOT NULL,
	"default_agent_id" uuid,
	"current_human_user_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seat_occupancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"occupant_type" text NOT NULL,
	"occupant_id" text NOT NULL,
	"occupancy_role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_execution_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"binding_type" text NOT NULL,
	"provider_type" text NOT NULL,
	"provider_ref" text,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "seat_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "seat_role" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "owner_seat_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "lead_seat_id" uuid;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "owner_seat_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "assignee_seat_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seats_company_id_companies_id_fk') THEN
  ALTER TABLE "seats" ADD CONSTRAINT "seats_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seats_parent_seat_id_seats_id_fk') THEN
  ALTER TABLE "seats" ADD CONSTRAINT "seats_parent_seat_id_seats_id_fk" FOREIGN KEY ("parent_seat_id") REFERENCES "public"."seats"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seats_default_agent_id_agents_id_fk') THEN
  ALTER TABLE "seats" ADD CONSTRAINT "seats_default_agent_id_agents_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_occupancies_company_id_companies_id_fk') THEN
  ALTER TABLE "seat_occupancies" ADD CONSTRAINT "seat_occupancies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_occupancies_seat_id_seats_id_fk') THEN
  ALTER TABLE "seat_occupancies" ADD CONSTRAINT "seat_occupancies_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_occupancies_created_by_agent_id_agents_id_fk') THEN
  ALTER TABLE "seat_occupancies" ADD CONSTRAINT "seat_occupancies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_execution_bindings_company_id_companies_id_fk') THEN
  ALTER TABLE "agent_execution_bindings" ADD CONSTRAINT "agent_execution_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_execution_bindings_agent_id_agents_id_fk') THEN
  ALTER TABLE "agent_execution_bindings" ADD CONSTRAINT "agent_execution_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_seat_id_seats_id_fk') THEN
  ALTER TABLE "agents" ADD CONSTRAINT "agents_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issues_owner_seat_id_seats_id_fk') THEN
  ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_seat_id_seats_id_fk" FOREIGN KEY ("owner_seat_id") REFERENCES "public"."seats"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_lead_seat_id_seats_id_fk') THEN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_seat_id_seats_id_fk" FOREIGN KEY ("lead_seat_id") REFERENCES "public"."seats"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goals_owner_seat_id_seats_id_fk') THEN
  ALTER TABLE "goals" ADD CONSTRAINT "goals_owner_seat_id_seats_id_fk" FOREIGN KEY ("owner_seat_id") REFERENCES "public"."seats"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routines_assignee_seat_id_seats_id_fk') THEN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_assignee_seat_id_seats_id_fk" FOREIGN KEY ("assignee_seat_id") REFERENCES "public"."seats"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seats_company_slug_uq" ON "seats" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seats_company_parent_idx" ON "seats" USING btree ("company_id","parent_seat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seats_company_type_status_idx" ON "seats" USING btree ("company_id","seat_type","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seats_company_mode_idx" ON "seats" USING btree ("company_id","operating_mode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seats_company_default_agent_idx" ON "seats" USING btree ("company_id","default_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seat_occupancies_company_seat_status_idx" ON "seat_occupancies" USING btree ("company_id","seat_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seat_occupancies_company_occupant_status_idx" ON "seat_occupancies" USING btree ("company_id","occupant_type","occupant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seat_occupancies_company_role_status_idx" ON "seat_occupancies" USING btree ("company_id","occupancy_role","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seat_occupancies_seat_role_starts_idx" ON "seat_occupancies" USING btree ("seat_id","occupancy_role","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_execution_bindings_company_agent_status_idx" ON "agent_execution_bindings" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_execution_bindings_company_provider_status_idx" ON "agent_execution_bindings" USING btree ("company_id","provider_type","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_execution_bindings_agent_binding_type_idx" ON "agent_execution_bindings" USING btree ("agent_id","binding_type","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_company_seat_idx" ON "agents" USING btree ("company_id","seat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_owner_seat_idx" ON "issues" USING btree ("company_id","owner_seat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_company_lead_seat_idx" ON "projects" USING btree ("company_id","lead_seat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_company_owner_seat_idx" ON "goals" USING btree ("company_id","owner_seat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_company_assignee_seat_idx" ON "routines" USING btree ("company_id","assignee_seat_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seats_one_active_ceo_per_company_uq" ON "seats" USING btree ("company_id") WHERE "seat_type" = 'ceo' AND "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seat_occupancies_one_active_primary_agent_per_seat_uq" ON "seat_occupancies" USING btree ("seat_id") WHERE "occupancy_role" = 'primary_agent' AND "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seat_occupancies_one_active_human_per_seat_uq" ON "seat_occupancies" USING btree ("seat_id") WHERE "occupancy_role" = 'human_operator' AND "status" = 'active';
