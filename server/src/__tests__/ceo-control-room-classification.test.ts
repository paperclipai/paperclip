import { describe, expect, it } from "vitest";
import {
  classifyConveyorLane,
  classifyProofLedgerEntry,
  classifyUnboundSecret,
  classifyWorkerOfflineAgent,
  CONVEYOR_LANE_ORDER,
  CONVEYOR_RUN_FAILURE_STATUSES,
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

describe("CEO control-room worker-offline agent classification", () => {
  // Every variant the heartbeat reaper emits via buildProcessLossMessage (heartbeat.ts) — each is
  // a run orphaned because its OS process vanished (server restart / reaped in-flight run). These
  // are recoverable stale artifacts, not a worker that is genuinely down.
  const processLostReasons = [
    "Process lost -- server may have restarted",
    "Process lost -- child pid 4242 is no longer running",
    "Process lost -- process group 4242 is no longer running",
    "Process lost -- parent pid 4242 exited, but descendant process group 4343 was still alive and was terminated",
    "Process lost -- server may have restarted; retrying once",
  ];

  it("treats an error agent pinned by a reaped/orphaned run as a recoverable process-lost state", () => {
    for (const errorReason of processLostReasons) {
      expect(classifyWorkerOfflineAgent({ status: "error", errorReason })).toBe("agent_process_lost");
    }
  });

  it("treats a descriptive (non process-lost) error reason as a genuinely offline worker", () => {
    expect(classifyWorkerOfflineAgent({ status: "error", errorReason: "vault provider is not configured in this instance" })).toBe("agent_offline");
    expect(classifyWorkerOfflineAgent({ status: "error", errorReason: "adapter command exited with code 1" })).toBe("agent_offline");
    expect(classifyWorkerOfflineAgent({ status: "error", errorReason: "heartbeat run timed out" })).toBe("agent_offline");
  });

  it("does not suppress an error with an unknown/missing reason — conservatively genuine offline", () => {
    expect(classifyWorkerOfflineAgent({ status: "error", errorReason: null })).toBe("agent_offline");
    expect(classifyWorkerOfflineAgent({ status: "error", errorReason: "" })).toBe("agent_offline");
  });

  it("never reclassifies a non-error (e.g. paused) agent as a process-lost orphan", () => {
    // A paused agent carries pauseReason, not errorReason; even a stale process-lost string must
    // not downgrade it because the status, not the reason, is the genuine signal.
    expect(classifyWorkerOfflineAgent({ status: "paused", errorReason: "Process lost -- server may have restarted" })).toBe("agent_offline");
    expect(classifyWorkerOfflineAgent({ status: "paused", errorReason: null })).toBe("agent_offline");
  });
});

describe("CEO control-room conveyor lane classification", () => {
  it("flags an errored or paused agent as attention regardless of its latest run", () => {
    expect(classifyConveyorLane({ agentStatus: "error", latestRunStatus: "succeeded" })).toBe("lane_attention");
    expect(classifyConveyorLane({ agentStatus: "paused", latestRunStatus: null })).toBe("lane_attention");
    expect(classifyConveyorLane({ agentStatus: "error", latestRunStatus: "cancelled" })).toBe("lane_attention");
  });

  it("flags a failed latest run as attention", () => {
    expect(classifyConveyorLane({ agentStatus: "idle", latestRunStatus: "failed" })).toBe("lane_attention");
  });

  it("flags a timed_out latest run as attention (regression: previously hidden as ready)", () => {
    expect(CONVEYOR_RUN_FAILURE_STATUSES.has("timed_out")).toBe(true);
    expect(classifyConveyorLane({ agentStatus: "idle", latestRunStatus: "timed_out" })).toBe("lane_attention");
    // Severity must escalate so the timeout is not suppressed.
    expect(severityForNonEmptyCategory("agent_conveyor", [{ type: classifyConveyorLane({ agentStatus: "idle", latestRunStatus: "timed_out" }) }])).toBe("warning");
  });

  it("treats a cancelled latest run as an intentional stop, not attention", () => {
    expect(classifyConveyorLane({ agentStatus: "idle", latestRunStatus: "cancelled" })).toBe("lane_cancelled");
  });

  it("treats an agent with no recent run as idle, distinct from a ready lane", () => {
    expect(classifyConveyorLane({ agentStatus: "idle", latestRunStatus: null })).toBe("lane_idle");
  });

  it("treats succeeded / running / queued lanes as ready", () => {
    expect(classifyConveyorLane({ agentStatus: "idle", latestRunStatus: "succeeded" })).toBe("lane_ready");
    expect(classifyConveyorLane({ agentStatus: "active", latestRunStatus: "running" })).toBe("lane_ready");
    expect(classifyConveyorLane({ agentStatus: "idle", latestRunStatus: "queued" })).toBe("lane_ready");
  });

  it("orders lanes attention → cancelled → idle → ready so actionable lanes lead", () => {
    const types = ["lane_ready", "lane_idle", "lane_cancelled", "lane_attention"] as const;
    const sorted = [...types].sort((a, b) => CONVEYOR_LANE_ORDER[a] - CONVEYOR_LANE_ORDER[b]);
    expect(sorted).toEqual(["lane_attention", "lane_cancelled", "lane_idle", "lane_ready"]);
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

  it("does not escalate worker_offline when only stale process-lost orphans are present", () => {
    expect(severityForNonEmptyCategory("worker_offline", [{ type: "agent_process_lost" }])).toBe("info");
    expect(
      severityForNonEmptyCategory("worker_offline", [
        { type: "agent_process_lost" },
        { type: "agent_process_lost" },
      ]),
    ).toBe("info");
  });

  it("does not escalate agent_conveyor for cancelled / idle / ready lanes", () => {
    expect(
      severityForNonEmptyCategory("agent_conveyor", [
        { type: "lane_cancelled" },
        { type: "lane_idle" },
        { type: "lane_ready" },
      ]),
    ).toBe("info");
  });

  it("escalates worker_offline for genuine offline / stalled / source-unavailable conditions", () => {
    // A genuinely offline/failing worker stays a warning.
    expect(severityForNonEmptyCategory("worker_offline", [{ type: "agent_offline" }])).toBe("warning");
    // A stalled heartbeat run (no output past the threshold) stays a warning.
    expect(severityForNonEmptyCategory("worker_offline", [{ type: "run" }])).toBe("warning");
    // An unavailable external source stays a warning.
    expect(severityForNonEmptyCategory("worker_offline", [{ type: "source" }])).toBe("warning");
    // Mixed: a single genuine offline alongside stale orphans is NOT suppressed.
    expect(
      severityForNonEmptyCategory("worker_offline", [
        { type: "agent_process_lost" },
        { type: "agent_offline" },
      ]),
    ).toBe("warning");
  });

  it("escalates agent_conveyor only when a genuine attention lane is present", () => {
    expect(
      severityForNonEmptyCategory("agent_conveyor", [
        { type: "lane_cancelled" },
        { type: "lane_idle" },
        { type: "lane_attention" },
        { type: "lane_ready" },
      ]),
    ).toBe("warning");
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

  // Documented evidence: on 2026-06-25 a Paperclip server restart reaped both heartbeat-disabled
  // workers' in-flight runs, pinning each to status=error / "Process lost -- server may have
  // restarted". With heartbeat off nothing re-ran them, so the board showed a permanent
  // worker_offline WARNING for 2 agents that were actually healthy (Local Worker SRE had 26/30
  // successful runs). These are stale restart artifacts, not genuine outages.
  it("classifies the two restart-orphaned workers as info, not a worker-offline warning", () => {
    const liveOrphanedAgents = [
      // Local Worker SRE (5aa6aa3a-...): healthy run history, only orphaned by the restart.
      { name: "Local Worker SRE", status: "error", errorReason: "Process lost -- server may have restarted" },
      // Paperclip Platform Engineer (e8f113e8-...): current pin is the restart orphan.
      { name: "Paperclip Platform Engineer", status: "error", errorReason: "Process lost -- server may have restarted" },
    ];
    const items = liveOrphanedAgents.map((a) => ({ type: classifyWorkerOfflineAgent(a) }));
    expect(items.every((i) => i.type === "agent_process_lost")).toBe(true);
    expect(severityForNonEmptyCategory("worker_offline", items)).toBe("info");
  });

  it("keeps a genuine worker fault (e.g. unconfigured vault provider) a worker-offline warning", () => {
    // The Platform Engineer also has a distinct, latent config fault: dispatching it fails with
    // "vault provider is not configured in this instance". If it surfaces as an error, it must
    // remain a warning — the new classifier suppresses only the stale restart orphan, never this.
    const genuineFault = { name: "Paperclip Platform Engineer", status: "error", errorReason: "vault provider is not configured in this instance" };
    expect(classifyWorkerOfflineAgent(genuineFault)).toBe("agent_offline");
    const mixed = [
      { type: classifyWorkerOfflineAgent({ status: "error", errorReason: "Process lost -- server may have restarted" }) },
      { type: classifyWorkerOfflineAgent(genuineFault) },
    ];
    expect(severityForNonEmptyCategory("worker_offline", mixed)).toBe("warning");
  });
});

// Documented evidence: the live fincli.ai conveyor snapshot (2026-06-26). 40 conveyor agents.
// Before this change a cancelled run counted as attention (false warning) and a timed_out run
// would have been hidden as ready (suppressed failure). After honest classification the warning
// is attributable to exactly the 2 genuinely-errored lanes; cancelled/idle/ready are info.
describe("CEO control-room conveyor snapshot (false-warning regression guard)", () => {
  const buildLanes = () => {
    const lanes: Array<{ agentStatus: string; latestRunStatus: string | null }> = [];
    // 2 hermes lanes whose agent is errored with a failed latest run — genuine attention.
    for (let i = 0; i < 2; i++) lanes.push({ agentStatus: "error", latestRunStatus: "failed" });
    // 2 lanes whose latest run was intentionally cancelled — not attention.
    for (let i = 0; i < 2; i++) lanes.push({ agentStatus: "idle", latestRunStatus: "cancelled" });
    // 30 idle lanes with no recent run.
    for (let i = 0; i < 30; i++) lanes.push({ agentStatus: "idle", latestRunStatus: null });
    // 6 healthy lanes whose latest run succeeded.
    for (let i = 0; i < 6; i++) lanes.push({ agentStatus: "idle", latestRunStatus: "succeeded" });
    return lanes;
  };

  it("attributes the warning to exactly the 2 real failures, demoting cancelled/idle/ready", () => {
    const items = buildLanes().map((lane) => ({ type: classifyConveyorLane(lane) }));
    expect(items).toHaveLength(40);
    expect(items.filter((i) => i.type === "lane_attention")).toHaveLength(2);
    expect(items.filter((i) => i.type === "lane_cancelled")).toHaveLength(2);
    expect(items.filter((i) => i.type === "lane_idle")).toHaveLength(30);
    expect(items.filter((i) => i.type === "lane_ready")).toHaveLength(6);
    // Warning is preserved (the 2 errored lanes are not suppressed)…
    expect(severityForNonEmptyCategory("agent_conveyor", items)).toBe("warning");
    // …and is driven ONLY by the 2 attention lanes: without them the board is info, not warning.
    const withoutFailures = items.filter((i) => i.type !== "lane_attention");
    expect(withoutFailures).toHaveLength(38);
    expect(severityForNonEmptyCategory("agent_conveyor", withoutFailures)).toBe("info");
  });

  it("would catch a timed_out latest run that the old failed/cancelled-only check hid", () => {
    // Swap one ready lane for a timed_out run: the board must escalate, not stay info.
    const items = [
      ...buildLanes().filter((lane) => lane.latestRunStatus !== "failed").map((lane) => ({ type: classifyConveyorLane(lane) })),
      { type: classifyConveyorLane({ agentStatus: "idle", latestRunStatus: "timed_out" }) },
    ];
    expect(items.filter((i) => i.type === "lane_attention")).toHaveLength(1);
    expect(severityForNonEmptyCategory("agent_conveyor", items)).toBe("warning");
  });
});
