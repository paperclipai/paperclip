CREATE TABLE "native_provider_artifact_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"backup_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_provider_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"closure_digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"upload_token" uuid,
	"descriptor" jsonb NOT NULL,
	"reference" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_provider_artifact_references" ADD CONSTRAINT "native_provider_artifact_references_artifact_id_native_provider_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."native_provider_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_provider_artifact_references" ADD CONSTRAINT "native_provider_artifact_references_backup_id_native_harness_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."native_harness_backups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_provider_artifact_references_artifact_idx" ON "native_provider_artifact_references" USING btree ("company_id","artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "native_provider_artifact_references_run_idx" ON "native_provider_artifact_references" USING btree ("company_id","run_id","artifact_id") WHERE "native_provider_artifact_references"."backup_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "native_provider_artifact_references_backup_idx" ON "native_provider_artifact_references" USING btree ("company_id","artifact_id","backup_id") WHERE "native_provider_artifact_references"."backup_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "native_provider_artifacts_company_digest_idx" ON "native_provider_artifacts" USING btree ("company_id","closure_digest") WHERE "native_provider_artifacts"."status" = 'ready';