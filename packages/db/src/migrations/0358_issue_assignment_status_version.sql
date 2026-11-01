CREATE OR REPLACE FUNCTION paperclip_bump_issue_assignment_version()
RETURNS trigger AS $$
BEGIN
	IF NEW."assignee_agent_id" IS DISTINCT FROM OLD."assignee_agent_id"
		OR NEW."assignee_user_id" IS DISTINCT FROM OLD."assignee_user_id" THEN
		NEW."status_version" := OLD."status_version" + 1;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_assignment_version_trigger ON "issues";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_assignment_version_trigger
BEFORE UPDATE OF "assignee_agent_id", "assignee_user_id" ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_assignment_version();
