ALTER TABLE "issues"
  ADD COLUMN "reviewer_agent_id" uuid REFERENCES "agents"("id"),
  ADD COLUMN "reviewer_user_id" text;
