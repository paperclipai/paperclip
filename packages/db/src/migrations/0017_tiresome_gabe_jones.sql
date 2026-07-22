DROP INDEX "issues_company_identifier_idx";--> statement-breakpoint

-- Rebuild issue prefixes to be company-specific and globally unique.
-- Base prefix is first 3 letters of company name (A-Z only), fallback "CMP".
-- Duplicate bases receive deterministic letter suffixes: PAP, PAPA, PAPAA, ...
WITH ranked_companies AS (
  SELECT
    c.id,
    COALESCE(NULLIF(SUBSTRING(REGEXP_REPLACE(UPPER(c.name), '[^A-Z]', '', 'g') FROM 1 FOR 3), ''), 'CMP') AS base_prefix,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(NULLIF(SUBSTRING(REGEXP_REPLACE(UPPER(c.name), '[^A-Z]', '', 'g') FROM 1 FOR 3), ''), 'CMP')
      ORDER BY c.created_at, c.id
    ) AS prefix_rank
  FROM companies c
)
UPDATE companies c
SET issue_prefix = CASE
  WHEN ranked_companies.prefix_rank = 1 THEN ranked_companies.base_prefix
  ELSE ranked_companies.base_prefix || REPEAT('A', (ranked_companies.prefix_rank - 1)::integer)
END
FROM ranked_companies
WHERE c.id = ranked_companies.id;--> statement-breakpoint

-- Reassign issue numbers sequentially per company to guarantee uniqueness.
WITH numbered_issues AS (
  SELECT
    i.id,
    ROW_NUMBER() OVER (PARTITION BY i.company_id ORDER BY i.created_at, i.id) AS issue_number
  FROM issues i
)
UPDATE issues i
SET issue_number = numbered_issues.issue_number
FROM numbered_issues
WHERE i.id = numbered_issues.id;--> statement-breakpoint

-- Rebuild identifiers from normalized prefix + issue number.
UPDATE issues i
SET identifier = c.issue_prefix || '-' || i.issue_number
FROM companies c
WHERE c.id = i.company_id;--> statement-breakpoint

-- Sync counters to the largest issue number currently assigned per company.
UPDATE companies c
SET issue_counter = COALESCE((
  SELECT MAX(i.issue_number)
  FROM issues i
  WHERE i.company_id = c.id
), 0);--> statement-breakpoint

CREATE UNIQUE INDEX "companies_issue_prefix_idx" ON "companies" USING btree ("issue_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_identifier_idx" ON "issues" USING btree ("identifier");
