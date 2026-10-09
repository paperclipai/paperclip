CREATE INDEX IF NOT EXISTS "user_inbox_agent_policies_allowed_agent_ids_idx" ON "user_inbox_agent_policies" USING gin ("allowed_agent_ids");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "remove_deleted_agent_from_inbox_policy_allowlists"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	UPDATE "user_inbox_agent_policies"
	SET
		"allowed_agent_ids" = "allowed_agent_ids" - OLD."id"::text,
		"updated_at" = now()
	WHERE "allowed_agent_ids" ? OLD."id"::text;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agents_cleanup_inbox_policy_allowlists" ON "agents";
--> statement-breakpoint
CREATE TRIGGER "agents_cleanup_inbox_policy_allowlists"
AFTER DELETE ON "agents"
FOR EACH ROW
EXECUTE FUNCTION "remove_deleted_agent_from_inbox_policy_allowlists"();
