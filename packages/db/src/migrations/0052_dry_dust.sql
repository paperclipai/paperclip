CREATE TABLE "quick_note_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "agent_chats" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_chats" ADD COLUMN "anchor_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "quick_note_threads" ADD CONSTRAINT "quick_note_threads_note_id_quick_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."quick_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_notes" ADD CONSTRAINT "quick_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quick_note_threads_note_id_idx" ON "quick_note_threads" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "quick_notes_company_user_idx" ON "quick_notes" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "quick_notes_company_created_idx" ON "quick_notes" USING btree ("company_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_chats" ADD CONSTRAINT "agent_chats_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chats" ADD CONSTRAINT "agent_chats_anchor_comment_id_issue_comments_id_fk" FOREIGN KEY ("anchor_comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chats_quick_chat_idx" ON "agent_chats" USING btree ("agent_id","anchor_comment_id") WHERE "agent_chats"."anchor_comment_id" is not null;