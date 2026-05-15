-- Rollback:
--   ALTER TABLE "niche_opportunities" DROP CONSTRAINT IF EXISTS "niche_opp_company_category_keyword_uq";

-- Remove duplicate rows, keeping the row with the latest created_at
-- (id DESC as tiebreaker) for each (company_id, category_path, head_keyword) group.
DELETE FROM "niche_opportunities"
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, category_path, head_keyword) id
  FROM "niche_opportunities"
  ORDER BY company_id, category_path, head_keyword, created_at DESC, id DESC
);
--> statement-breakpoint

-- Prevent future duplicates within the same company.
ALTER TABLE "niche_opportunities"
  ADD CONSTRAINT "niche_opp_company_category_keyword_uq"
  UNIQUE ("company_id", "category_path", "head_keyword");
