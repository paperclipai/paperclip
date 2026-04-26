import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const PROJECTION_DISCLAIMER = "Projection only — Dark Factory Journal remains truth source";

function apiInput(routeKey: string, issueId: string, companyId: string, method: "GET" | "POST" = "GET", body: Record<string, unknown> | null = null) {
  return {
    routeKey,
    method,
    path: `/issues/${issueId}/dark-factory/${routeKey}`,
    params: { issueId },
    query: {},
    body,
    actor: {
      actorType: "user" as const,
      actorId: "board",
      userId: "board",
      agentId: null,
      runId: null,
    },
    companyId,
    headers: {},
  };
}

describe("Dark Factory bridge projection plugin", () => {
  it("declares projection-only bridge surfaces without Paperclip task mutation capabilities", () => {
    const parsed = pluginManifestV1Schema.parse(manifest);

    expect(parsed).toMatchObject({
      id: "paperclipai.dark-factory-bridge-example",
      database: {
        namespaceSlug: "dark_factory_bridge_poc",
        migrationsDir: "migrations",
        coreReadTables: ["issues"],
      },
    });
    expect(parsed.displayName).toMatch(/Bridge|Projection/i);
    expect(parsed.description).toMatch(/projection/i);
    expect(parsed.description).not.toMatch(/truth source/i);
    expect(parsed.capabilities).toEqual(expect.arrayContaining([
      "api.routes.register",
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      "issues.read",
      "ui.dashboardWidget.register",
      "ui.detailTab.register",
      "instance.settings.register",
    ]));
    expect(parsed.capabilities).not.toEqual(expect.arrayContaining([
      "issues.create",
      "issues.wakeup",
      "issue.relations.write",
      "issue.documents.write",
      "issue.subtree.write",
      "issues.orchestration.write",
    ]));
    expect(parsed.apiRoutes?.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /issues/:issueId/dark-factory/projection",
      "GET /issues/:issueId/dark-factory/journal-cursor",
      "GET /issues/:issueId/dark-factory/provider-health",
      "POST /issues/:issueId/dark-factory/rehydrate-request",
    ]);
  });

  it("dispatches projection, cursor, provider health, and rehydrate API routes as authoritative:false projection responses", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const projection = await plugin.definition.onApiRequest?.(apiInput("projection", issueId, companyId));
    expect(projection).toMatchObject({
      status: 200,
      body: {
        source: "projection",
        truthSource: "dark_factory_journal",
        authoritative: false,
        disclaimer: PROJECTION_DISCLAIMER,
        issueId,
        linkedRunId: expect.stringMatching(/^df-run-/),
        projectionStatus: expect.stringMatching(/degraded|blocked|needs_approval|current/),
      },
    });

    const cursor = await plugin.definition.onApiRequest?.(apiInput("journal-cursor", issueId, companyId));
    expect(cursor).toMatchObject({
      status: 200,
      body: {
        source: "projection",
        truthSource: "dark_factory_journal",
        authoritative: false,
        cursor: expect.objectContaining({ lastJournalSequenceNo: expect.any(Number) }),
      },
    });

    const health = await plugin.definition.onApiRequest?.(apiInput("provider-health", issueId, companyId));
    expect(health).toMatchObject({
      status: 200,
      body: {
        source: "projection",
        truthSource: "dark_factory_journal",
        authoritative: false,
        observationSource: "runtime_observation",
        providerHealth: expect.objectContaining({ breakerState: expect.stringMatching(/closed|open|half_open/) }),
      },
    });

    const rehydrate = await plugin.definition.onApiRequest?.(apiInput("rehydrate-request", issueId, companyId, "POST", { reason: "operator requested mock refresh" }));
    expect(rehydrate).toMatchObject({
      status: 202,
      body: {
        source: "projection",
        truthSource: "dark_factory_journal",
        authoritative: false,
        receipt: expect.objectContaining({ status: "requested", terminalStateAdvanced: false }),
      },
    });
  });

  it("returns projection summary through getData for dashboard/detail tabs", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const summary = await harness.getData<{
      source: string;
      truthSource: string;
      authoritative: boolean;
      disclaimer: string;
      projection: { linkedRunId: string; projectionStatus: string; callbackReceipt: { status: string } };
      providerHealth: { breakerState: string; lastUpdatedAt: string };
    }>("projection-summary", { companyId, issueId });

    expect(summary).toMatchObject({
      source: "projection",
      truthSource: "dark_factory_journal",
      authoritative: false,
      disclaimer: PROJECTION_DISCLAIMER,
      projection: expect.objectContaining({
        linkedRunId: expect.stringMatching(/^df-run-/),
        projectionStatus: expect.any(String),
        callbackReceipt: expect.objectContaining({ status: expect.any(String) }),
      }),
      providerHealth: expect.objectContaining({
        breakerState: expect.any(String),
        lastUpdatedAt: expect.any(String),
      }),
    });
  });

  it("request-rehydrate action returns a receipt and does not advance terminal success", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{
      source: string;
      truthSource: string;
      authoritative: boolean;
      receipt: { receiptId: string; status: string; terminalStateAdvanced: boolean };
    }>("request-rehydrate", { companyId, issueId, reason: "operator retry" });

    expect(result).toMatchObject({
      source: "projection",
      truthSource: "dark_factory_journal",
      authoritative: false,
      receipt: {
        receiptId: expect.stringMatching(/^df-rehydrate-/),
        status: "requested",
        terminalStateAdvanced: false,
      },
    });
  });
});
