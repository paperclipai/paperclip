CREATE TABLE "youtube_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"submitted_by_user_id" text NOT NULL,
	"url" text NOT NULL,
	"video_id" text,
	"title" text,
	"channel" text,
	"description" text,
	"thumbnail_url" text,
	"duration_sec" integer,
	"view_count" integer,
	"like_count" integer,
	"tags" jsonb,
	"transcript" text,
	"transcript_source" text,
	"report" text,
	"status" text DEFAULT 'processing' NOT NULL,
	"error_message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "youtube_extractions" ADD CONSTRAINT "youtube_extractions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "youtube_extractions_company_created_idx" ON "youtube_extractions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "youtube_extractions_company_status_idx" ON "youtube_extractions" USING btree ("company_id","status");
