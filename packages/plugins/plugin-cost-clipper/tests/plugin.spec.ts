import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginCapability } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { DATA_KEYS } from "../src/constants.js";

const COMPANY_ID = "company-1";
const ISSUE_ID = "issue-1";
const AGENT_ID = "agent-1";

// The plugin only *writes* comments (least privilege), but the tests read them
// back to assert content, so the harness is granted the read capability here.
const TEST_CAPABILITIES: PluginCapability[] = [
  ...(manifest.capabilities as PluginCapability[]),
  "issue.comments.read",
];

function harnessForTest() {
  return createTestHarness({ manifest, capabilities: TEST_CAPABILITIES });
}

type SeededIssue = NonNullable<Parameters<ReturnType<typeof createTestHarness>["seed"]>[0]["issues"]>[number];

function seededIssue(): SeededIssue {
  // Minimal issue record; the harness only checks id + companyId for comments.
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: "project-1",
    title: "Build the thing",
    status: "in_progress",
    assigneeAgentId: AGENT_ID,
  } as unknown as SeededIssue;
}

interface CostEventPayload {
  companyId?: string;
  agentId: string;
  issueId?: string | null;
  provider: string;
  model: string;
  costCents: number;
  inputTokens?: number;
  outputTokens?: number;
  occurredAt?: string;
}

function costPayload(overrides: Partial<CostEventPayload> = {}): CostEventPayload {
  return {
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    issueId: ISSUE_ID,
    provider: "aws_bedrock",
    model: "claude-opus-4-8",
    costCents: 100,
    inputTokens: 1000,
    outputTokens: 500,
    occurredAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

async function emitCost(harness: ReturnType<typeof createTestHarness>, payload: CostEventPayload) {
  await harness.emit("cost_event.created", payload, { companyId: payload.companyId ?? COMPANY_ID });
}

describe("cost clipper plugin", () => {
  it("declares the capabilities and dashboard widget it relies on", () => {
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.capabilities).toContain("costs.read");
    expect(manifest.capabilities).toContain("issue.comments.create");
    expect(manifest.capabilities).toContain("metrics.write");
    expect(manifest.ui?.slots).toContainEqual(
      expect.objectContaining({ type: "dashboardWidget", exportName: "CostClipperWidget" }),
    );
  });

  it("writes a cost metric for every cost event", async () => {
    const harness = harnessForTest();
    harness.seed({ issues: [seededIssue()] });
    await plugin.definition.setup(harness.ctx);

    await emitCost(harness, costPayload({ costCents: 250 }));

    const costMetric = harness.metrics.find((m) => m.name === "cost_clipper.cost_event");
    expect(costMetric).toBeDefined();
    expect(costMetric!.value).toBe(250);
    expect(costMetric!.tags).toMatchObject({ agent: AGENT_ID, model: "claude-opus-4-8" });
  });

  it("raises an anomaly comment + metric when a single event exceeds the absolute ceiling", async () => {
    const harness = harnessForTest();
    harness.seed({ issues: [seededIssue()] });
    await plugin.definition.setup(harness.ctx);

    await emitCost(harness, costPayload({ costCents: 9000 }));

    const anomalyMetric = harness.metrics.find((m) => m.name === "cost_clipper.anomaly");
    expect(anomalyMetric).toBeDefined();
    expect(anomalyMetric!.tags).toMatchObject({ rule: "absolute_ceiling" });

    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Cost Clipper");
    expect(comments[0]!.body).toContain("absolute_ceiling");
  });

  it("does not raise an anomaly for in-distribution spend", async () => {
    const harness = harnessForTest();
    harness.seed({ issues: [seededIssue()] });
    await plugin.definition.setup(harness.ctx);

    for (const cents of [90, 100, 110, 95, 105, 100, 100, 100, 102]) {
      await emitCost(harness, costPayload({ costCents: cents }));
    }

    expect(harness.metrics.find((m) => m.name === "cost_clipper.anomaly")).toBeUndefined();
    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments).toHaveLength(0);
  });

  it("raises a z-score anomaly once a baseline exists and a spike arrives", async () => {
    const harness = harnessForTest();
    harness.seed({ issues: [seededIssue()] });
    await plugin.definition.setup(harness.ctx);

    // Build a baseline (>= minSamples) of small, clustered costs.
    for (const cents of [90, 100, 110, 95, 105, 100, 100, 100]) {
      await emitCost(harness, costPayload({ costCents: cents }));
    }
    // A spike well below the absolute ceiling but far above the agent's mean.
    await emitCost(harness, costPayload({ costCents: 1200 }));

    const anomalyMetric = harness.metrics.find((m) => m.name === "cost_clipper.anomaly");
    expect(anomalyMetric).toBeDefined();
    expect(anomalyMetric!.tags).toMatchObject({ rule: "z_score" });

    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("σ above this agent's mean");
  });

  it("still records an anomaly when there is no issue to comment on", async () => {
    const harness = harnessForTest();
    await plugin.definition.setup(harness.ctx);

    await emitCost(harness, costPayload({ issueId: null, costCents: 9000 }));

    // No throw, anomaly metric recorded, and the overview reflects it.
    expect(harness.metrics.find((m) => m.name === "cost_clipper.anomaly")).toBeDefined();
    const overview = await harness.getData<{ recentAnomalies: unknown[] }>(DATA_KEYS.overview, {
      companyId: COMPANY_ID,
    });
    expect(overview.recentAnomalies).toHaveLength(1);
  });

  it("ignores unparseable cost payloads without throwing", async () => {
    const harness = harnessForTest();
    await plugin.definition.setup(harness.ctx);

    await harness.emit("cost_event.created", { nonsense: true }, { companyId: COMPANY_ID });
    await harness.emit("cost_event.created", { agentId: AGENT_ID }, { companyId: COMPANY_ID }); // missing costCents

    expect(harness.metrics).toHaveLength(0);
  });

  it("surfaces top spenders and open budget incidents through the overview handler", async () => {
    const harness = harnessForTest();
    harness.seed({ issues: [seededIssue()] });
    await plugin.definition.setup(harness.ctx);

    await emitCost(harness, costPayload({ agentId: "agent-1", costCents: 300 }));
    await emitCost(harness, costPayload({ agentId: "agent-2", costCents: 800 }));

    await harness.emit(
      "budget.incident.opened",
      { scopeType: "project", scopeId: "project-1", reason: "budget" },
      { companyId: COMPANY_ID },
    );

    const overview = await harness.getData<{
      topSpenders: Array<{ agentId: string; totalCents: number }>;
      openBudgetIncidents: unknown[];
    }>(DATA_KEYS.overview, { companyId: COMPANY_ID });

    expect(overview.topSpenders[0]).toMatchObject({ agentId: "agent-2", totalCents: 800 });
    expect(overview.openBudgetIncidents).toHaveLength(1);

    // Resolving the incident clears it.
    await harness.emit(
      "budget.incident.resolved",
      { scopeId: "project-1" },
      { companyId: COMPANY_ID },
    );
    const after = await harness.getData<{ openBudgetIncidents: unknown[] }>(DATA_KEYS.overview, {
      companyId: COMPANY_ID,
    });
    expect(after.openBudgetIncidents).toHaveLength(0);
  });

  it("ignores a budget.incident.resolved with no scopeId instead of clearing open incidents", async () => {
    const harness = harnessForTest();
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "budget.incident.opened",
      { scopeType: "project", scopeId: "project-1", reason: "budget" },
      { companyId: COMPANY_ID },
    );
    // A malformed resolution (no scopeId) must not wipe the open incident.
    await harness.emit("budget.incident.resolved", {}, { companyId: COMPANY_ID });

    const overview = await harness.getData<{ openBudgetIncidents: unknown[] }>(DATA_KEYS.overview, {
      companyId: COMPANY_ID,
    });
    expect(overview.openBudgetIncidents).toHaveLength(1);
  });

  it("rejects a negative-cost event so it cannot skew the agent baseline", async () => {
    const harness = harnessForTest();
    await plugin.definition.setup(harness.ctx);

    await emitCost(harness, costPayload({ costCents: -500 }));

    // No metric written, and the agent has no aggregate to skew.
    expect(harness.metrics).toHaveLength(0);
    const overview = await harness.getData<{ topSpenders: unknown[] }>(DATA_KEYS.overview, {
      companyId: COMPANY_ID,
    });
    expect(overview.topSpenders).toHaveLength(0);
  });
});
