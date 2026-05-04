CREATE TABLE "rt2_career_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"summary" text,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"certifications" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_tasks_completed" integer DEFAULT 0 NOT NULL,
	"total_projects_delivered" integer DEFAULT 0 NOT NULL,
	"average_quality_score" integer DEFAULT 0 NOT NULL,
	"years_of_experience" integer DEFAULT 0 NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"portable_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_career_portfolio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"career_profile_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"work_product_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quality_score" integer DEFAULT 0 NOT NULL,
	"complexity_level" text DEFAULT 'medium' NOT NULL,
	"impact_summary" text,
	"evidence_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_skill_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"transfer_type" text NOT NULL,
	"source_profile_id" uuid,
	"source_company_id" uuid,
	"dest_profile_id" uuid,
	"dest_company_id" uuid,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transfer_reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"verification_score" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_career_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"career_profile_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"achieved_at" timestamp with time zone,
	"evidence_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"impact_metrics" jsonb,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_career_profiles" ADD CONSTRAINT "rt2_career_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_career_portfolio" ADD CONSTRAINT "rt2_career_portfolio_career_profile_id_rt2_career_profiles_id_fk" FOREIGN KEY ("career_profile_id") REFERENCES "public"."rt2_career_profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_career_portfolio" ADD CONSTRAINT "rt2_career_portfolio_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_skill_transfers" ADD CONSTRAINT "rt2_skill_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_skill_transfers" ADD CONSTRAINT "rt2_skill_transfers_source_profile_id_rt2_career_profiles_id_fk" FOREIGN KEY ("source_profile_id") REFERENCES "public"."rt2_career_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_skill_transfers" ADD CONSTRAINT "rt2_skill_transfers_dest_profile_id_rt2_career_profiles_id_fk" FOREIGN KEY ("dest_profile_id") REFERENCES "public"."rt2_career_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_career_milestones" ADD CONSTRAINT "rt2_career_milestones_career_profile_id_rt2_career_profiles_id_fk" FOREIGN KEY ("career_profile_id") REFERENCES "public"."rt2_career_profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_career_milestones" ADD CONSTRAINT "rt2_career_milestones_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "career_profiles_company_idx" ON "rt2_career_profiles" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "career_profiles_agent_idx" ON "rt2_career_profiles" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "career_profiles_public_idx" ON "rt2_career_profiles" USING btree ("is_public");
--> statement-breakpoint
CREATE INDEX "career_portfolio_profile_idx" ON "rt2_career_portfolio" USING btree ("career_profile_id");
--> statement-breakpoint
CREATE INDEX "career_portfolio_company_idx" ON "rt2_career_portfolio" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "career_portfolio_category_idx" ON "rt2_career_portfolio" USING btree ("category");
--> statement-breakpoint
CREATE INDEX "career_portfolio_featured_idx" ON "rt2_career_portfolio" USING btree ("is_featured");
--> statement-breakpoint
CREATE INDEX "skill_transfers_company_idx" ON "rt2_skill_transfers" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "skill_transfers_source_idx" ON "rt2_skill_transfers" USING btree ("source_profile_id");
--> statement-breakpoint
CREATE INDEX "skill_transfers_dest_idx" ON "rt2_skill_transfers" USING btree ("dest_profile_id");
--> statement-breakpoint
CREATE INDEX "skill_transfers_status_idx" ON "rt2_skill_transfers" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "career_milestones_profile_idx" ON "rt2_career_milestones" USING btree ("career_profile_id");
--> statement-breakpoint
CREATE INDEX "career_milestones_company_idx" ON "rt2_career_milestones" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "career_milestones_category_idx" ON "rt2_career_milestones" USING btree ("category");
