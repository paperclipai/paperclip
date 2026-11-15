/**
 * Error messages and allowlisted strings for lifecycle commands (TECH-8191).
 */

export const LIFECYCLE_CLI_GENERIC_ERROR_MESSAGES: Record<string, string> = {
  FLIP_PRECONDITION_FAILED:
    "Flip refused before changing anything: staged rows are still unpublished, or a sweep would still find new or changed company-scoped memories. Run 'pnpm memory:upgrade publish' and 'pnpm memory:upgrade sweep' until both are clean, then retry. Nothing was flipped.",
  get flip_precondition_failed(): string {
    return this.FLIP_PRECONDITION_FAILED;
  },

  FLIP_MARKER_WRITE_FAILED:
    "Failed to write the scope migration marker. The upgrade is left in 'flipping'; re-run 'pnpm memory:upgrade flip' to resume. Flip is idempotent.",
  get flip_marker_write_failed(): string {
    return this.FLIP_MARKER_WRITE_FAILED;
  },

  FLIP_MARKER_MISSING:
    "The scope migration marker is not set, or does not match this upgrade's recorded flip time. Do not hand-edit scope_migration_completed_at; investigate before continuing.",
  get flip_marker_missing(): string {
    return this.FLIP_MARKER_MISSING;
  },

  AGENT_SCOPE_NOT_OBSERVED:
    "No agent-scoped memory use has been observed for this company since the flip. The marker alone changes nothing unless 'agent-scoped-mem0' is enabled for the processes running this company's agents.",
  get agent_scope_not_observed(): string {
    return this.AGENT_SCOPE_NOT_OBSERVED;
  },

  DRAIN_NOT_CONFIRMED:
    "Verify refused: drain has not been confirmed for this upgrade. Run 'pnpm memory:upgrade drain' first.",
  get drain_not_confirmed(): string {
    return this.DRAIN_NOT_CONFIRMED;
  },

  DRAIN_BLOCKED_MISSING_SCOPE:
    "Drain refused: the live collection contains memory rows with no 'user_id' scope. A catch-up sweep while draining only adopts company-scoped rows, so waiting cannot clear this. Investigate how unscoped rows were written, repair or remove them, then re-run 'pnpm memory:upgrade drain'. Nothing was changed.",
  get drain_blocked_missing_scope(): string {
    return this.DRAIN_BLOCKED_MISSING_SCOPE;
  },

  VERIFY_QUARANTINE_PRESENT:
    "Verify refused: quarantined sources remain in the ledger. Quarantined content never reached agent scope. Resolve them, or pass --allow-quarantined to accept the gap explicitly.",
  get verify_quarantine_present(): string {
    return this.VERIFY_QUARANTINE_PRESENT;
  },

  ROLLBACK_MARKER_CLEAR_FAILED:
    "Rollback refused: the scope migration marker could not be cleared. Nothing was changed and the upgrade state was not advanced; retry.",
  get rollback_marker_clear_failed(): string {
    return this.ROLLBACK_MARKER_CLEAR_FAILED;
  },

  RECOVER_LEASE_PRESENT:
    "Recover refused: the upgrade is in 'needs_recovery' but still holds a lease, which the lifecycle never produces. Nothing was changed. Do not hand-edit lease columns; investigate who wrote the lease, and wait for it to expire or have the owning worker release it before running recover.",
  get recover_lease_present(): string {
    return this.RECOVER_LEASE_PRESENT;
  },

  RECOVER_NOT_APPLIED:
    "Recover failed before anything changed: the upgrade is still in 'needs_recovery', its recover_to_state is intact, and no lease is held. Nothing was modified and no lease was left behind. Re-run 'pnpm memory:upgrade recover --company <uuid> --confirm <uuid>'.",
  get recover_not_applied(): string {
    return this.RECOVER_NOT_APPLIED;
  },

  RECOVER_OUTCOME_UNKNOWN:
    "Recover could not confirm its outcome: the control-plane database became unreachable and the upgrade row could not be re-read. Recovery is applied in one transaction, so the upgrade is either fully recovered and lease-free, or completely unchanged; it is never left half-recovered or holding a lease. Re-run 'pnpm memory:upgrade recover' once the control-plane database is reachable. If the recovery already landed, recover reports that the upgrade is no longer in 'needs_recovery' and changes nothing.",
  get recover_outcome_unknown(): string {
    return this.RECOVER_OUTCOME_UNKNOWN;
  },

  UPGRADE_TABLES_MISSING:
    "Upgrade staging or ledger table does not exist in target database. Run 'pnpm memory:upgrade sweep' first.",
  get upgrade_tables_missing(): string {
    return this.UPGRADE_TABLES_MISSING;
  },

  EXPORT_UPGRADE_ALREADY_PUBLISHED:
    "This upgrade has staging rows already published to the company collection; export supports unpublished upgrades only.",
  get export_upgrade_already_published(): string {
    return this.EXPORT_UPGRADE_ALREADY_PUBLISHED;
  },

  AMBIGUOUS_UPGRADE:
    "Multiple upgrade records exist for company. Please specify --upgrade-id <uuid>.",
  get ambiguous_upgrade(): string {
    return this.AMBIGUOUS_UPGRADE;
  },

  IMPORTER_CONTRACT_VIOLATION:
    "Importer contract violation detected in staging rows. Export aborted.",
  get importer_contract_violation(): string {
    return this.IMPORTER_CONTRACT_VIOLATION;
  },

  AGENT_NOT_FOUND:
    "Target agent record does not exist in control plane database for target company.",
  get agent_not_found(): string {
    return this.AGENT_NOT_FOUND;
  },

  AGENT_INELIGIBLE:
    "Target agent is not a memory-eligible hermes_local agent.",
  get agent_ineligible(): string {
    return this.AGENT_INELIGIBLE;
  },

  MALFORMED_PAYLOAD:
    "Malformed payload detected in staging rows. Export aborted.",
  get malformed_payload(): string {
    return this.MALFORMED_PAYLOAD;
  },

  PAYLOAD_USER_ID_MISMATCH:
    "Payload user_id does not match target agent. Export aborted.",
  get payload_user_id_mismatch(): string {
    return this.PAYLOAD_USER_ID_MISMATCH;
  },

  MANIFEST_HASH_MISMATCH:
    "JSONL SHA-256 checksum does not match manifest jsonl_sha256.",
  get manifest_hash_mismatch(): string {
    return this.MANIFEST_HASH_MISMATCH;
  },

  MANIFEST_RECORD_COUNT_MISMATCH:
    "JSONL record count does not match manifest record_count.",
  get manifest_record_count_mismatch(): string {
    return this.MANIFEST_RECORD_COUNT_MISMATCH;
  },

  RECORD_MANIFEST_MISMATCH:
    "JSONL record metadata does not match manifest.",
  get record_manifest_mismatch(): string {
    return this.RECORD_MANIFEST_MISMATCH;
  },

  FILTER_BUDGET_EXCEEDED:
    "Estimated or actual filter cost exceeds --max-cost-usd budget.",
  get filter_budget_exceeded(): string {
    return this.FILTER_BUDGET_EXCEEDED;
  },

  FILTER_INVALID_CLASSIFICATION:
    "LLM classifier returned unparseable or invalid classification.",
  get filter_invalid_classification(): string {
    return this.FILTER_INVALID_CLASSIFICATION;
  },

  FILTER_KEY_REQUIRED:
    "OpenAI API key required for non-dry-run execution.",
  get filter_key_required(): string {
    return this.FILTER_KEY_REQUIRED;
  },
};

export const LIFECYCLE_SAFE_STATE_MISMATCH_MESSAGES = [
  "Cannot run flip: active upgrade is not in sweeping or flipping state.",
  "Cannot run drain: active upgrade is not in draining state.",
  "Cannot run verify: active upgrade is not in draining or verified state.",
  "Cannot run rollback: active upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' first.",
  "Cannot run rollback: no flip has been performed for this upgrade.",
  "Cannot run recover: active upgrade is not in needs_recovery.",
  "No active memory upgrade for this company.",
  "Upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' first.",
  "Cannot run export: active upgrade is in needs_recovery. Run 'pnpm memory:upgrade recover' first.",
  "Cannot run export: active upgrade is in aborted state.",
] as const;

export const LIFECYCLE_SAFE_INVALID_ARGUMENT_EXACT_MESSAGES = [
  "Invalid --mode. Only 'copy' is supported.",
  "Flag '--ack-agent-scope-flag' is required for flip. The scope marker alone has no effect unless 'agent-scoped-mem0' is enabled for this company's agent processes.",
  "Invalid --max-drain-hours. Must be a positive number of hours not exceeding 168.",
  "Invalid --probe-interval-minutes. Must be an integer of at least 10.",
  "Confirmation company ID does not match target company ID.",
  "Flag --confirm <uuid> must strictly match --company <uuid>.",
  "Invalid --agent. Must be a valid UUID.",
  "Invalid --upgrade-id. Must be a valid UUID.",
  "Flag --company <uuid> is required for export.",
  "Flag --agent <uuid> is required for export.",
  "Flag --output-dir is required when --confirm is supplied.",
  "Flag --manifest <path> is required for filter.",
  "Flag --jsonl <path> is required for filter.",
  "Manifest file is not valid JSON.",
  "Manifest must be a JSON object.",
  "Manifest contains invalid UUID identifiers.",
  "Manifest jsonl_sha256 is missing or invalid SHA-256 hex string.",
  "Manifest record_count must be a non-negative integer.",
  "Flag --company does not match manifest company_id.",
  "Flag --agent does not match manifest agent_id.",
  "Flag --upgrade-id does not match manifest upgrade_id.",
  "Invalid --concurrency. Must be an integer between 1 and 16.",
] as const;
