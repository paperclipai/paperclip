import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  adapterReadinessProbes,
  agents,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";

import { NORTHSTAR_EXPECTED_FINDINGS, buildNorthstarFixturePlan } from "../services/weekly-review/northstar-fixture.js";
import {
  computeWeeklyReviewFindingsFromSnapshot,
  validateWeeklyReviewCitationDrafts,
  weeklyReviewFindingEngineService,
  type WeeklyReviewFindingSourceSnapshot,
} from "../services/weekly-review/finding-engine.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres weekly review finding engine tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const periodStart = new Date("2026-05-11T00:00:00.000Z");
const periodEnd = new Date("2026-05-17T23:59:59.000Z");

describe("weekly review finding engine", () => {
  it("computes the locked Northstar findings with citations and metadata sidecars", () => {
    const result = computeWeeklyReviewFindingsFromSnapshot(buildNorthstarSnapshot());

    expect(result.findings.map((finding) => finding.stableId)).toEqual(NORTHSTAR_EXPECTED_FINDINGS.map((finding) => finding.stableId));
    expect(
      result.findings.map((finding) => ({
        stableId: finding.stableId,
        category: finding.category,
        severity: finding.severity,
        workstream: finding.workstream,
        title: finding.title,
      })),
    ).toEqual(NORTHSTAR_EXPECTED_FINDINGS);
    expect(result.findings).toHaveLength(8);

    for (const finding of result.findings) {
      expect(result.citations.filter((citation) => citation.findingStableId === finding.stableId)).not.toHaveLength(0);
    }
    expect(result.citationValidation.valid).toBe(true);

    expect(Object.keys(result.adapterReadinessSummary.byAdapterType).sort()).toEqual([
      "agy_local",
      "claude_local",
      "codex_local",
    ]);
    expect(result.modelAssuranceSummary.byAgent["agent-research-insights-lead"]).toMatchObject({
      adapterType: "agy_local",
      selectedModel: "gemini-3.5-flash",
      resolvedModel: "gemini-3.5-flash",
      modelProfile: "primary",
      policyStatus: "approved_primary",
      roleFit: "strong",
    });
  });

  it("does not promote lower-priority stale research or engineering noise into first-screen findings", () => {
    const snapshot = buildNorthstarSnapshot();
    snapshot.issues.push(
      issue("issue-stale-research-noise", "Research follow-up survey draft is stale", {
        description: "A stale but non-blocking research survey draft.",
        updatedAt: "2026-04-01T12:00:00.000Z",
      }),
      issue("issue-stale-engineering-noise", "Engineering cleanup task is stale", {
        description: "A stale cleanup task that should stay out of the executive review.",
        updatedAt: "2026-04-01T12:00:00.000Z",
      }),
    );

    const result = computeWeeklyReviewFindingsFromSnapshot(snapshot);

    expect(result.findings.map((finding) => finding.stableId)).toEqual([
      "NSR-F01",
      "NSR-F02",
      "NSR-F03",
      "NSR-F04",
      "NSR-F05",
      "NSR-F06",
      "NSR-F07",
      "NSR-F08",
    ]);
    expect(result.findings.map((finding) => finding.title).join("\n")).not.toContain("Research follow-up survey");
    expect(result.findings.map((finding) => finding.title).join("\n")).not.toContain("Engineering cleanup");
  });

  it("rejects citations that point across company boundaries", () => {
    const snapshot = buildNorthstarSnapshot();
    const result = validateWeeklyReviewCitationDrafts({
      companyId,
      findings: [
        {
          stableId: "NSR-F01",
          category: "decision_blocker",
          severity: "critical",
          title: "Support handoff owner missing blocks broad rollout",
        },
      ],
      citations: [
        {
          findingStableId: "NSR-F01",
          companyId: otherCompanyId,
          citationType: "evidence",
          entityType: "issue",
          entityId: "issue-support-handoff",
          label: "Support handoff issue",
        },
      ],
      sourceIndex: snapshot.sourceIndex,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "citation_cross_company",
        findingStableId: "NSR-F01",
      }),
    );
  });

  it("fails validation when material findings have no citations", () => {
    const result = validateWeeklyReviewCitationDrafts({
      companyId,
      findings: [
        {
          stableId: "NSR-F04",
          category: "evidence_gap",
          severity: "high",
          title: "Research brief has one unsupported customer-segment claim",
        },
      ],
      citations: [],
      sourceIndex: buildNorthstarSnapshot().sourceIndex,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "material_citation_missing",
        findingStableId: "NSR-F04",
      }),
    );
  });
});

describeEmbeddedPostgres("weekly review finding engine database reads", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-weekly-review-finding-engine-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(adapterReadinessProbes);
    await db.delete(costEvents);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("loads company-scoped control-plane rows before computing findings", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const supportAgentId = randomUUID();
    const codexAgentId = randomUUID();
    const agyAgentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Northstar Labs",
        issuePrefix: "NSRDB",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Labs",
        issuePrefix: "OTHDB",
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      agentRow(supportAgentId, companyId, "Support/Ops Lead", "claude_local"),
      agentRow(codexAgentId, companyId, "Engineering Lead", "codex_local"),
      agentRow(agyAgentId, companyId, "Research & Insights Lead", "agy_local"),
      agentRow(otherAgentId, otherCompanyId, "Other Lead", "claude_local"),
    ]);

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Support handoff owner missing blocks broad rollout",
        description: "Broad rollout remains blocked until the support handoff has an accountable owner.",
        status: "blocked",
        priority: "critical",
        assigneeAgentId: null,
        updatedAt: new Date("2026-05-16T12:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        title: "Support handoff owner missing blocks broad rollout",
        description: "This other company row must not be cited.",
        status: "blocked",
        priority: "critical",
        assigneeAgentId: null,
        updatedAt: new Date("2026-05-16T12:00:00.000Z"),
      },
    ]);

    await db.insert(adapterReadinessProbes).values([
      readinessProbeRow(randomUUID(), companyId, supportAgentId, "claude_local", "default-primary"),
      readinessProbeRow(randomUUID(), companyId, codexAgentId, "codex_local", "default-primary"),
      readinessProbeRow(randomUUID(), companyId, agyAgentId, "agy_local", "gemini-3.5-flash"),
      readinessProbeRow(randomUUID(), otherCompanyId, otherAgentId, "claude_local", "default-primary"),
    ]);

    const result = await weeklyReviewFindingEngineService(db).computeForCompanyPeriod(companyId, {
      periodStart,
      periodEnd,
    });

    expect(result.inputCounts.issues).toBe(1);
    expect(result.findings.map((finding) => finding.stableId)).toEqual(["NSR-F01", "NSR-F03"]);
    expect(result.citationValidation.valid).toBe(true);
    expect(result.citations.every((citation) => citation.companyId === companyId)).toBe(true);
    expect(Object.keys(result.adapterReadinessSummary.byAdapterType).sort()).toEqual([
      "agy_local",
      "claude_local",
      "codex_local",
    ]);
    expect(result.modelAssuranceSummary.byAgent[agyAgentId]).toMatchObject({
      adapterType: "agy_local",
      selectedModel: "gemini-3.5-flash",
      resolvedModel: "gemini-3.5-flash",
      policyStatus: "approved_primary",
      roleFit: "strong",
    });
  });
});

function buildNorthstarSnapshot(): WeeklyReviewFindingSourceSnapshot {
  const plan = buildNorthstarFixturePlan();
  const agents = plan.agents.map((agent) => ({
    id: `agent-${agent.key}`,
    companyId,
    name: agent.name,
    role: agent.title,
    title: agent.title,
    adapterType: agent.adapterType,
    metadata: {
      workstream: agent.workstream,
      modelPolicy: agent.modelPolicy,
    },
    createdAt: new Date("2026-05-01T12:00:00.000Z"),
    updatedAt: new Date("2026-05-16T12:00:00.000Z"),
  }));

  const issues = [
    issue("issue-support-handoff", "Support handoff owner missing blocks broad rollout", {
      description: "Broad rollout remains blocked until the support handoff has an accountable owner.",
      priority: "critical",
      status: "blocked",
      assigneeAgentId: null,
      updatedAt: "2026-05-16T12:00:00.000Z",
    }),
    issue("issue-approve-pilot", "Approve limited pilot rollout", {
      description: "Governance approval is required before the limited pilot can start.",
      priority: "high",
      status: "todo",
      assigneeAgentId: "agent-ceo",
      updatedAt: "2026-05-15T12:00:00.000Z",
    }),
    issue("issue-research-brief", "Research brief has one unsupported customer-segment claim", {
      description: "One customer-segment claim is unsupported and must be cited before narration.",
      priority: "high",
      status: "in_review",
      assigneeAgentId: "agent-research-insights-lead",
      updatedAt: "2026-05-15T12:00:00.000Z",
    }),
    issue("issue-ops-runbook", "Operations runbook update is stale and still blocks support handoff", {
      description: "The runbook has not moved this week and is linked to the support handoff blocker.",
      priority: "medium",
      status: "blocked",
      assigneeAgentId: "agent-support-ops-lead",
      updatedAt: "2026-05-01T12:00:00.000Z",
    }),
    issue("issue-inbox-digest", "Cited weekly inbox digest prototype is ready for limited pilot", {
      description: "The cited weekly inbox digest prototype is ready for a limited pilot.",
      priority: "medium",
      status: "done",
      assigneeAgentId: "agent-engineering-lead",
      updatedAt: "2026-05-16T12:00:00.000Z",
      completedAt: "2026-05-16T12:00:00.000Z",
    }),
  ];

  const issueComments = [
    {
      id: "comment-research-gap",
      companyId,
      issueId: "issue-research-brief",
      body: "Unsupported customer-segment claim needs citation before the executive review can rely on it.",
      authorAgentId: "agent-research-insights-lead",
      authorUserId: null,
      authorType: "agent",
      createdAt: new Date("2026-05-15T13:00:00.000Z"),
      updatedAt: new Date("2026-05-15T13:00:00.000Z"),
    },
  ];

  const heartbeatRuns = [
    {
      id: "run-research-validation",
      companyId,
      agentId: "agent-research-insights-lead",
      status: "failed",
      triggerDetail: "Research summarization validation",
      error: "Research summarization run failed validation",
      resultJson: { validation: "failed" },
      startedAt: new Date("2026-05-15T14:00:00.000Z"),
      finishedAt: new Date("2026-05-15T14:10:00.000Z"),
      createdAt: new Date("2026-05-15T14:00:00.000Z"),
      updatedAt: new Date("2026-05-15T14:10:00.000Z"),
    },
  ];

  const budgetIncidents = [
    {
      id: "budget-citation-retries",
      companyId,
      status: "open",
      metric: "cost_cents",
      scopeType: "company",
      scopeId: companyId,
      amountObserved: 1850,
      amountLimit: 1500,
      thresholdType: "warning",
      windowStart: new Date("2026-05-11T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T23:59:59.000Z"),
      createdAt: new Date("2026-05-16T15:00:00.000Z"),
      updatedAt: new Date("2026-05-16T15:00:00.000Z"),
    },
  ];

  const costEvents = [
    {
      id: "cost-citation-retry",
      companyId,
      agentId: "agent-finance-ops-analyst",
      issueId: "issue-research-brief",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      costCents: 650,
      occurredAt: new Date("2026-05-16T15:30:00.000Z"),
      billingCode: "citation-validation-retry",
    },
  ];

  const adapterReadinessProbes = agents.map((agent) => ({
    id: `probe-${agent.id}`,
    companyId,
    agentId: agent.id,
    adapterType: agent.adapterType,
    status: "ready",
    basicReady: true,
    operationalReady: true,
    fixtureReady: true,
    reasonCodesJson: [],
    model: agent.adapterType === "agy_local" ? "gemini-3.5-flash" : "default-primary",
    resolvedModel: agent.adapterType === "agy_local" ? "gemini-3.5-flash" : "default-primary",
    modelSource: agent.adapterType === "agy_local" ? "adapter_config" : "provider_default",
    modelProfile: "primary",
    modelAvailable: true,
    modelRunnable: true,
    modelPolicyStatus: "approved_primary",
    roleFit: "strong",
    roleFitReason: null,
    modelReasonCodesJson: [],
    modelCapabilitiesJson: { text: true },
    strictMode: false,
    checkedAt: new Date("2026-05-16T16:00:00.000Z"),
    expiresAt: new Date("2026-05-23T16:00:00.000Z"),
    createdAt: new Date("2026-05-16T16:00:00.000Z"),
  }));

  const sourceIndex = {
    "issue:issue-support-handoff": { companyId, entityType: "issue", entityId: "issue-support-handoff" },
    "issue:issue-approve-pilot": { companyId, entityType: "issue", entityId: "issue-approve-pilot" },
    "issue:issue-research-brief": { companyId, entityType: "issue", entityId: "issue-research-brief" },
    "issue:issue-ops-runbook": { companyId, entityType: "issue", entityId: "issue-ops-runbook" },
    "issue:issue-inbox-digest": { companyId, entityType: "issue", entityId: "issue-inbox-digest" },
    "issue_comment:comment-research-gap": { companyId, entityType: "issue_comment", entityId: "comment-research-gap" },
    "heartbeat_run:run-research-validation": { companyId, entityType: "heartbeat_run", entityId: "run-research-validation" },
    "budget_incident:budget-citation-retries": { companyId, entityType: "budget_incident", entityId: "budget-citation-retries" },
    "cost_event:cost-citation-retry": { companyId, entityType: "cost_event", entityId: "cost-citation-retry" },
  };

  return {
    companyId,
    periodStart,
    periodEnd,
    sourceWindowStart: periodStart,
    sourceWindowEnd: periodEnd,
    agents,
    issues,
    issueComments,
    approvals: [],
    heartbeatRuns,
    budgetIncidents,
    costEvents,
    adapterReadinessProbes,
    sourceIndex,
  };
}

function issue(
  id: string,
  title: string,
  overrides: Partial<WeeklyReviewFindingSourceSnapshot["issues"][number]> = {},
): WeeklyReviewFindingSourceSnapshot["issues"][number] {
  const {
    updatedAt,
    completedAt,
    hiddenAt,
    ...rest
  } = overrides;
  return {
    id,
    companyId,
    title,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    ...rest,
    updatedAt: asDate(updatedAt) ?? new Date("2026-05-16T12:00:00.000Z"),
    completedAt: asDate(completedAt) ?? null,
    hiddenAt: asDate(hiddenAt) ?? null,
  };
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === undefined || value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function agentRow(id: string, companyId: string, name: string, adapterType: "claude_local" | "codex_local" | "agy_local") {
  return {
    id,
    companyId,
    name,
    role: name,
    title: name,
    status: "idle",
    adapterType,
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  };
}

function readinessProbeRow(
  id: string,
  companyId: string,
  agentId: string,
  adapterType: "claude_local" | "codex_local" | "agy_local",
  model: string,
) {
  return {
    id,
    companyId,
    agentId,
    adapterType,
    status: "ready",
    basicReady: true,
    operationalReady: true,
    fixtureReady: true,
    reasonCodesJson: [],
    model,
    resolvedModel: model,
    modelSource: adapterType === "agy_local" ? "adapter_config" : "provider_default",
    modelProfile: "primary",
    modelAvailable: true,
    modelRunnable: true,
    modelPolicyStatus: "approved_primary",
    roleFit: "strong",
    modelReasonCodesJson: [],
    modelCapabilitiesJson: { text: true },
    strictMode: false,
    checkedAt: new Date("2026-05-16T16:00:00.000Z"),
    expiresAt: new Date("2026-05-23T16:00:00.000Z"),
    createdAt: new Date("2026-05-16T16:00:00.000Z"),
  };
}
