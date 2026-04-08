-- Phase 4b: agent_sessions
--
-- A session is a durable context for a leader agent's Claude CLI.
-- Separating session from agent means restarting the CLI does NOT
-- blow away conversation state: the workspace_path is stable per
-- session, and Claude's ~/.claude/projects/<hash(cwd)>/ auto-restores
-- when the same cwd is used again.
--
-- One active session per agent (partial unique index). Archived
-- sessions remain for history — UI can list them.
--
-- leader_processes.session_id FKs this table (set null on session
-- deletion; archive keeps the row).

CREATE TABLE "agent_sessions" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id"        uuid NOT NULL,
  "agent_id"          uuid NOT NULL,
  "workspace_path"    text NOT NULL,
  "claude_project_dir" text,
  "status"            text NOT NULL,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "archived_at"       timestamp with time zone,
  "archive_reason"    text
);
--> statement-breakpoint
ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_status_check"
  CHECK (status IN ('active','archived'));
--> statement-breakpoint
CREATE INDEX "agent_sessions_company_idx" ON "agent_sessions" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "agent_sessions_agent_status_idx" ON "agent_sessions" USING btree ("agent_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_one_active_per_agent"
  ON "agent_sessions" USING btree ("agent_id")
  WHERE status = 'active';
--> statement-breakpoint
ALTER TABLE "leader_processes"
  ADD CONSTRAINT "leader_processes_session_id_agent_sessions_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id")
  ON DELETE set null ON UPDATE no action;
