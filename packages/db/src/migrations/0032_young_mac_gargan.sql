CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"title" text,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"archived_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "chat_session_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_sessions_company_idx" ON "chat_sessions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_agent_updated_idx" ON "chat_sessions" USING btree ("agent_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_agent_archived_updated_idx" ON "chat_sessions" USING btree ("agent_id","archived_at","updated_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_last_run_idx" ON "chat_sessions" USING btree ("last_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_company_agent_task_key_idx" ON "chat_sessions" USING btree ("company_id","agent_id","task_key");--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_session_created_at_idx" ON "chat_messages" USING btree ("chat_session_id","created_at");--> statement-breakpoint
WITH legacy_agents AS (
  SELECT DISTINCT "company_id", "agent_id"
  FROM "chat_messages"
  WHERE "chat_session_id" IS NULL
),
inserted_sessions AS (
  INSERT INTO "chat_sessions" (
    "id",
    "company_id",
    "agent_id",
    "task_key",
    "title",
    "last_message_at",
    "last_run_id",
    "created_at",
    "updated_at"
  )
  SELECT
    seed.id,
    legacy_agents."company_id",
    legacy_agents."agent_id",
    'chat:' || seed.id::text,
    'General chat',
    (
      SELECT MAX("created_at")
      FROM "chat_messages" AS m
      WHERE m."company_id" = legacy_agents."company_id"
        AND m."agent_id" = legacy_agents."agent_id"
    ),
    (
      SELECT m2."run_id"
      FROM "chat_messages" AS m2
      WHERE m2."company_id" = legacy_agents."company_id"
        AND m2."agent_id" = legacy_agents."agent_id"
        AND m2."run_id" IS NOT NULL
      ORDER BY m2."created_at" DESC
      LIMIT 1
    ),
    now(),
    now()
  FROM legacy_agents
  CROSS JOIN LATERAL (
    SELECT gen_random_uuid() AS id
  ) AS seed
  RETURNING "id", "company_id", "agent_id"
)
UPDATE "chat_messages" AS m
SET "chat_session_id" = s."id"
FROM inserted_sessions AS s
WHERE m."company_id" = s."company_id"
  AND m."agent_id" = s."agent_id"
  AND m."chat_session_id" IS NULL;