CREATE TABLE "tool_mcp_skill_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"file_uri" text NOT NULL,
	"digest" text NOT NULL,
	"size" integer NOT NULL,
	"content_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_mcp_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"skill_uri" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"manifest" jsonb,
	"manifest_digest" text,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"status_reason" text,
	"approved_manifest_digest" text,
	"allowed_tools_approved" boolean DEFAULT false NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_mcp_skill_files" ADD CONSTRAINT "tool_mcp_skill_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_skill_files" ADD CONSTRAINT "tool_mcp_skill_files_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_skills" ADD CONSTRAINT "tool_mcp_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_mcp_skills" ADD CONSTRAINT "tool_mcp_skills_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_mcp_skill_files_digest_idx" ON "tool_mcp_skill_files" USING btree ("company_id","connection_id","file_uri","digest");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_mcp_skills_connection_uri_idx" ON "tool_mcp_skills" USING btree ("company_id","connection_id","skill_uri");--> statement-breakpoint
CREATE INDEX "tool_mcp_skills_company_status_idx" ON "tool_mcp_skills" USING btree ("company_id","status");