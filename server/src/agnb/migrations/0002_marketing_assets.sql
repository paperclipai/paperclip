-- AGNB migration 0002 — marketing_assets + filled_assets (recreate from backup).
--
-- These two tables (the Assets page's storage) were restored wholesale via the
-- Supabase `pg_dump` and had NO in-repo DDL, so a clean rebuild / fresh instance
-- / disaster recovery had nothing to run. This migration closes that gap.
-- Idempotent, schema-qualified to `agnb`. See docs/migration/AGNB_CONSOLIDATION.md.
--
-- Structure mirrors the live tables exactly (column order, types, defaults,
-- PK/unique/FK) per the cold backup's schema.json. Enum domains:
--   asset_stage  — the app's validated funnel set (groups/marketing.ts).
--   asset_status — draft | active | archived (app domain).
--   asset_kind   — reconstructed from backup data (10 observed kinds + 'other'
--                  default). VERIFY against prod if kinds were added since the
--                  backup; the UI free-texts `kind`, so the enum must cover any
--                  value the create form can send (see follow-up note).

CREATE SCHEMA IF NOT EXISTS agnb;

DO $$ BEGIN
  CREATE TYPE agnb.asset_stage AS ENUM
    ('awareness', 'interest', 'evaluation', 'decision', 'onboard', 'retention');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agnb.asset_status AS ENUM ('draft', 'active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agnb.asset_kind AS ENUM (
    'one_pager', 'email_template', 'case_study', 'battlecard',
    'objection_handler', 'security_qna', 'proposal', 'pitch_deck',
    'contract_sow', 'contract_msa', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS agnb.marketing_assets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  stage      agnb.asset_stage NOT NULL,
  kind       agnb.asset_kind NOT NULL DEFAULT 'other',
  html       text NOT NULL,
  variables  jsonb NOT NULL DEFAULT '[]'::jsonb,
  status     agnb.asset_status NOT NULL DEFAULT 'draft',
  version    integer NOT NULL DEFAULT 1,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS agnb.filled_assets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES agnb.marketing_assets (id),
  customer_name  text,
  variables_used jsonb NOT NULL DEFAULT '{}'::jsonb,
  html_rendered  text NOT NULL,
  bucket_id      uuid,
  shared_token   text UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL
);

-- filled_assets.bucket_id → experiment_buckets. Added only when that table is
-- present, so this migration doesn't impose a creation-order dependency during a
-- cold rebuild (the bucket linkage is unused by the current Assets UI).
DO $$ BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'agnb' AND table_name = 'experiment_buckets'
     ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'filled_assets_bucket_id_fkey'
     )
  THEN
    ALTER TABLE agnb.filled_assets
      ADD CONSTRAINT filled_assets_bucket_id_fkey
      FOREIGN KEY (bucket_id) REFERENCES agnb.experiment_buckets (id);
  END IF;
END $$;
