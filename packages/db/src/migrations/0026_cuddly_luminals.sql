CREATE TABLE "issue_knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"knowledge_item_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text,
	"body" text,
	"asset_id" uuid,
	"source_url" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_knowledge_items" ADD CONSTRAINT "issue_knowledge_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_knowledge_items" ADD CONSTRAINT "issue_knowledge_items_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_knowledge_items" ADD CONSTRAINT "issue_knowledge_items_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_knowledge_items" ADD CONSTRAINT "issue_knowledge_items_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_knowledge_items_company_issue_idx" ON "issue_knowledge_items" USING btree ("company_id","issue_id","sort_order");--> statement-breakpoint
CREATE INDEX "issue_knowledge_items_company_knowledge_idx" ON "issue_knowledge_items" USING btree ("company_id","knowledge_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_knowledge_items_issue_knowledge_uq" ON "issue_knowledge_items" USING btree ("issue_id","knowledge_item_id");--> statement-breakpoint
CREATE INDEX "knowledge_items_company_created_idx" ON "knowledge_items" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_items_company_kind_idx" ON "knowledge_items" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "knowledge_items_company_title_idx" ON "knowledge_items" USING btree ("company_id","title");--> statement-breakpoint
CREATE INDEX "knowledge_items_asset_idx" ON "knowledge_items" USING btree ("asset_id");