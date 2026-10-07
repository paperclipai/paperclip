CREATE TABLE "user_saved_task_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"collection_key" text NOT NULL,
	"name" text NOT NULL,
	"view_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_saved_task_views" ADD CONSTRAINT "user_saved_task_views_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_saved_task_views_owner_idx" ON "user_saved_task_views" USING btree ("company_id","user_id","collection_key");--> statement-breakpoint
CREATE UNIQUE INDEX "user_saved_task_views_owner_name_uq" ON "user_saved_task_views" USING btree ("company_id","user_id","collection_key","name");