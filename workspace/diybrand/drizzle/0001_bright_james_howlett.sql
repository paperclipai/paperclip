CREATE TABLE "brand_palette" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"colors" jsonb NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_palette" ADD CONSTRAINT "brand_palette_questionnaire_id_brand_questionnaire_id_fk" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."brand_questionnaire"("id") ON DELETE no action ON UPDATE no action;