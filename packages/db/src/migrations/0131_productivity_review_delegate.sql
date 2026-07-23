ALTER TABLE "companies" ADD COLUMN "productivity_review_delegate_agent_id" uuid;
--> statement-breakpoint
UPDATE "companies"
SET "productivity_review_delegate_agent_id" = '63f378b4-1d43-417e-8eb7-7aa2e96e8cce'
WHERE "id" = '1dc911ed-ff05-4072-b2ae-a3e3177e3873';
