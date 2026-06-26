import { describe, expect, it } from "vitest";
import {
  classifyProofLedgerEntry,
  classifyUnboundSecret,
  SELF_DOCUMENTING_PROOF_ORIGIN_KINDS,
  severityForNonEmptyCategory,
} from "../services/ceo-control-room.ts";

describe("CEO control-room secret classification", () => {
  it("treats a non-active secret as a genuine missing secret", () => {
    expect(classifyUnboundSecret({ status: "revoked", managedMode: "paperclip_managed" })).toEqual({
      type: "secret_missing",
      descriptor: "revoked",
    });
    expect(classifyUnboundSecret({ status: "pending", managedMode: "external_reference" }).type).toBe("secret_missing");
  });

  it("treats an active external_reference pointer as a legacy/external ref, not a missing secret", () => {
    const result = classifyUnboundSecret({ status: "active", managedMode: "external_reference" });
    expect(result.type).toBe("secret_external_ref");
    expect(result.descriptor).toContain("outside Paperclip");
  });

  it("treats an active managed-but-unbound secret as registered-not-wired", () => {
    expect(classifyUnboundSecret({ status: "active", managedMode: "paperclip_managed" }).type).toBe("secret_unbound");
    expect(classifyUnboundSecret({ status: "active", managedMode: null }).type).toBe("secret_unbound");
  });
});

describe("CEO control-room proof-ledger classification", () => {
  const base = { status: "done", executionRunId: null, workProductCount: 0, originKind: "manual" };

  it("links proof when a work product or execution run exists", () => {
    expect(classifyProofLedgerEntry({ ...base, workProductCount: 1 })).toBe("proof_linked");
    expect(classifyProofLedgerEntry({ ...base, executionRunId: "run-1" })).toBe("proof_linked");
  });

  it("treats in_review work without an artifact as pending, not missing", () => {
    expect(classifyProofLedgerEntry({ ...base, status: "in_review" })).toBe("proof_pending");
  });

  it("treats self-documenting origins as indirect proof, not a ledger gap", () => {
    for (const originKind of SELF_DOCUMENTING_PROOF_ORIGIN_KINDS) {
      expect(classifyProofLedgerEntry({ ...base, originKind })).toBe("proof_indirect");
    }
  });

  it("flags closed substantive work with no artifact as the real ledger gap", () => {
    expect(classifyProofLedgerEntry({ ...base, originKind: "manual" })).toBe("proof_missing");
    expect(classifyProofLedgerEntry({ ...base, originKind: "operator_assignment" })).toBe("proof_missing");
    expect(classifyProofLedgerEntry({ ...base, originKind: null })).toBe("proof_missing");
  });
});

describe("CEO control-room category severity", () => {
  it("does not escalate missing_secret when only external refs / unbound items are present", () => {
    expect(
      severityForNonEmptyCategory("missing_secret", [
        { type: "secret_external_ref" },
        { type: "secret_unbound" },
      ]),
    ).toBe("info");
  });

  it("escalates missing_secret only for genuine missing secrets or reported issues", () => {
    expect(severityForNonEmptyCategory("missing_secret", [{ type: "secret_external_ref" }, { type: "secret_missing" }])).toBe("warning");
    expect(severityForNonEmptyCategory("missing_secret", [{ type: "issue" }])).toBe("warning");
  });

  it("escalates proof_ledger only when a real proof gap exists", () => {
    expect(severityForNonEmptyCategory("proof_ledger", [{ type: "proof_indirect" }, { type: "proof_pending" }, { type: "proof_linked" }])).toBe("info");
    expect(severityForNonEmptyCategory("proof_ledger", [{ type: "proof_indirect" }, { type: "proof_missing" }])).toBe("warning");
  });

  it("preserves existing severities for the other categories", () => {
    expect(severityForNonEmptyCategory("agent_conveyor", [{ type: "lane_ready" }])).toBe("info");
    expect(severityForNonEmptyCategory("agent_conveyor", [{ type: "lane_attention" }])).toBe("warning");
    expect(severityForNonEmptyCategory("promotion_candidate", [{ type: "issue" }])).toBe("info");
    expect(severityForNonEmptyCategory("spend_cap", [{ type: "budget" }])).toBe("critical");
    expect(severityForNonEmptyCategory("operational_loop", [{ type: "routine_repeat" }])).toBe("critical");
    expect(severityForNonEmptyCategory("blocked_by_human", [{ type: "issue" }])).toBe("warning");
    expect(severityForNonEmptyCategory("worker_offline", [{ type: "agent" }])).toBe("warning");
  });
});

// Documented evidence: the live fincli.ai board snapshot (2026-06-26). Before this change the
// CEO Control Room raised a warning for 9 "missing" secrets and 8 "proof_missing" issues.
// With honest classification, missing_secret carries no genuine gap (all active external refs /
// unbound), and proof_ledger narrows to the 3 substantive manual issues that truly lack proof.
describe("CEO control-room fincli.ai snapshot (documented false-warning regression guard)", () => {
  it("classifies the live unbound secrets as info, not a missing-secret warning", () => {
    const liveSecrets = [
      { key: "ibkr_gateway_session_ref", status: "active", managedMode: "external_reference" },
      { key: "ibkr_paper_account_ref", status: "active", managedMode: "external_reference" },
      { key: "tradier_sandbox_token_ref", status: "active", managedMode: "external_reference" },
      { key: "r2_cps_artifact_writer_ref", status: "active", managedMode: "external_reference" },
      { key: "cloudflare_api_token_ref", status: "active", managedMode: "external_reference" },
      { key: "vast_api_token_ref", status: "active", managedMode: "external_reference" },
      { key: "board_fincli_access_token_ref", status: "active", managedMode: "external_reference" },
      { key: "board_fincli_api_base_url", status: "active", managedMode: "paperclip_managed" },
      { key: "x-apo-key", status: "active", managedMode: "paperclip_managed" },
    ];
    const items = liveSecrets.map((s) => ({ type: classifyUnboundSecret(s).type }));
    expect(items.filter((i) => i.type === "secret_external_ref")).toHaveLength(7);
    expect(items.filter((i) => i.type === "secret_unbound")).toHaveLength(2);
    expect(items.some((i) => i.type === "secret_missing")).toBe(false);
    expect(severityForNonEmptyCategory("missing_secret", items)).toBe("info");
  });

  it("narrows the live proof-ledger gap to the 3 substantive issues that truly lack proof", () => {
    const liveProofIssues = [
      { id: "MIC-216", status: "done", executionRunId: null, workProductCount: 0, originKind: "issue_productivity_review" },
      { id: "MIC-212", status: "in_review", executionRunId: null, workProductCount: 1, originKind: "manual" },
      { id: "MIC-214", status: "done", executionRunId: null, workProductCount: 0, originKind: "manual" },
      { id: "MIC-213", status: "done", executionRunId: null, workProductCount: 0, originKind: "manual" },
      { id: "MIC-186", status: "done", executionRunId: null, workProductCount: 0, originKind: "routine_execution" },
      { id: "MIC-192", status: "done", executionRunId: null, workProductCount: 0, originKind: "routine_execution" },
      { id: "MIC-211", status: "done", executionRunId: null, workProductCount: 0, originKind: "routine_execution" },
      { id: "MIC-208", status: "done", executionRunId: null, workProductCount: 0, originKind: "manual" },
      { id: "MIC-209", status: "done", executionRunId: null, workProductCount: 0, originKind: "issue_productivity_review" },
      { id: "MIC-207", status: "done", executionRunId: null, workProductCount: 1, originKind: "manual" },
    ];
    const items = liveProofIssues.map((row) => ({ id: row.id, type: classifyProofLedgerEntry(row) }));
    const missing = items.filter((i) => i.type === "proof_missing").map((i) => i.id);
    expect(missing).toEqual(["MIC-214", "MIC-213", "MIC-208"]);
    expect(items.filter((i) => i.type === "proof_indirect")).toHaveLength(5);
    expect(items.filter((i) => i.type === "proof_linked")).toHaveLength(2);
    // Real (smaller) gap remains a warning — honest, not suppressed.
    expect(severityForNonEmptyCategory("proof_ledger", items)).toBe("warning");
  });
});
