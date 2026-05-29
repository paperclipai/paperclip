-- Drop existing FK constraints and re-add with ON DELETE CASCADE so that
-- deleting a company row also removes its cost_events and projects rows
-- instead of failing with a foreign key violation (GH#6419 / PAP-46).

ALTER TABLE "cost_events"
  DROP CONSTRAINT IF EXISTS "cost_events_company_id_companies_id_fk",
  ADD CONSTRAINT "cost_events_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;

ALTER TABLE "projects"
  DROP CONSTRAINT IF EXISTS "projects_company_id_companies_id_fk",
  ADD CONSTRAINT "projects_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
