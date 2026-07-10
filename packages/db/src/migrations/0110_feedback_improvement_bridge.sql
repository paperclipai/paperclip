ALTER TABLE "improvement_suggestions" ADD COLUMN IF NOT EXISTS "source_feedback_vote_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'improvement_suggestions_source_feedback_vote_id_feedback_votes_id_fk') THEN
  ALTER TABLE "improvement_suggestions" ADD CONSTRAINT "improvement_suggestions_source_feedback_vote_id_feedback_votes_id_fk" FOREIGN KEY ("source_feedback_vote_id") REFERENCES "public"."feedback_votes"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "improvement_suggestions_source_feedback_vote_idx" ON "improvement_suggestions" USING btree ("source_feedback_vote_id");
--> statement-breakpoint
INSERT INTO "improvement_suggestions" (
  "company_id",
  "origin_kind",
  "status",
  "target_layer",
  "title",
  "summary",
  "proposed_change",
  "evidence",
  "source_issue_id",
  "source_feedback_vote_id",
  "created_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  fv."company_id",
  'feedback_detected',
  'pending_review',
  CASE
    WHEN lower(coalesce(fv."reason", '')) ~ '(paperclip|guardrail|orchestrat|runtime|workspace|retry|wake|queue|routing|server|platform|system behavior|interface|button)' THEN 'orchestration_code'
    WHEN lower(coalesce(fv."reason", '')) ~ '(qa|quality check|acceptance criteria|validation|verify|review gate|reference image|source material)' THEN 'qa_gate'
    WHEN lower(coalesce(fv."reason", '')) ~ '(role|tone|voice|responsibilit|reporting line|agent prompt)' THEN 'agent_prompt'
    WHEN lower(coalesce(fv."reason", '')) ~ '(instruction|order|sop|procedure|workflow|playbook|skill|brand|client rule|company rule)' THEN 'company_skill'
    ELSE 'company_sop'
  END,
  'Review disliked output on ' || coalesce(i."identifier", left(i."title", 180)),
  CASE
    WHEN nullif(btrim(fv."reason"), '') IS NOT NULL THEN 'Board feedback: ' || btrim(fv."reason") || ' This historical feedback candidate is pending governance review.'
    ELSE 'The board marked this agent output as Needs work without an additional note. This historical feedback candidate is pending governance review.'
  END,
  'Review the linked feedback trace and route a durable fix to the appropriate company or Paperclip governance layer.',
  jsonb_build_array(
    jsonb_build_object('kind', 'feedback_vote', 'ref', fv."id"::text, 'note', coalesce(nullif(btrim(fv."reason"), ''), 'Needs work vote captured without a note.')),
    jsonb_build_object('kind', 'issue', 'ref', coalesce(i."identifier", i."id"::text), 'note', i."title")
  ),
  fv."issue_id",
  fv."id",
  fv."author_user_id",
  fv."created_at",
  fv."updated_at"
FROM "feedback_votes" fv
INNER JOIN "issues" i ON i."id" = fv."issue_id"
WHERE fv."vote" = 'down'
  AND NOT EXISTS (
    SELECT 1
    FROM "improvement_suggestions" existing
    WHERE existing."source_feedback_vote_id" = fv."id"
  );
