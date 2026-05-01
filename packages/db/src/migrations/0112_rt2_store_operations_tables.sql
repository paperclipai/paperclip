-- Migration: 0112_rt2_store_operations_tables.sql
-- Phase 76: Public Store Operations
-- STORE-01: Metadata management evidence for App Store/Google Play/metastore presence
-- STORE-02: Store reviewer communication and status tracking via company-scoped audit trail

-- Store Listings (STORE-01: metadata management)
CREATE TABLE rt2_store_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  store_type text NOT NULL,
  listing_status text NOT NULL DEFAULT 'draft',
  store_app_id text,
  store_url text,
  app_name text,
  app_description text,
  category text,
  tags jsonb NOT NULL DEFAULT '[]',
  metadata jsonb NOT NULL DEFAULT '{}',
  latest_reviewer_comment text,
  latest_reviewer_comment_at timestamptz,
  current_review_status text,
  submitted_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX rt2_store_listings_company_status_idx ON rt2_store_listings(company_id, listing_status);
CREATE INDEX rt2_store_listings_store_type_idx ON rt2_store_listings(store_type);

-- Store Reviewer Communications (STORE-02: reviewer communication threads)
CREATE TABLE rt2_store_reviewer_communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_listing_id uuid NOT NULL REFERENCES rt2_store_listings(id) ON DELETE CASCADE,
  thread_subject text NOT NULL,
  thread_status text NOT NULL DEFAULT 'open',
  last_message_at timestamptz,
  last_message_by text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX rt2_store_reviewer_communications_company_listing_idx ON rt2_store_reviewer_communications(company_id, store_listing_id);
CREATE INDEX rt2_store_reviewer_communications_thread_status_idx ON rt2_store_reviewer_communications(thread_status);

-- Store Reviewer Messages (STORE-02: individual messages in threads)
CREATE TABLE rt2_store_reviewer_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_listing_id uuid NOT NULL REFERENCES rt2_store_listings(id) ON DELETE CASCADE,
  communication_id uuid NOT NULL REFERENCES rt2_store_reviewer_communications(id) ON DELETE CASCADE,
  sender_type text NOT NULL,
  sender_actor_id text,
  message_content text NOT NULL,
  message_type text NOT NULL DEFAULT 'text',
  attachment_urls jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX rt2_store_reviewer_messages_communication_idx ON rt2_store_reviewer_messages(communication_id);
CREATE INDEX rt2_store_reviewer_messages_company_created_idx ON rt2_store_reviewer_messages(company_id, created_at);

-- Store Audit Trails (STORE-02: company-scoped audit trail)
CREATE TABLE rt2_store_audit_trails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_listing_id uuid REFERENCES rt2_store_listings(id) ON DELETE SET NULL,
  action text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX rt2_store_audit_trails_company_created_idx ON rt2_store_audit_trails(company_id, created_at);
CREATE INDEX rt2_store_audit_trails_listing_idx ON rt2_store_audit_trails(store_listing_id);
CREATE INDEX rt2_store_audit_trails_action_idx ON rt2_store_audit_trails(action);
