CREATE TABLE "environment_custom_image_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "environment_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "template_kind" text DEFAULT 'unknown' NOT NULL,
  "template_ref" text NOT NULL,
  "source_template_ref" text,
  "source_environment_config_fingerprint" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_user_id" text,
  "created_by_agent_id" uuid,
  "captured_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "superseded_by_template_id" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_custom_image_setup_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "environment_id" uuid NOT NULL,
  "template_id" uuid,
  "promoted_template_id" uuid,
  "provider" text NOT NULL,
  "provider_lease_id" text,
  "environment_lease_id" uuid,
  "status" text DEFAULT 'starting' NOT NULL,
  "started_by_user_id" text,
  "started_by_agent_id" uuid,
  "base_template_ref" text,
  "expires_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "failure_reason" text,
  "connection_summary" jsonb,
  "connection_secret_ref" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates"
  ADD CONSTRAINT "environment_custom_image_templates_company_id_companies_id_fk"
  FOREIGN KEY ("company_id")
  REFERENCES "public"."companies"("id")
  ON DELETE cascade
  ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates"
  ADD CONSTRAINT "environment_custom_image_templates_environment_id_environments_id_fk"
  FOREIGN KEY ("environment_id")
  REFERENCES "public"."environments"("id")
  ON DELETE cascade
  ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates"
  ADD CONSTRAINT "environment_custom_image_templates_created_by_agent_id_agents_id_fk"
  FOREIGN KEY ("created_by_agent_id")
  REFERENCES "public"."agents"("id")
  ON DELETE set null
  ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates"
  ADD CONSTRAINT "environment_custom_image_templates_superseded_by_template_id_fk"
  FOREIGN KEY ("superseded_by_template_id")
  REFERENCES "public"."environment_custom_image_templates"("id")
  ON DELETE set null
  ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_company_id_companies_id_fk"
  FOREIGN KEY ("company_id")
  REFERENCES "public"."companies"("id")
  ON DELETE cascade
  ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_environment_id_environments_id_fk"
  FOREIGN KEY ("environment_id")
  REFERENCES "public"."environments"("id")
  ON DELETE cascade
  ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_template_id_fk"
  FOREIGN KEY ("template_id")
  REFERENCES "public"."environment_custom_image_templates"("id")
  ON DELETE set null
  ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_promoted_template_id_fk"
  FOREIGN KEY ("promoted_template_id")
  REFERENCES "public"."environment_custom_image_templates"("id")
  ON DELETE set null
  ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_environment_lease_id_environment_leases_id_fk"
  FOREIGN KEY ("environment_lease_id")
  REFERENCES "public"."environment_leases"("id")
  ON DELETE set null
  ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions"
  ADD CONSTRAINT "environment_custom_image_setup_sessions_started_by_agent_id_agents_id_fk"
  FOREIGN KEY ("started_by_agent_id")
  REFERENCES "public"."agents"("id")
  ON DELETE set null
  ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_company_environment_status_idx"
  ON "environment_custom_image_templates" USING btree ("company_id", "environment_id", "status");
--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_company_provider_status_idx"
  ON "environment_custom_image_templates" USING btree ("company_id", "provider", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "environment_custom_image_templates_company_environment_active_uq"
  ON "environment_custom_image_templates" USING btree ("company_id", "environment_id")
  WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_superseded_by_idx"
  ON "environment_custom_image_templates" USING btree ("superseded_by_template_id");
--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_company_last_used_idx"
  ON "environment_custom_image_templates" USING btree ("company_id", "last_used_at");
--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_company_environment_status_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "environment_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "environment_custom_image_setup_sessions_company_environment_active_uq"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "environment_id")
  WHERE "status" IN ('starting', 'waiting_for_user', 'capturing');
--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_company_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "template_id");
--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_company_promoted_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "promoted_template_id");
--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_company_expires_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "expires_at");
--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_provider_lease_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("provider", "provider_lease_id");
