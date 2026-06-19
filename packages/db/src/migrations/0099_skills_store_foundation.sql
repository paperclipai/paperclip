ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "icon_url" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "tagline" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "author_name" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "homepage_url" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "categories" text[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "sharing_scope" text NOT NULL DEFAULT 'company';--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "public_share_token" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "forked_from_skill_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "forked_from_company_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "star_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "install_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "fork_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "current_version_id" uuid;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_skill_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "company_skill_id" uuid NOT NULL,
  "revision_number" integer NOT NULL,
  "label" text,
  "file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "author_agent_id" uuid,
  "author_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_skill_stars" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "company_skill_id" uuid NOT NULL,
  "agent_id" uuid,
  "user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_skill_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "company_skill_id" uuid NOT NULL,
  "parent_comment_id" uuid,
  "author_agent_id" uuid,
  "author_user_id" text,
  "body" text NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_forked_from_skill_id_company_skills_id_fk" FOREIGN KEY ("forked_from_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_forked_from_company_id_companies_id_fk" FOREIGN KEY ("forked_from_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_company_skill_id_company_skills_id_fk" FOREIGN KEY ("company_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_current_version_id_company_skill_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."company_skill_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_stars" ADD CONSTRAINT "company_skill_stars_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_stars" ADD CONSTRAINT "company_skill_stars_company_skill_id_company_skills_id_fk" FOREIGN KEY ("company_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_stars" ADD CONSTRAINT "company_skill_stars_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_company_skill_id_company_skills_id_fk" FOREIGN KEY ("company_skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_parent_comment_id_company_skill_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."company_skill_comments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_comments" ADD CONSTRAINT "company_skill_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skills_company_categories_idx" ON "company_skills" USING gin ("categories");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skills_company_sharing_scope_idx" ON "company_skills" USING btree ("company_id","sharing_scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skills_company_current_version_idx" ON "company_skills" USING btree ("company_id","current_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skills_company_forked_from_idx" ON "company_skills" USING btree ("company_id","forked_from_skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_versions_skill_revision_idx" ON "company_skill_versions" USING btree ("company_skill_id","revision_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_versions_company_skill_created_idx" ON "company_skill_versions" USING btree ("company_id","company_skill_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_stars_skill_agent_idx" ON "company_skill_stars" USING btree ("company_skill_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_stars_skill_user_idx" ON "company_skill_stars" USING btree ("company_skill_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_stars_company_skill_created_idx" ON "company_skill_stars" USING btree ("company_id","company_skill_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_comments_company_skill_created_idx" ON "company_skill_comments" USING btree ("company_id","company_skill_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_comments_parent_idx" ON "company_skill_comments" USING btree ("parent_comment_id");
