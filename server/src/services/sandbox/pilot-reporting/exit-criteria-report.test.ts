import { describe, expect, it } from "vitest";

import { evaluateExitCriteria, renderExitCriteriaReport } from "./exit-criteria-report.js";
import { projectBillingSnapshot } from "./daily-snapshot.js";
import { PILOT_EXIT_CRITERIA_DEFAULTS, type ExitCriteriaInput, type OperatorConfidenceComment } from "./types.js";

function goCommentForRole(role: string): OperatorConfidenceComment {
  return {
    role,
    operator: `${role} Operator`,
    verdict: "go",
    postedAt: "2026-06-01T12:00:00Z",
    commentId: `comment-${role.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    excerpt: `${role} approves Phase 4B graduation.`,
  };
}

function greenInput(overrides: Partial<ExitCriteriaInput> = {}): ExitCriteriaInput {
  return {
    pilotId: "phase-4a-s4-e2b-pilot",
    windowStartUtcDay: "2026-05-18",
    windowEndUtcDay: "2026-06-01",
    windowLeaseTally: {
      successCount: 980,
      failureCount: 20,
      coldStartP95Ms: 450,
      leaseReadyP95Ms: 1400,
    },
    finalBilling: projectBillingSnapshot({
      utcDay: "2026-06-01",
      dayToDateCents: 500,
      monthToDateCents: 18000,
      dailyHardCapCents: 2000,
      monthlyHardCapCents: 20000,
    }),
    vendorUptimeRatio: 0.998,
    dailyTally: [
      {
        utcDay: "2026-05-18",
        leaseSuccessRate: 0.99,
        coldStartP95Ms: 410,
        daySpendCents: 250,
        monthToDateCents: 250,
        isolationIncidents: 0,
        secretLeaks: 0,
        vendorUptimeRatio: 0.999,
        capState: "within",
      },
    ],
    isolationIncidents: [],
    secretLeaks: [],
    operatorConfidenceComments: [
      goCommentForRole("Architect"),
      goCommentForRole("QA Validator"),
      goCommentForRole("Hermes Orchestrator"),
    ],
    thresholds: PILOT_EXIT_CRITERIA_DEFAULTS,
    truthLabel: "preview",
    ...overrides,
  };
}

describe("evaluateExitCriteria", () => {
  it("returns pass for a fully green pilot", () => {
    const result = evaluateExitCriteria(greenInput());
    expect(result.overall).toBe("pass");
    expect(result.failedIds).toEqual([]);
    expect(result.perCriterion.map((r) => r.id)).toEqual([
      "lease_success_rate",
      "cold_start_p95",
      "lease_ready_p95",
      "isolation_incidents",
      "secret_leaks",
      "monthly_cost",
      "vendor_uptime",
      "operator_confidence",
    ]);
  });

  it("fails when monthly cost breaches the hard cap", () => {
    const result = evaluateExitCriteria(greenInput({
      finalBilling: projectBillingSnapshot({
        utcDay: "2026-06-01",
        dayToDateCents: 500,
        monthToDateCents: 21000,
        dailyHardCapCents: 2000,
        monthlyHardCapCents: 20000,
      }),
    }));
    expect(result.overall).toBe("fail");
    expect(result.failedIds).toContain("monthly_cost");
  });

  it("fails when an isolation incident is logged", () => {
    const result = evaluateExitCriteria(greenInput({
      isolationIncidents: [{ id: "iso-1", detectedAt: "2026-05-20T10:00:00Z", summary: "cross-tenant FS" }],
    }));
    expect(result.overall).toBe("fail");
    expect(result.failedIds).toContain("isolation_incidents");
  });

  it("fails when p95 latency breaches threshold", () => {
    const result = evaluateExitCriteria(greenInput({
      windowLeaseTally: {
        successCount: 980,
        failureCount: 20,
        coldStartP95Ms: 600,
        leaseReadyP95Ms: 1800,
      },
    }));
    expect(result.overall).toBe("fail");
    expect(result.failedIds).toEqual(expect.arrayContaining(["cold_start_p95", "lease_ready_p95"]));
  });

  it("fails when operator confidence is missing or non-go", () => {
    const noOps = evaluateExitCriteria(greenInput({ operatorConfidenceComments: [] }));
    expect(noOps.failedIds).toContain("operator_confidence");

    const partial = evaluateExitCriteria(greenInput({
      operatorConfidenceComments: [
        goCommentForRole("Architect"),
        { ...goCommentForRole("QA Validator"), verdict: "no_go" },
        goCommentForRole("Hermes Orchestrator"),
      ],
    }));
    expect(partial.failedIds).toContain("operator_confidence");
  });

  it("reports no_data when sample sets are empty", () => {
    const result = evaluateExitCriteria(greenInput({
      windowLeaseTally: { successCount: 0, failureCount: 0, coldStartP95Ms: null, leaseReadyP95Ms: null },
      vendorUptimeRatio: null,
    }));
    expect(result.overall).toBe("fail");
    expect(result.failedIds).toEqual(expect.arrayContaining([
      "lease_success_rate",
      "cold_start_p95",
      "lease_ready_p95",
      "vendor_uptime",
    ]));
  });
});

describe("renderExitCriteriaReport", () => {
  it("renders the pass recommendation block for a green pilot", () => {
    const md = renderExitCriteriaReport(greenInput());
    expect(md).toContain("# phase-4a-s4-e2b-pilot — exit-criteria report");
    expect(md).toContain("Truth label: `preview`");
    expect(md).toContain("Pilot window: 2026-05-18 → 2026-06-01");
    expect(md).toContain("✅ **PASS — graduate to Phase 4B.**");
    expect(md).toContain("Open a new ADR §7 gate issue");
    expect(md).not.toContain("⛔ Early halt");
    expect(md).toContain("| Lease success rate | ≥ 95.00% | 98.00% | ✅ pass");
  });

  it("renders the fail recommendation when cost breach triggers a halt", () => {
    const md = renderExitCriteriaReport(greenInput({
      earlyHalt: {
        triggeredAt: "2026-05-26T18:30:00Z",
        trigger: "cost_breach",
        summary: "Monthly hard cap reached on day 9",
        incidentLink: "https://example.invalid/LET-365#incident-1",
      },
      finalBilling: projectBillingSnapshot({
        utcDay: "2026-05-26",
        dayToDateCents: 2000,
        monthToDateCents: 21000,
        dailyHardCapCents: 2000,
        monthlyHardCapCents: 20000,
      }),
    }));
    expect(md).toContain("⛔ Early halt");
    expect(md).toContain("Trigger: `cost_breach`");
    expect(md).toContain("🛑 **FAIL — revert and escalate.**");
    expect(md).toContain("`monthly_cost`");
    expect(md).toContain("Flip `SANDBOX_PROVIDER_ALLOW_LIVE` back to `false`");
  });

  it("renders the fail recommendation when an isolation incident halts the pilot", () => {
    const md = renderExitCriteriaReport(greenInput({
      earlyHalt: {
        triggeredAt: "2026-05-22T09:00:00Z",
        trigger: "isolation_incident",
        summary: "Cross-tenant filesystem handle detected",
      },
      isolationIncidents: [{
        id: "iso-1",
        detectedAt: "2026-05-22T08:55:00Z",
        summary: "Cross-tenant FS handle leaked across leases",
        link: "https://example.invalid/LET-365#iso-1",
      }],
    }));
    expect(md).toContain("Trigger: `isolation_incident`");
    expect(md).toContain("### Isolation incidents");
    expect(md).toContain("`iso-1`");
    expect(md).toContain("🛑 **FAIL — revert and escalate.**");
    expect(md).toContain("`isolation_incidents`");
  });

  it("renders the fail recommendation when latency exceeds the threshold", () => {
    const md = renderExitCriteriaReport(greenInput({
      windowLeaseTally: {
        successCount: 950,
        failureCount: 50,
        coldStartP95Ms: 700,
        leaseReadyP95Ms: 1700,
      },
    }));
    expect(md).toContain("🛑 **FAIL — revert and escalate.**");
    expect(md).toContain("`cold_start_p95`");
    expect(md).toContain("`lease_ready_p95`");
  });

  it("formats the daily-snapshot tally and incident log", () => {
    const md = renderExitCriteriaReport(greenInput({
      dailyTally: [
        {
          utcDay: "2026-05-18",
          leaseSuccessRate: 0.99,
          coldStartP95Ms: 410,
          daySpendCents: 250,
          monthToDateCents: 250,
          isolationIncidents: 0,
          secretLeaks: 0,
          vendorUptimeRatio: 0.999,
          capState: "within",
        },
        {
          utcDay: "2026-05-19",
          leaseSuccessRate: 0.97,
          coldStartP95Ms: 430,
          daySpendCents: 350,
          monthToDateCents: 600,
          isolationIncidents: 0,
          secretLeaks: 0,
          vendorUptimeRatio: 1,
          capState: "within",
        },
      ],
    }));
    expect(md).toContain("| 2026-05-18 | 99.00% | 410 ms | $2.50 | $2.50 | 0 | 0 | 99.90% | `within` |");
    expect(md).toContain("| 2026-05-19 | 97.00% | 430 ms | $3.50 | $6.00 | 0 | 0 | 100.00% | `within` |");
    expect(md).toContain("### Isolation incidents");
    expect(md).toContain("_None — green log._");
    expect(md).toContain("### Raw-secret leaks");
  });
});
