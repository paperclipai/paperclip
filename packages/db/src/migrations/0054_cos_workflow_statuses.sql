CREATE TABLE "team_workflow_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"category" text NOT NULL,
	"color" text,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_workflow_statuses" ADD CONSTRAINT "team_workflow_statuses_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_workflow_statuses_team_idx" ON "team_workflow_statuses" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_workflow_statuses_team_slug_uniq" ON "team_workflow_statuses" USING btree ("team_id","slug");
