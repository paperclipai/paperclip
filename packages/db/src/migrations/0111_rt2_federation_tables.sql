-- Migration: 0111_rt2_federation_tables.sql
-- Phase 74: Federation and Cross-Company Evidence
-- FED-01: Cross-company federation evidence sharing contracts
-- FED-02: Per-company audit trail for cross-company evidence access

-- Federation Partners
CREATE TABLE rt2_federation_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  partner_company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  partnership_type text NOT NULL DEFAULT 'bidirectional',
  evidence_sharing_level text NOT NULL DEFAULT 'none',
  trust_level text NOT NULL DEFAULT 'unknown',
  policy_alignment jsonb NOT NULL DEFAULT '{"sharedAuditLogging":false,"crossCompanyApprovals":false,"evidenceContractSigned":false}',
  allowed_evidence_types jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz,
  last_renewed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX federation_partners_company_partner_idx ON rt2_federation_partners(company_id, partner_company_id);
CREATE INDEX federation_partners_company_status_idx ON rt2_federation_partners(company_id, status);
CREATE INDEX federation_partners_partner_company_idx ON rt2_federation_partners(partner_company_id);

-- Federation Evidence Contracts
CREATE TABLE rt2_federation_evidence_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_partner_id uuid NOT NULL REFERENCES rt2_federation_partners(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contract_type text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  evidence_types jsonb NOT NULL DEFAULT '[]',
  transformation_rules jsonb NOT NULL DEFAULT '{"redactAmounts":false,"redactNames":false,"aggregateQuality":false,"showTiersOnly":false}',
  audit_requirements jsonb NOT NULL DEFAULT '{"logAllAccess":true,"requireApprovalForAccess":false,"retainAuditDays":365}',
  contract_hash text,
  signed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX federation_contracts_partner_idx ON rt2_federation_evidence_contracts(federation_partner_id);
CREATE INDEX federation_contracts_company_idx ON rt2_federation_evidence_contracts(company_id);

-- Federation Audit Trails (FED-02: per-company isolated audit trail)
CREATE TABLE rt2_federation_audit_trails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  federation_partner_id uuid NOT NULL REFERENCES rt2_federation_partners(id),
  evidence_type text NOT NULL,
  evidence_id uuid,
  access_action text NOT NULL,
  access_result text NOT NULL,
  accessed_by_actor_id text,
  accessed_by_actor_type text,
  contract_id uuid REFERENCES rt2_federation_evidence_contracts(id),
  shared_data_summary jsonb NOT NULL DEFAULT '{}',
  redaction_notes text,
  access_network_info jsonb NOT NULL DEFAULT '{"ipAddress":"","userAgent":""}',
  accessed_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX federation_audit_company_accessed_idx ON rt2_federation_audit_trails(company_id, accessed_at);
CREATE INDEX federation_audit_partner_idx ON rt2_federation_audit_trails(federation_partner_id);
CREATE INDEX federation_audit_evidence_idx ON rt2_federation_audit_trails(evidence_type, evidence_id);
