-- Migration: 0110_rt2_payroll_settlement_tables
-- Phase 73: Billing, Payroll, and Settlement
-- BILL-01: Settlement auto-processing tracking columns
-- BILL-02: Payroll run and payroll run entries tables
-- BILL-03: Payment receipts and settlement reconciliation tables

-- ============================================================================
-- BILL-01: Add processed_at and auto_processed to rt2_settlement_governance
-- ============================================================================
ALTER TABLE rt2_settlement_governance
  ADD COLUMN processed_at timestamptz,
  ADD COLUMN auto_processed integer NOT NULL DEFAULT 0;

CREATE INDEX rt2_settlement_processed_idx
  ON rt2_settlement_governance (company_id, processed_at);

-- ============================================================================
-- BILL-02: rt2_payroll_runs — monthly payroll batch run records
-- ============================================================================
CREATE TABLE rt2_payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  total_gross_gold integer NOT NULL DEFAULT 0,
  total_net_gold integer NOT NULL DEFAULT 0,
  total_deductions_gold integer NOT NULL DEFAULT 0,
  actor_count integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX rt2_payroll_runs_company_period_uq
  ON rt2_payroll_runs (company_id, period);
CREATE INDEX rt2_payroll_runs_company_status_idx
  ON rt2_payroll_runs (company_id, status);
CREATE INDEX rt2_payroll_runs_period_idx
  ON rt2_payroll_runs (period);

-- ============================================================================
-- BILL-02: rt2_payroll_run_entries — per-actor payroll breakdown
-- ============================================================================
CREATE TABLE rt2_payroll_run_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id uuid NOT NULL REFERENCES rt2_payroll_runs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id),
  actor_id text NOT NULL,
  actor_type text NOT NULL,
  gross_gold integer NOT NULL DEFAULT 0,
  platform_fee_gold integer NOT NULL DEFAULT 0,
  operational_fee_gold integer NOT NULL DEFAULT 0,
  total_deductions_gold integer NOT NULL DEFAULT 0,
  net_gold integer NOT NULL DEFAULT 0,
  ledger_entry_id uuid,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rt2_payroll_run_entries_run_idx
  ON rt2_payroll_run_entries (payroll_run_id);
CREATE INDEX rt2_payroll_run_entries_company_actor_idx
  ON rt2_payroll_run_entries (company_id, actor_id);

-- ============================================================================
-- BILL-03: rt2_payment_receipts — external payment provider evidence
-- ============================================================================
CREATE TABLE rt2_payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id uuid REFERENCES rt2_payroll_runs(id),
  settlement_id uuid REFERENCES rt2_settlement_governance(id),
  provider_reference text NOT NULL,
  provider_name text NOT NULL DEFAULT 'internal',
  amount integer NOT NULL,
  currency text NOT NULL DEFAULT 'GOLD',
  status text NOT NULL DEFAULT 'pending',
  paid_at timestamptz,
  reconciled_at timestamptz,
  reconciliation_notes text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rt2_payment_receipts_company_idx
  ON rt2_payment_receipts (company_id);
CREATE INDEX rt2_payment_receipts_settlement_idx
  ON rt2_payment_receipts (settlement_id);
CREATE INDEX rt2_payment_receipts_payroll_run_idx
  ON rt2_payment_receipts (payroll_run_id);
CREATE UNIQUE INDEX rt2_payment_receipts_provider_ref_uq
  ON rt2_payment_receipts (company_id, provider_reference);
CREATE INDEX rt2_payment_receipts_status_idx
  ON rt2_payment_receipts (company_id, status);

-- ============================================================================
-- BILL-03: rt2_settlement_reconciliation — ledger ↔ receipt linking
-- ============================================================================
CREATE TABLE rt2_settlement_reconciliation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL REFERENCES rt2_settlement_governance(id),
  payment_receipt_id uuid NOT NULL REFERENCES rt2_payment_receipts(id),
  ledger_entry_id uuid,
  amount_matched integer NOT NULL DEFAULT 0,
  discrepancy_gold integer NOT NULL DEFAULT 0,
  reconciliation_status text NOT NULL DEFAULT 'matched',
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX rt2_settlement_reconciliation_settlement_uq
  ON rt2_settlement_reconciliation (settlement_id);
CREATE INDEX rt2_settlement_reconciliation_receipt_idx
  ON rt2_settlement_reconciliation (payment_receipt_id);
CREATE INDEX rt2_settlement_reconciliation_status_idx
  ON rt2_settlement_reconciliation (company_id, reconciliation_status);
