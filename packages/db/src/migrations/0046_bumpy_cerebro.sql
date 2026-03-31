CREATE TABLE "company_knowledge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"target_id" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"always_inject" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_knowledge" ADD CONSTRAINT "company_knowledge_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_knowledge_company_tier_idx" ON "company_knowledge" USING btree ("company_id","tier");