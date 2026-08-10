ALTER TABLE "companies" ALTER COLUMN "attachment_max_bytes" SET DEFAULT 31457280;
--> statement-breakpoint
UPDATE "companies"
SET "attachment_max_bytes" = 31457280
WHERE "attachment_max_bytes" < 31457280;
