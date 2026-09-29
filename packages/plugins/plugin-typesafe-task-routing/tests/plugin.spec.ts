import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { createOneCliGatewayFetch, evaluateIssue, type RoutingDecision, type RoutingDecisionClient } from "../src/routing.js";

const COMPANY_ID = "a07c1334-f3d6-446e-9aab-349cca2e5a9a";

function probabilities(overrides: Record<string, number> = {}) {
  return {
    engineering: 0.90,
    distributor_sync: 0.01,
    project_management: 0.01,
    customer_support: 0.01,
    revenue: 0.01,
    inventory: 0.01,
    fraud: 0.01,
    email_marketing: 0.01,
    social_media: 0.01,
    content_seo: 0.01,
    search_performance: 0.005,
    needs_triage: 0.005,
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: COMPANY_ID,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Checkout button fails after adding a bundle",
    description: "Reproduce and fix the WooCommerce checkout defect.",
    status: "todo",
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    responsibleUserId: "user-1",
    issueNumber: 1,
    identifier: "OCC-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-09-28T00:00:00Z"),
    updatedAt: new Date("2026-09-28T00:00:00Z"),
    ...overrides,
  };
}

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    model: "jev-1.13.0",
    department: {
      type: "choice",
      choice: "engineering",
      confidence: 0.91,
      probabilities: probabilities(),
    },
    sufficiency: { type: "noul", noul: 0.89 },
    usage: { input_tokens: 420, output_tokens: 60 },
    ...overrides,
  };
}

function setup(clientResult: RoutingDecision | Error, config: Record<string, unknown> = { enabled: true }) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ issues: [issue()] });
  vi.spyOn(harness.ctx.agents, "get").mockImplementation(async (agentId, companyId) => ({
    id: agentId,
    companyId,
    status: "active",
  }) as never);
  const decide = vi.fn(async () => {
    if (clientResult instanceof Error) throw clientResult;
    return clientResult;
  });
  return { harness, client: { decide } satisfies RoutingDecisionClient, decide };
}

async function records(harness: ReturnType<typeof createTestHarness>) {
  return harness.ctx.entities.list({ entityType: "typesafe-routing-recommendation", scopeKind: "issue", scopeId: "issue-1" });
}

describe("TypeSafe task routing pilot", () => {
  it("records a valid recommendation without assigning the issue", async () => {
    const { harness, client } = setup(decision());
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("engineering");
    const [record] = await records(harness);
    expect(record?.data).toMatchObject({ effectiveDecision: "engineering", recommendedAgentId: "4a67e582-657f-443c-ac6d-547ae6d62325", returnedModelVersion: "jev-1.13.0", usage: { inputTokens: 420, outputTokens: 60 } });
    expect((await harness.ctx.issues.get("issue-1", COMPANY_ID))?.assigneeAgentId).toBeNull();
  });

  it("sends ambiguous probabilities to needs_triage", async () => {
    const { harness, client } = setup(decision({ department: { type: "choice", choice: "engineering", confidence: 0.76, probabilities: probabilities({ engineering: 0.42, revenue: 0.38, needs_triage: 0.12, distributor_sync: 0.01, project_management: 0.01, customer_support: 0.01, inventory: 0.01, fraud: 0.01, email_marketing: 0.01, social_media: 0.01, content_seo: 0.005, search_performance: 0.005 }) } }));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("needs_triage");
    expect((await records(harness))[0]?.data.reason).toBe("ambiguous");
  });

  it("maps an unknown destination to needs_triage", async () => {
    const { harness, client } = setup(decision({ department: { type: "choice", choice: "made_up", confidence: 0.95, probabilities: { made_up: 0.95, needs_triage: 0.05 } } }));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("needs_triage");
    expect((await records(harness))[0]?.data.reason).toBe("unknown_destination");
  });

  it("fails open and records sanitized failure metadata", async () => {
    const { harness, client } = setup(new Error("provider unavailable"));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("failed_open");
    const [record] = await records(harness);
    expect(record?.data).toMatchObject({ status: "failed", reason: "Error", effectiveDecision: null, usage: null });
    expect(JSON.stringify(record?.data)).not.toContain("provider unavailable");
  });

  it("creates the decision client only after the worker reaches an eligible issue", async () => {
    const harness = createTestHarness({ manifest, config: { enabled: true } });
    harness.seed({ issues: [issue()] });
    vi.spyOn(harness.ctx.agents, "get").mockImplementation(async (agentId, companyId) => ({
      id: agentId,
      companyId,
      status: "active",
    }) as never);
    const decide = vi.fn(async () => decision());
    const clientFactory = vi.fn((): RoutingDecisionClient => ({ decide }));

    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, undefined, clientFactory)).toBe("engineering");
    expect(clientFactory).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the OneCLI worker transport is unavailable", () => {
    expect(() => createOneCliGatewayFetch({})).toThrow("OneCLI gateway is not enabled");
    expect(() => createOneCliGatewayFetch({ ONECLI_GATEWAY: "true" })).toThrow("HTTPS proxy is not configured");
  });

  it("accepts the lowercase HTTPS proxy alias emitted by the host", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const gatewayFetch = createOneCliGatewayFetch(
      {
        ONECLI_GATEWAY: "true",
        https_proxy: "http://gateway.invalid",
        NODE_USE_ENV_PROXY: "1",
        NODE_EXTRA_CA_CERTS: import.meta.filename,
      },
      fetchImpl,
    );

    await expect(gatewayFetch("https://api.typesafe.ai/v1/systemone")).resolves.toHaveProperty("status", 204);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses custom-fetch requests outside the TypeSafe API origin", async () => {
    const gatewayFetch = createOneCliGatewayFetch(
      {
        ONECLI_GATEWAY: "true",
        HTTPS_PROXY: "http://gateway.invalid",
        NODE_USE_ENV_PROXY: "1",
        NODE_EXTRA_CA_CERTS: "/does/not/need/to/exist-for-rejected-hosts",
      },
      vi.fn(),
    );
    await expect(gatewayFetch("https://example.com/v1/systemone")).rejects.toThrow("unexpected origin");
  });

  it("fails open on a provider timeout", async () => {
    const timeout = new Error("request exceeded deadline");
    timeout.name = "TimeoutError";
    const { harness, client } = setup(timeout);
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("failed_open");
    expect((await records(harness))[0]?.data).toMatchObject({ status: "failed", reason: "TimeoutError", usage: null });
  });

  it("deduplicates repeated events for the same input revision", async () => {
    const { harness, client, decide } = setup(decision());
    await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client);
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("duplicate");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(await records(harness)).toHaveLength(1);
  });

  it("coalesces concurrent events for the same input revision", async () => {
    const { harness } = setup(decision());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const decide = vi.fn(async () => {
      await gate;
      return decision();
    });
    const client = { decide } satisfies RoutingDecisionClient;
    const first = evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client);
    const second = evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["engineering", "engineering"]);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(await records(harness)).toHaveLength(1);
  });

  it("fails open when recommendation persistence is unavailable", async () => {
    const { harness, client } = setup(decision());
    vi.spyOn(harness.ctx.entities, "upsert").mockRejectedValue(new Error("database unavailable"));
    await expect(evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).resolves.toBe("failed_open");
  });

  it("fails open when configuration persistence is unavailable", async () => {
    const { harness, client, decide } = setup(decision());
    vi.spyOn(harness.ctx.config, "get").mockRejectedValue(new Error("configuration unavailable"));
    await expect(evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).resolves.toBe("failed_open");
    expect(decide).not.toHaveBeenCalled();
  });

  it("preserves explicit assignments without calling TypeSafe", async () => {
    const { harness, client, decide } = setup(decision());
    harness.seed({ issues: [issue({ assigneeAgentId: "already-assigned" })] });
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("explicit_assignment");
    expect(decide).not.toHaveBeenCalled();
    expect(await records(harness)).toHaveLength(0);
  });

  it.each([
    ["Refund order 123", "Customer requested a full refund."],
    ["Capture payment", "Authorize the card now."],
    ["Reply to customer", "Send an email with the result."],
  ])("excludes direct governed action text without calling TypeSafe: %s", async (title, description) => {
    const { harness, client, decide } = setup(decision());
    harness.seed({ issues: [issue({ title, description })] });
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("governed_action");
    expect(decide).not.toHaveBeenCalled();
  });

  it.each([
    ["Investigate payment gateway outage", "Find the root cause of failed authorizations."],
    ["Review email campaign performance", "Compare open and click rates."],
  ])("keeps analysis work eligible when it only mentions a gated topic: %s", async (title, description) => {
    const { harness, client, decide } = setup(decision());
    harness.seed({ issues: [issue({ title, description })] });
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("engineering");
    expect(decide).toHaveBeenCalledOnce();
  });

  it("refuses enablement outside the OCC company", async () => {
    const { harness, client, decide } = setup(decision());
    expect(await evaluateIssue(harness.ctx, "issue-1", "other-company", client)).toBe("wrong_company");
    expect(decide).not.toHaveBeenCalled();
  });

  it("escalates when the selected destination agent is unavailable", async () => {
    const { harness, client } = setup(decision());
    vi.mocked(harness.ctx.agents.get).mockResolvedValueOnce(null);
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("needs_triage");
    expect((await records(harness))[0]?.data).toMatchObject({
      effectiveDecision: "needs_triage",
      reason: "unavailable_destination",
    });
  });

  it("does not persist a recommendation when assignment changes during evaluation", async () => {
    const { harness } = setup(decision());
    const client: RoutingDecisionClient = {
      decide: vi.fn(async () => {
        harness.seed({ issues: [issue({ assigneeAgentId: "human-selected-agent" })] });
        return decision();
      }),
    };
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("explicit_assignment");
    expect(await records(harness)).toHaveLength(0);
  });

  it("does not persist a recommendation when routing input changes during evaluation", async () => {
    const { harness } = setup(decision());
    const client: RoutingDecisionClient = {
      decide: vi.fn(async () => {
        harness.seed({ issues: [issue({ description: "Changed while the request was in flight." })] });
        return decision();
      }),
    };
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("stale_input");
    expect(await records(harness)).toHaveLength(0);
  });

  it("retries a later delivery after a failed evaluation record", async () => {
    const { harness, client } = setup(new Error("temporary outage"));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("failed_open");
    vi.mocked(client.decide).mockResolvedValueOnce(decision());
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("engineering");
    expect(client.decide).toHaveBeenCalledTimes(2);
    expect((await records(harness))[0]?.status).toBe("recommended");
  });

  it("bounds repeated recovery deliveries after failures", async () => {
    const { harness, client } = setup(new Error("persistent outage"));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("failed_open");
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("failed_open");
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("retry_exhausted");
    expect(client.decide).toHaveBeenCalledTimes(2);
    expect((await records(harness))[0]?.data).toMatchObject({ status: "failed", attempts: 2 });
  });

  it.each([
    ["missing probability", probabilities({ engineering: undefined as never })],
    ["extra probability", { ...probabilities(), invented: 0 }],
    ["non-normalized probabilities", { ...probabilities(), engineering: 0.5 }],
  ])("escalates an invalid closed probability map: %s", async (_label, invalidProbabilities) => {
    const { harness, client } = setup(decision({
      department: { type: "choice", choice: "engineering", confidence: 0.91, probabilities: invalidProbabilities },
    }));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("needs_triage");
  });

  it("rejects a selected choice that is not the top probability", async () => {
    const { harness, client } = setup(decision({
      department: { type: "choice", choice: "engineering", confidence: 0.91, probabilities: probabilities({ engineering: 0.01, revenue: 0.91 }) },
    }));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("needs_triage");
    expect((await records(harness))[0]?.data.reason).toBe("invalid_probabilities");
  });

  it.each([
    { input_tokens: -1, output_tokens: 2 },
    { input_tokens: 1.5, output_tokens: 2 },
    { input_tokens: 1, output_tokens: Number.NaN },
  ])("rejects invalid usage counters", async (usage) => {
    const { harness, client } = setup(decision({ usage }));
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("needs_triage");
    expect((await records(harness))[0]?.data.reason).toBe("invalid_probabilities");
  });

  it.each([
    ["department", { ...decision(), department: undefined }],
    ["usage", { ...decision(), usage: undefined }],
  ])("records malformed %s responses as needs-triage recommendations", async (_field, malformed) => {
    const { harness, client } = setup(malformed as unknown as RoutingDecision);
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("needs_triage");
    expect((await records(harness))[0]?.data).toMatchObject({
      status: "recommended",
      effectiveDecision: "needs_triage",
      reason: "invalid_response_type",
    });
    expect((await records(harness))[0]?.data.usage).toEqual(
      _field === "usage" ? null : { inputTokens: 420, outputTokens: 60 },
    );
  });

  it("defaults disabled and makes no request", async () => {
    const { harness, client, decide } = setup(decision(), {});
    expect(await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client)).toBe("disabled");
    expect(decide).not.toHaveBeenCalled();
  });

  it("evaluates a changed input revision once and stores a second audit record", async () => {
    const { harness, client, decide } = setup(decision());
    await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client);
    harness.seed({ issues: [issue({ description: "The checkout defect now affects mobile only.", updatedAt: new Date("2026-09-28T01:00:00Z") })] });
    await evaluateIssue(harness.ctx, "issue-1", COMPANY_ID, client);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(await records(harness)).toHaveLength(2);
  });
});
