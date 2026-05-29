ALTER TABLE "issue_relations" DROP CONSTRAINT IF EXISTS "issue_relations_type_check";--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_type_check" CHECK ("type" IN ('blocks', 'duplicateOf', 'supersededBy'));
