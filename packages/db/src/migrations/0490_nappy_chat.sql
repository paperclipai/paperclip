CREATE TABLE "tool_connection_content_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_actor_type" text NOT NULL,
	"requested_by_actor_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_connection_content_deletions" ADD CONSTRAINT "tool_connection_content_deletions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_connection_content_deletions" ADD CONSTRAINT "tool_connection_content_deletions_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_connection_content_deletions_connection_idx" ON "tool_connection_content_deletions" USING btree ("company_id","connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_connection_content_deletions_pending_uq" ON "tool_connection_content_deletions" USING btree ("company_id","connection_id") WHERE "tool_connection_content_deletions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tool_connection_content_deletions_pending_idx" ON "tool_connection_content_deletions" USING btree ("requested_at") WHERE "tool_connection_content_deletions"."status" = 'pending';