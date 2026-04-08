-- Phase 4b: leader_processes
--
-- One row per leader agent that has been provisioned for CLI runtime.
-- Intent + history: the DB holds what SHOULD be running + the run
-- history; PM2 holds what IS running. leaderProcessService reconciles.
--
-- Unique (agent_id) — only one active process row per agent. Restart
-- reuses the same row (status transitions only).

CREATE TABLE "leader_processes" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id"         uuid NOT NULL,
  "agent_id"           uuid NOT NULL,
  "session_id"         uuid,
  "status"             text NOT NULL,
  "pm2_name"           text,
  "pm2_pm_id"          integer,
  "pid"                integer,
  "agent_key_id"       uuid,
  "started_at"         timestamp with time zone,
  "stopped_at"         timestamp with time zone,
  "last_heartbeat_at"  timestamp with time zone,
  "exit_code"          integer,
  "exit_reason"        text,
  "error_message"      text,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "leader_processes"
  ADD CONSTRAINT "leader_processes_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leader_processes"
  ADD CONSTRAINT "leader_processes_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leader_processes"
  ADD CONSTRAINT "leader_processes_agent_key_id_agent_api_keys_id_fk"
  FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_api_keys"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leader_processes"
  ADD CONSTRAINT "leader_processes_agent_unique" UNIQUE ("agent_id");
--> statement-breakpoint
ALTER TABLE "leader_processes"
  ADD CONSTRAINT "leader_processes_status_check"
  CHECK (status IN ('stopped','starting','running','stopping','crashed'));
--> statement-breakpoint
CREATE INDEX "leader_processes_company_idx" ON "leader_processes" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "leader_processes_status_idx" ON "leader_processes" USING btree ("status");
