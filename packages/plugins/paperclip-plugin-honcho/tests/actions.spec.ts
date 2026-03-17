import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/worker.js";
import { buildDefaultFixtures, createHonchoHarness, installFetchMock } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("honcho actions and UI data", () => {
  it("backfill_company records company status and warns when all syncing is disabled", async () => {
    installFetchMock();
    const harness = createHonchoHarness({
      config: {
        syncIssueComments: false,
        syncIssueDocuments: false,
      },
    });

    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction("backfill-company", { companyId: "co_1" }) as Record<string, unknown>;
    expect(result.processedIssues).toBe(1);

    const companyState = harness.getState({
      scopeKind: "company",
      scopeId: "co_1",
      namespace: "honcho",
      stateKey: "company-sync-status",
    }) as Record<string, unknown>;
    expect(typeof companyState.lastBackfillAt).toBe("string");
    expect(companyState.lastError).toMatchObject({
      message: expect.stringContaining("syncing disabled"),
    });
  });

  it("backfill_company continues after a transient issue failure and records the company-level error summary", async () => {
    installFetchMock({ failOnceOn: ["/messages"] });
    const fixtures = buildDefaultFixtures();
    const harness = createHonchoHarness({
      seed: {
        issues: [
          ...fixtures.issues,
          {
            ...fixtures.issues[0],
            id: "iss_2",
            issueNumber: 2,
            identifier: "PAP-2",
            title: "Second issue",
          },
        ],
        issueComments: [
          ...fixtures.issueComments,
          {
            ...fixtures.issueComments[0],
            id: "c_3",
            issueId: "iss_2",
            body: "Third comment",
            createdAt: new Date("2026-03-15T12:04:00.000Z"),
            updatedAt: new Date("2026-03-15T12:04:00.000Z"),
          },
        ],
      },
    });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction("backfill-company", { companyId: "co_1" }) as Record<string, unknown>;

    expect(result.processedIssues).toBe(1);

    const companyState = harness.getState({
      scopeKind: "company",
      scopeId: "co_1",
      namespace: "honcho",
      stateKey: "company-sync-status",
    }) as Record<string, unknown>;
    expect(typeof companyState.lastBackfillAt).toBe("string");
    expect(companyState.lastError).toMatchObject({
      issueId: "iss_1",
      message: expect.stringContaining("1 failed issue sync"),
    });
    expect(harness.logs).toContainEqual(expect.objectContaining({
      level: "warn",
      message: "Honcho backfill skipped issue after sync failure",
      meta: expect.objectContaining({
        issueId: "iss_1",
      }),
    }));
  });

  it("test_connection probes Honcho without creating a Paperclip-scoped workspace id", async () => {
    const { requests } = installFetchMock({ workspaceResponse: { id: "ws_default" } });
    const harness = createHonchoHarness();

    await plugin.definition.setup(harness.ctx);
    const result = await harness.performAction("test-connection", {}) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      workspaceId: "ws_default",
    });
    const workspaceRequest = requests.find((request) => request.url.endsWith("/v3/workspaces"));
    expect(workspaceRequest?.body).toEqual({});
  });

  it("surfaces the latest sync error through issue-memory-status for the issue tab", async () => {
    installFetchMock({ failOn: ["/messages"] });
    const harness = createHonchoHarness();

    await plugin.definition.setup(harness.ctx);
    await expect(harness.performAction("resync-issue", { issueId: "iss_1", companyId: "co_1" })).rejects.toThrow();

    const status = await harness.getData<Record<string, unknown>>("issue-memory-status", {
      issueId: "iss_1",
      companyId: "co_1",
    });

    expect(status.syncEnabled).toBe(true);
    expect(status.config).toMatchObject({
      syncIssueComments: true,
      syncIssueDocuments: false,
      enablePeerChat: false,
    });
    expect(status.lastError).toMatchObject({
      issueId: "iss_1",
      message: expect.stringContaining("forced failure"),
    });
  });

  it("returns setup-status data for the settings page and dashboard widget", async () => {
    installFetchMock();
    const harness = createHonchoHarness();

    await plugin.definition.setup(harness.ctx);

    const initial = await harness.getData<Record<string, unknown>>("setup-status", {
      companyId: "co_1",
    });

    expect(initial.config).toMatchObject({
      honchoApiBaseUrl: "https://api.honcho.dev",
      honchoApiKeySecretRef: "HONCHO_API_KEY",
      workspacePrefix: "paperclip",
      syncIssueComments: true,
      syncIssueDocuments: false,
      enablePeerChat: false,
    });
    expect(initial.validation).toMatchObject({
      ok: true,
      warnings: [],
      errors: [],
    });
    expect(initial.syncEnabled).toBe(true);
    expect(initial.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "base-url", done: true }),
      expect.objectContaining({ key: "secret-ref", done: true }),
      expect.objectContaining({ key: "sync-source", done: true }),
      expect.objectContaining({ key: "backfill", done: false }),
    ]));

    await harness.performAction("backfill-company", { companyId: "co_1" });

    const afterBackfill = await harness.getData<Record<string, unknown>>("setup-status", {
      companyId: "co_1",
    });
    expect(afterBackfill.companyStatus).toMatchObject({
      lastBackfillAt: expect.any(String),
      lastError: null,
    });
    expect(afterBackfill.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "backfill", done: true }),
    ]));
  });
});
