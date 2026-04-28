-- Add lineage tracking columns to agent_blueprints and agents

ALTER TABLE "agent_blueprints"
  ADD COLUMN "source_agent_id" uuid,
  ADD COLUMN "source_blueprint_id" uuid;

ALTER TABLE "agents"
  ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN "source_blueprint_id" uuid
    REFERENCES "agent_blueprints"("id") ON DELETE SET NULL;
