ALTER TABLE "issues" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_company_team_idx" ON "issues" USING btree ("company_id","team_id");
