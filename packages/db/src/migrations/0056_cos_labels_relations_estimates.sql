-- Labels: team scope + label groups (parent_id self-ref)
ALTER TABLE "labels" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_parent_id_labels_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "labels_team_idx" ON "labels" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "labels_parent_idx" ON "labels" USING btree ("parent_id");--> statement-breakpoint
-- Issues: estimate
ALTER TABLE "issues" ADD COLUMN "estimate" integer;--> statement-breakpoint
-- Teams: settings JSONB
ALTER TABLE "teams" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
