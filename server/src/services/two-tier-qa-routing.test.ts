import { describe, expect, it } from "vitest";
import {
  applyTwoTierQaMintOverrides,
  buildTwoTierQaEscalateOverrides,
  classifyProductQaClass,
  classifyTwoTierQa,
  resolveTwoTierQaIssueModelProfile,
  setEscapeHatchForceStrongClassesForTests,
  shouldEscalateTwoTierQaAfterFailedRun,
} from "./two-tier-qa-routing.js";

describe("two-tier QA routing (TSMC-20345 / TSKB0404)", () => {
  it("classifies deck/pack/guard product QA titles", () => {
    expect(
      classifyProductQaClass({ title: "EP-001 v15 timing/evidence rebuild and governed QA" }),
    ).toBe("deck_video_assembly_qa");
    expect(
      classifyProductQaClass({ title: "Postiz cadence pending_qa — 34 aged row(s)" }),
    ).toBe("pack_lint_review");
    expect(
      classifyProductQaClass({ title: "Guard-card triage: confirm routing for stranded pack" }),
    ).toBe("guard_card_triage");
    expect(
      classifyProductQaClass({ title: "Cerberus independent QA signoff — EP-001 pilot pack" }),
    ).toBe("other_qa_review_verify");
  });

  it("pins cheap at mint for eligible deck assembly QA", () => {
    const result = applyTwoTierQaMintOverrides({
      title: "CC fee-drag v5.3 governed assembly and all-green QA",
    });
    expect(result.applied).toBe(true);
    expect(result.assigneeAdapterOverrides).toMatchObject({
      modelProfile: "cheap",
      twoTierQa: {
        tier: 1,
        qaClass: "deck_video_assembly_qa",
        policy: "TSKB0404",
      },
    });
    expect(result.classification.tier1Eligible).toBe(true);
  });

  it("does not put visual-truth frame QA on the cheap lane", () => {
    const result = applyTwoTierQaMintOverrides({
      title: "Render TSM-6048 R4 real-motion visual source pack and run visual QA",
    });
    expect(result.applied).toBe(false);
    expect(result.classification.floorReason).toBe("visual_truth");
    expect(result.classification.requestedModelProfile).toBe("strong");
  });

  it("does not cheap-pin engineering cards that only mention QA", () => {
    const result = applyTwoTierQaMintOverrides({
      title: "Implement K18/K19 close-evidence hardening for generation and measurement cards",
    });
    expect(result.applied).toBe(false);
    expect(result.classification.floorReason).toBe("engineering_not_qa_pass");
  });

  it("keeps close_evidence deterministic-only unless residual narrative", () => {
    const platform = applyTwoTierQaMintOverrides({
      title: "[PLATFORM] Close-evidence guard: quota cards must fail close when under target",
    });
    // Engineering prefix wins first
    expect(platform.applied).toBe(false);

    const residual = applyTwoTierQaMintOverrides({
      title: "Close-evidence residual narrative review for TSM-6012",
    });
    expect(residual.applied).toBe(true);
    expect(residual.assigneeAdapterOverrides).toMatchObject({ modelProfile: "cheap" });
  });

  it("honors explicit strong override and does not clobber it", () => {
    const result = applyTwoTierQaMintOverrides({
      title: "EP-02 v5 clean-source candidate rebuild and mandatory QA",
      assigneeAdapterOverrides: { modelProfile: "strong", keep: true },
    });
    expect(result.applied).toBe(false);
    expect(result.assigneeAdapterOverrides).toEqual({ modelProfile: "strong", keep: true });
  });

  it("preserves unrelated assigneeAdapterOverrides keys when stamping cheap", () => {
    const result = applyTwoTierQaMintOverrides({
      title: "Rewrite the New Relic structured packet so the served packDraft QA gate passes",
      assigneeAdapterOverrides: { adapterConfig: { cwd: "/tmp" } },
    });
    // Engineering prefix "Rewrite" → not tier-1
    expect(result.applied).toBe(false);

    const pack = applyTwoTierQaMintOverrides({
      title: "packDraft QA for served packet TSR-4809",
      assigneeAdapterOverrides: { adapterConfig: { cwd: "/tmp" } },
    });
    expect(pack.applied).toBe(true);
    expect(pack.assigneeAdapterOverrides).toMatchObject({
      modelProfile: "cheap",
      adapterConfig: { cwd: "/tmp" },
    });
  });

  it("resolves effective issue model profile without mint stamp (routing path)", () => {
    const resolved = resolveTwoTierQaIssueModelProfile({
      title: "Independent QA: Postiz current-content promotion gate",
    });
    expect(resolved.modelProfile).toBe("cheap");
    expect(resolved.source).toBe("two_tier_qa_routing");
    expect(resolved.classification.qaClass).toBe("other_qa_review_verify");
  });

  it("builds tier-2 escalate overrides and detects fail fixture", () => {
    const mint = applyTwoTierQaMintOverrides({
      title: "Vault Cases EP-01 — rebuild deck, re-assemble master, re-run gates",
    });
    expect(mint.applied).toBe(true);

    const decision = shouldEscalateTwoTierQaAfterFailedRun({
      title: "Vault Cases EP-01 — rebuild deck, re-assemble master, re-run gates",
      assigneeAdapterOverrides: mint.assigneeAdapterOverrides,
      runModelProfile: "cheap",
      runStatus: "failed",
    });
    expect(decision.escalate).toBe(true);
    expect(decision.reason).toBe("tier1_fail");

    const escalated = buildTwoTierQaEscalateOverrides({
      assigneeAdapterOverrides: mint.assigneeAdapterOverrides,
      reason: "tier1_fail",
      detail: "fixture fail",
      qaClass: "deck_video_assembly_qa",
    });
    expect(escalated.modelProfile).toBe("strong");
    expect(escalated.assigneeAdapterOverrides).toMatchObject({
      modelProfile: "strong",
      twoTierQa: {
        tier: 2,
        escalateReason: "tier1_fail",
        qaClass: "deck_video_assembly_qa",
      },
    });
  });

  it("does not escalate non-QA cheap recovery runs", () => {
    const decision = shouldEscalateTwoTierQaAfterFailedRun({
      title: "Routine health: dead fire on daily digest",
      originKind: "routine_health",
      assigneeAdapterOverrides: { modelProfile: "cheap" },
      runModelProfile: "cheap",
      runStatus: "failed",
    });
    expect(decision.escalate).toBe(false);
  });

  it("G-class binding titles stay strong", () => {
    const c = classifyTwoTierQa({
      title: "Independent QA of payment publish-gate delivery binding",
    });
    expect(c.tier1Eligible).toBe(false);
    expect(c.floorReason).toBe("g_class_binding");
    expect(c.requestedModelProfile).toBe("strong");
  });

  it("escape hatch force-strong disables tier-1 for tripped product class", () => {
    setEscapeHatchForceStrongClassesForTests(["pack_lint_review"]);
    try {
      const c = classifyTwoTierQa({
        title: "packDraft QA for served packet TSR-4809",
      });
      expect(c.tier1Eligible).toBe(false);
      expect(c.floorReason).toBe("escape_hatch_force_strong");
      expect(c.requestedModelProfile).toBe("strong");

      const mint = applyTwoTierQaMintOverrides({
        title: "packDraft QA for served packet TSR-4809",
      });
      expect(mint.applied).toBe(false);

      // Escape hatch wins over stale explicit cheap.
      const overCheap = classifyTwoTierQa({
        title: "packDraft QA for served packet TSR-4809",
        assigneeAdapterOverrides: { modelProfile: "cheap" },
      });
      expect(overCheap.requestedModelProfile).toBe("strong");
      expect(overCheap.floorReason).toBe("escape_hatch_force_strong");
    } finally {
      setEscapeHatchForceStrongClassesForTests(null);
    }
  });
});
