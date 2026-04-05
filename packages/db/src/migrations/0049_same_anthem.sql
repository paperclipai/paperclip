ALTER TABLE "companies"
ADD COLUMN "organization_mode" text DEFAULT 'company' NOT NULL
CHECK ("organization_mode" IN ('company', 'team'));
