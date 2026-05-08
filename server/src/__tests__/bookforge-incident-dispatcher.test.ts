import { describe, expect, it, vi } from "vitest";
import {
  dispatchBookforgeIncident,
  planBookforgeIncidentDispatch,
  validateBookforgeRepairAcceptance,
  buildBookforgeRepairIssueDraft,
  type BookforgeDispatchAgent,
} from "../services/bookforge-incident-dispatcher.js";
import {
  buildBookforgeQualityHoldSummary,
  buildBookforgeTargetMismatchSummary,
  findBookforgeApprovedTargetMismatch,
} from "../services/bookforge-runtime-monitor.js";

const agents: BookforgeDispatchAgent[] = [
  { id: "ceo", name: "Bookforge Steward CEO", status: "idle" },
  { id: "watchman", name: "Bookforge Watchman", status: "idle" },
  { id: "forgewright", name: "Bookforge Forgewright", status: "idle" },
  { id: "inspector", name: "Bookforge Inspector", status: "idle" },
  { id: "debugger", name: "Bookforge Debugger", status: "idle" },
  { id: "scribe", name: "Bookforge Scribe", status: "idle" },
  { id: "continuity", name: "Bookforge Continuity Auditor", status: "idle" },
  { id: "archivist", name: "Bookforge Archivist", status: "idle" },
  { id: "storydoctor", name: "Bookforge Story Doctor", status: "idle" },
  { id: "publisher", name: "Bookforge Publisher", status: "idle" },
  { id: "growth", name: "Bookforge Growth Director", status: "idle" },
  { id: "treasurer", name: "Bookforge Treasurer", status: "idle" },
  { id: "incident", name: "Bookforge Incident Coordinator", status: "idle" },
  { id: "runtime", name: "Bookforge Runtime Governor", status: "idle" },
];

describe("Bookforge incident dispatcher", () => {
  it("plans a bounded engineering fan-out from Watchman without assignment-triggered wakeups", () => {
    const plan = planBookforgeIncidentDispatch({
      agents,
      sourceAgentId: "watchman",
      sourceAgentName: "Bookforge Watchman",
      issueId: "issue-1",
      incidentKind: "code_regression",
      severity: "high",
      summary: "Tests are failing after a code change",
    });

    expect(plan.allowed).toBe(true);
    expect(plan.targets.map((target) => target.agentName)).toEqual([
      "Bookforge Forgewright",
      "Bookforge Inspector",
      "Bookforge Debugger",
    ]);
    expect(plan.targets).toHaveLength(3);
    expect(plan.targets.every((target) => target.source === "automation")).toBe(true);
    expect(plan.targets.every((target) => target.reason === "bookforge_incident_dispatch")).toBe(true);
    expect(plan.targets.every((target) => target.contextSnapshot.forceFreshSession === true)).toBe(true);
    expect(plan.targets.every((target) => target.idempotencyKey?.startsWith("bookforge-incident:issue-1:"))).toBe(true);
  });

  it("routes wrong-book target mismatches across Steward, Publication, Engineering, and Runtime", () => {
    const plan = planBookforgeIncidentDispatch({
      agents,
      sourceAgentId: "watchman",
      sourceAgentName: "Bookforge Watchman",
      issueId: "issue-wrong-book",
      incidentKind: "bookforge_wrong_book_target_mismatch",
      severity: "critical",
      summary: "Approved target is Widow but live stale policy says Last Safe Lie",
    });

    expect(plan.allowed).toBe(true);
    expect(plan.targets.map((target) => target.agentName)).toEqual([
      "Bookforge Steward CEO",
      "Bookforge Publisher",
      "Bookforge Forgewright",
      "Bookforge Runtime Governor",
    ]);
    expect(plan.targets.every((target) => target.contextSnapshot.forceFreshSession === true)).toBe(true);
  });

  it("refuses generic recovery-loop incidents so Paperclip does not create storm wakes", () => {
    const plan = planBookforgeIncidentDispatch({
      agents,
      sourceAgentId: "watchman",
      sourceAgentName: "Bookforge Watchman",
      issueId: "issue-2",
      incidentKind: "recovery_loop",
      severity: "medium",
      summary: "Recover stalled issue BOO-99",
    });

    expect(plan.allowed).toBe(false);
    expect(plan.blockReason).toBe("recovery_loop_suppressed");
    expect(plan.targets).toEqual([]);
  });

  it("does not dispatch if the reporter is not Watchman unless explicitly overridden", () => {
    const plan = planBookforgeIncidentDispatch({
      agents,
      sourceAgentId: "scribe",
      sourceAgentName: "Bookforge Scribe",
      issueId: "issue-3",
      incidentKind: "editorial_quality",
      severity: "high",
      summary: "Chapter quality failed",
    });

    expect(plan.allowed).toBe(false);
    expect(plan.blockReason).toBe("source_not_watchman");
    expect(plan.targets).toEqual([]);
  });

  it("attaches a hard acceptance gate and learning contract to chapter repair dispatches", () => {
    const plan = planBookforgeIncidentDispatch({
      agents,
      sourceAgentId: "watchman",
      sourceAgentName: "Bookforge Watchman",
      issueId: "issue-ch12",
      incidentKind: "editorial_quality",
      severity: "high",
      summary: "Chapter 12 repair for continuity, custody, weak hook, and prose drift",
    });

    expect(plan.allowed).toBe(true);
    expect(plan.repairAcceptanceGate?.gateVersion).toBe("bookforge-repair-acceptance-v1-2026-05-05");
    expect(plan.repairAcceptanceGate?.hardRule).toContain("No Bookforge chapter repair may be marked done");
    expect(plan.repairAcceptanceGate?.mistakeLearning.required).toBe(true);
    expect(plan.repairAcceptanceGate?.finalChapterExternalReviewWorkflow).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Back up the promoted chapter"),
        expect.stringContaining("Tighten surgically"),
        expect.stringContaining("Remove repeated slogans"),
        expect.stringContaining("Clear only the exact matching quality hold"),
        expect.stringContaining("Do not resume Bookforge generation"),
      ]),
    );
    expect(plan.repairAcceptanceGate?.requiredEvidence).toEqual(
      expect.arrayContaining([
        "liveStateChecked",
        "noGenerationStarted",
        "promotedPriorChapterRead",
        "promotedCurrentChapterRead",
        "continuityObligationsListed",
        "objectCustodyVerified",
        "localQualityChecksPassed",
        "canonMemoryRebuilt",
        "learningArtifactWritten",
        "relevantQualityAgentApproval",
        "runtimeGovernorClearance",
      ]),
    );
    expect(plan.repairAcceptanceGate?.holdClearanceWorkflow).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Relevant quality owner reviews"),
        expect.stringContaining("Runtime Governor clears/reconciles only the matching Bookforge hold"),
        expect.stringContaining("otherwise Bookforge stays idle with the hold cleared and no spending"),
      ]),
    );
    expect(plan.repairAcceptanceGate?.roleHandoffs.map((handoff) => handoff.role)).toEqual(
      expect.arrayContaining([
        "Bookforge Story Doctor",
        "Bookforge Runtime Governor",
        "Bookforge Treasurer",
        "Bookforge Steward CEO",
      ]),
    );
    expect(plan.targets.map((target) => target.agentName)).toEqual([
      "Bookforge Scribe",
      "Bookforge Continuity Auditor",
      "Bookforge Archivist",
      "Bookforge Inspector",
      "Bookforge Story Doctor",
    ]);
    expect(plan.targets[0].payload.repairAcceptanceGate).toEqual(plan.repairAcceptanceGate);
    expect(plan.targets[0].contextSnapshot.repairAcceptanceGate).toEqual(plan.repairAcceptanceGate);
  });

  it("refuses to accept a chapter repair until every evidence item and learning artifact is present", () => {
    const partial = validateBookforgeRepairAcceptance({
      liveStateChecked: true,
      noGenerationStarted: true,
      promotedPriorChapterRead: true,
    });

    expect(partial.accepted).toBe(false);
    expect(partial.missing).toEqual(expect.arrayContaining(["objectCustodyVerified", "learningArtifactWritten", "relevantQualityAgentApproval", "runtimeGovernorClearance"]));

    const complete = validateBookforgeRepairAcceptance({
      liveStateChecked: true,
      noGenerationStarted: true,
      promotedPriorChapterRead: true,
      promotedCurrentChapterRead: true,
      continuityObligationsListed: true,
      objectCustodyVerified: true,
      emotionalConsequenceVerified: true,
      sceneEngineVerified: true,
      hookSpecificityVerified: true,
      draftPromotedAlignmentVerified: true,
      localQualityChecksPassed: true,
      canonMemoryRebuilt: true,
      testsOrDetectorsUpdated: true,
      learningArtifactWritten: true,
      relevantQualityAgentApproval: true,
      runtimeGovernorClearance: true,
    });

    expect(complete.accepted).toBe(true);
    expect(complete.missing).toEqual([]);
  });

  it("creates a visible assigned repair issue draft for chapter quality holds so dispatch is not wake-only", () => {
    const source = {
      agents,
      sourceAgentId: "watchman",
      sourceAgentName: "Bookforge Watchman",
      incidentKind: "chapter_repair_quality_hold",
      severity: "high",
      summary:
        "BOOKFORGE QUALITY HOLD — The Last Safe Lie Chapter 14\nProject: the_last_safe_lie\nChapter: 14\nHold reason: Elias wrongly consolidates bait USB, trace copy, silver drive, and film strip.",
    };
    const plan = planBookforgeIncidentDispatch(source);
    const draft = buildBookforgeRepairIssueDraft({ plan, source });

    expect(draft).not.toBeNull();
    expect(draft?.status).toBe("todo");
    expect(draft?.priority).toBe("high");
    expect(draft?.assigneeAgentId).toBe("scribe");
    expect(draft?.assigneeAgentName).toBe("Bookforge Scribe");
    expect(draft?.originKind).toBe("bookforge_incident");
    expect(draft?.title).toContain("Bookforge repair gate");
    expect(draft?.description).toContain("visible repair task Paperclip agents must act on");
    expect(draft?.description).toContain("Project: the_last_safe_lie");
    expect(draft?.description).toContain("relevantQualityAgentApproval");
    expect(draft?.description).toContain("runtimeGovernorClearance");
    expect(draft?.description).toContain("Final-chapter external-review workflow");
    expect(draft?.description).toContain("Do not resume Bookforge generation");
    expect(draft?.description).toContain("Bookforge Runtime Governor");
  });

  it("routes runtime/generation resume incidents to Runtime Governor even when the summary mentions a chapter repair", () => {
    const plan = planBookforgeIncidentDispatch({
      agents,
      sourceAgentName: "Bookforge Watchman",
      incidentKind: "bookforge_generation_resume",
      severity: "high",
      summary: "Chapter 14 repair evidence passed; promote/reconcile and resume only if safe.",
      maxFanout: 1,
    });

    expect(plan.allowed).toBe(true);
    expect(plan.targets.map((target) => target.agentName)).toEqual(["Bookforge Runtime Governor"]);
  });

  it("builds a quality-hold incident summary from Bookforge queue state so Paperclip can self-detect without an external monitor script", () => {
    const summary = buildBookforgeQualityHoldSummary({
      counts: { quality_hold: 1, running: 0 },
      attention: {
        state: "quality_hold",
        chapter: 14,
        item_id: "queue-14",
        project_name: "the_last_safe_lie",
        locked_reason: "chain_of_custody",
        locked_strategy: "rebuild_reveal_staging",
        next_action: "Rebuild chapter plan",
      },
    });

    expect(summary).toContain("BOOKFORGE QUALITY HOLD — the_last_safe_lie chapter 14");
    expect(summary).toContain("Queue item: queue-14");
    expect(summary).toContain("chain_of_custody");
    expect(buildBookforgeQualityHoldSummary({ counts: { running: 1 }, attention: null })).toBeNull();
  });

  it("detects approved-target mismatches even when no quality hold is present", () => {
    const mismatch = findBookforgeApprovedTargetMismatch(
      {
        counts: { running: 1, quality_hold: 0 },
        items: [
          {
            id: "old-item",
            yaml: "the_last_safe_lie.yaml",
            project_name: "the_last_safe_lie",
            status: "done",
          },
          {
            id: "live-item",
            yaml: "the_widow_in_room_twelve.yaml",
            project_name: "the_widow_in_room_twelve",
            status: "running",
            activity: "ghostwriter",
            chapter: 3,
            completed_chapters: 2,
            cost_usd: 0.23,
          },
        ],
      },
      { running: true, current_item_id: "live-item", paused: false, stop_requested: false },
      { yaml: "the_last_safe_lie.yaml", itemId: "old-item" },
    );

    expect(mismatch).not.toBeNull();
    expect(mismatch?.liveYaml).toBe("the_widow_in_room_twelve.yaml");
    expect(mismatch?.approvedYaml).toBe("the_last_safe_lie.yaml");
    expect(mismatch?.liveItemId).toBe("live-item");
    expect(buildBookforgeTargetMismatchSummary(mismatch!)).toContain("BOOKFORGE WRONG-BOOK TARGET MISMATCH");
    expect(buildBookforgeTargetMismatchSummary(mismatch!)).toContain("Approved target: the_last_safe_lie.yaml");
    expect(buildBookforgeTargetMismatchSummary(mismatch!)).toContain("Live target: the_widow_in_room_twelve.yaml");
  });

  it("does not flag the approved target when the worker is running the matching queue item", () => {
    const mismatch = findBookforgeApprovedTargetMismatch(
      {
        counts: { running: 1, quality_hold: 0 },
        items: [
          {
            id: "widow-item",
            yaml: "the_widow_in_room_twelve.yaml",
            project_name: "the_widow_in_room_twelve",
            status: "running",
          },
        ],
      },
      { running: true, current_item_id: "widow-item", paused: false, stop_requested: false },
      { yaml: "the_widow_in_room_twelve.yaml", itemId: "widow-item" },
    );

    expect(mismatch).toBeNull();
  });

  it("continues waking remaining Bookforge targets when one planned agent is paused", async () => {
    const wakeup = vi.fn(async (agentId: string) => {
      if (agentId === "scribe") {
        const error = new Error("Agent is not invokable in its current state") as Error & { status?: number; details?: unknown };
        error.status = 409;
        error.details = { status: "paused" };
        throw error;
      }
      return { queued: true };
    });

    const result = await dispatchBookforgeIncident({
      agents,
      sourceAgentId: "watchman",
      sourceAgentName: "Bookforge Watchman",
      issueId: "issue-paused-agent",
      incidentKind: "chapter_repair_quality_hold",
      severity: "high",
      summary: "Chapter 5 quality hold needs continuity repair",
      wakeup,
    });

    expect(result.allowed).toBe(true);
    expect(wakeup).toHaveBeenCalledTimes(5);
    expect(result.wakeResults).toHaveLength(5);
    expect(result.wakeResults[0]).toEqual(expect.objectContaining({
      agentId: "scribe",
      agentName: "Bookforge Scribe",
      ok: false,
    }));
    expect(result.wakeResults.slice(1).every((entry) => entry.ok)).toBe(true);
  });

  it("wakes planned targets with idempotent automation requests", async () => {
    const wakeup = vi.fn(async () => ({ queued: true }));

    const result = await dispatchBookforgeIncident({
      agents,
      sourceAgentId: "watchman",
      sourceAgentName: "Bookforge Watchman",
      issueId: "issue-4",
      incidentKind: "bookforge_worker_unapproved_running",
      severity: "critical",
      summary: "Bookforge worker is running without approval",
      wakeup,
    });

    expect(result.allowed).toBe(true);
    expect(result.targets.map((target) => target.agentName)).toEqual([
      "Bookforge Runtime Governor",
      "Bookforge Incident Coordinator",
      "Bookforge Treasurer",
    ]);
    expect(wakeup).toHaveBeenCalledTimes(3);
    expect(wakeup).toHaveBeenCalledWith(
      "runtime",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "bookforge_incident_dispatch",
        idempotencyKey: "bookforge-incident:issue-4:runtime",
        contextSnapshot: expect.objectContaining({
          source: "bookforge.watchman.dispatcher",
          incidentKind: "bookforge_worker_unapproved_running",
          severity: "critical",
          issueId: "issue-4",
        }),
      }),
    );
  });
});
