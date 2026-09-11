import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { PROJECTION_DISCLAIMER } from "../src/worker.js";

type ApiResponseBody<T> = { body: T };

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
    const forbiddenWriteCapabilities = [
      ["issues", "create"].join("."),
      ["issues", "wakeup"].join("."),
      ["issue", "relations", "write"].join("."),
      ["issue", "documents", "write"].join("."),
      ["issue", "subtree", "write"].join("."),
      ["issues", "orchestration", "write"].join("."),
    ];
    expect(parsed.capabilities).not.toEqual(expect.arrayContaining(forbiddenWriteCapabilities));
    expect(parsed.apiRoutes?.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /issues/:issueId/dark-factory/projection",
      "GET /issues/:issueId/dark-factory/journal-cursor",
      "GET /issues/:issueId/dark-factory/provider-health",
      "POST /issues/:issueId/dark-factory/rehydrate-request",
    ]);
  });

  it("rejects API requests with missing or invalid issueId before building projection state", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const missingIssueId = await plugin.definition.onApiRequest?.({
      ...apiInput("projection", "issue-placeholder", companyId),
      params: {},
    });
    expect(missingIssueId).toMatchObject({
      status: 400,
      body: {
        error: "issueId is required",
      },
    });

    const invalidIssueId = await plugin.definition.onApiRequest?.({
      ...apiInput("journal-cursor", "issue-placeholder", companyId),
      params: { issueId: undefined as unknown as string },
    });
    expect(invalidIssueId).toMatchObject({
      status: 400,
      body: {
        error: "issueId is required",
      },
    });
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
        source: "dark-factory-projection",
        truthSource: "dark-factory-journal",
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
        source: "dark-factory-projection",
        truthSource: "dark-factory-journal",
        authoritative: false,
        cursor: expect.objectContaining({ lastJournalSequenceNo: expect.any(Number) }),
      },
    });

    const health = await plugin.definition.onApiRequest?.(apiInput("provider-health", issueId, companyId));
    expect(health).toMatchObject({
      status: 200,
      body: {
        source: "dark-factory-projection",
        truthSource: "dark-factory-journal",
        authoritative: false,
        observationSource: "runtime_observation",
        providerHealth: expect.objectContaining({ breakerState: expect.stringMatching(/closed|open|half_open/) }),
      },
    });

    const rehydrate = await plugin.definition.onApiRequest?.(apiInput("rehydrate-request", issueId, companyId, "POST", { reason: "operator requested mock refresh" }));
    const repeatedRehydrate = await plugin.definition.onApiRequest?.(apiInput("rehydrate-request", issueId, companyId, "POST", { reason: "operator requested mock refresh" }));
    expect(rehydrate).toMatchObject({
      status: 202,
      body: {
        source: "dark-factory-projection",
        truthSource: "dark-factory-journal",
        authoritative: false,
        receipt: expect.objectContaining({
          receiptId: expect.stringMatching(/^df-rehydrate-df-run-/),
          status: "requested",
          terminalStateAdvanced: false,
          idempotencyKey: expect.stringMatching(/^df-run-.*:rehydrate-request$/),
        }),
      },
    });
    type RehydrateReceiptBody = { receipt: { receiptId: string; status: string; terminalStateAdvanced: boolean; idempotencyKey: string } };
    const rehydrateBody = (rehydrate as ApiResponseBody<RehydrateReceiptBody>).body;
    const repeatedRehydrateBody = (repeatedRehydrate as ApiResponseBody<RehydrateReceiptBody>).body;
    expect(repeatedRehydrateBody.receipt).toMatchObject(rehydrateBody.receipt);
  });

  it("keeps journal cursor rows unique per company and issue in the plugin namespace migration", async () => {
    const migration = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../migrations/001_dark_factory_projection.sql", import.meta.url), "utf8"));

    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS dark_factory_bridge_poc_journal_cursors_company_issue_unique");
    expect(migration).toContain("ON dark_factory_bridge_poc.journal_cursors (company_id, issue_id)");
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
      source: "dark-factory-projection",
      truthSource: "dark-factory-journal",
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
      source: "dark-factory-projection",
      truthSource: "dark-factory-journal",
      authoritative: false,
      receipt: {
        receiptId: expect.stringMatching(/^df-rehydrate-df-run-/),
        status: "requested",
        terminalStateAdvanced: false,
      },
    });
  });
});
