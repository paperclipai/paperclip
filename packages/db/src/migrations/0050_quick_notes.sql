CREATE TABLE "quick_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quick_note_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quick_notes" ADD CONSTRAINT "quick_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quick_note_threads" ADD CONSTRAINT "quick_note_threads_note_id_quick_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."quick_notes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "quick_notes_company_user_idx" ON "quick_notes" USING btree ("company_id","user_id");
--> statement-breakpoint
CREATE INDEX "quick_notes_company_created_idx" ON "quick_notes" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "quick_note_threads_note_id_idx" ON "quick_note_threads" USING btree ("note_id");
