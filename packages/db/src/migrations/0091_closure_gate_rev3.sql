-- Migration: closure gate schema rev 3 (UPG-840)
-- Adds audit_flag column, makes override_reason nullable, adds check constraint.
ALTER TABLE "issue_closure_gate_overrides" ADD COLUMN "audit_flag" text;--> statement-breakpoint
ALTER TABLE "issue_closure_gate_overrides" ALTER COLUMN "override_reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_closure_gate_overrides" ADD CONSTRAINT "check_cgo_reason_or_flag" CHECK ((override_reason IS NOT NULL) OR (audit_flag IS NOT NULL));
