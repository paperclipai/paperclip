CREATE TABLE "workflow_handoff_bridges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "workflow_run_id" uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE cascade,
  "workflow_handoff_id" uuid NOT NULL REFERENCES "workflow_handoffs"("id") ON DELETE cascade,
  "provider" text NOT NULL,
  "status" text DEFAULT 'pending_delivery' NOT NULL,
  "close_outcome" text,
  "external_message_id" text,
  "external_thread_id" text,
  "next_poll_at" timestamptz,
  "last_polled_at" timestamptz,
  "closed_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "workflow_handoff_bridges_handoff_active_uq" ON "workflow_handoff_bridges" ("workflow_handoff_id") WHERE status in ('pending_delivery', 'waiting_for_human');
CREATE INDEX "workflow_handoff_bridges_company_poll_idx" ON "workflow_handoff_bridges" ("company_id","status","next_poll_at");
