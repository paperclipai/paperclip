ALTER TABLE "agents" ADD COLUMN "lifecycle_state" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_participants" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_holds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_error" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "lifecycle_operation" jsonb;--> statement-breakpoint
CREATE INDEX "agents_lifecycle_work_idx" ON "agents" USING btree ("lifecycle_state","updated_at","id");
--> statement-breakpoint
UPDATE "agents" SET
  "lifecycle_state" = CASE "status"
    WHEN 'pending_approval' THEN 'pending_approval'
    WHEN 'paused' THEN 'paused'
    WHEN 'terminated' THEN 'terminated'
    ELSE 'ready' END,
  "lifecycle_holds" = CASE WHEN "status" = 'paused'
    THEN jsonb_build_array(coalesce("pause_reason", 'manual')) ELSE '[]'::jsonb END;
