CREATE TABLE "document_annotation_comment_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"reaction" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "document_annotation_comment_reactions_reaction_chk" CHECK ("document_annotation_comment_reactions"."reaction" in ('done', 'check', 'thumbs_up', 'question')),
	CONSTRAINT "document_annotation_comment_reactions_actor_type_chk" CHECK ("document_annotation_comment_reactions"."actor_type" in ('agent', 'user'))
);
--> statement-breakpoint
ALTER TABLE "document_annotation_comment_reactions" ADD CONSTRAINT "document_annotation_comment_reactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_annotation_comment_reactions" ADD CONSTRAINT "document_annotation_comment_reactions_comment_id_document_annotation_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."document_annotation_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_annotation_comment_reactions_company_comment_idx" ON "document_annotation_comment_reactions" USING btree ("company_id","comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_annotation_comment_reactions_comment_reaction_actor_idx" ON "document_annotation_comment_reactions" USING btree ("comment_id","reaction","actor_type","actor_id");