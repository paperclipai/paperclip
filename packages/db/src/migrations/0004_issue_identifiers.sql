-- Add issue identifier columns to companies
ALTER TABLE "companies" ADD COLUMN "issue_prefix" text NOT NULL DEFAULT 'PAP';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "issue_counter" integer NOT NULL DEFAULT 0;--> statement-breakpoint

-- Add issue identifier columns to issues
ALTER TABLE "issues" ADD COLUMN "issue_number" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "identifier" text;--> statement-breakpoint

-- Backfill existing issues: assign sequential issue_number per company ordered by created_at
WITH numbered AS (
  SELECT id, company_id, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at ASC) AS rn
  FROM issues
)
UPDATE issues
SET issue_number = numbered.rn,
    identifier = (SELECT issue_prefix FROM companies WHERE companies.id = issues.company_id) || '-' || numbered.rn
FROM numbered
WHERE issues.id = numbered.id;--> statement-breakpoint

-- Sync each company's issue_counter to the max assigned number
UPDATE companies
SET issue_counter = COALESCE(
  (SELECT MAX(issue_number) FROM issues WHERE issues.company_id = companies.id),
  0
);--> statement-breakpoint

-- Create unique index on (company_id, identifier)
CREATE UNIQUE INDEX "issues_company_identifier_idx" ON "issues" USING btree ("company_id","identifier");
