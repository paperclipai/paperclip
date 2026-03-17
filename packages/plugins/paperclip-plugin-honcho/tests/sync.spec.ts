import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/worker.js";
import { buildDefaultFixtures, createHonchoHarness, installFetchMock, requestsMatching } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("honcho sync", () => {
  it("creates a session on issue.created without appending when no syncable content exists", async () => {
    const { requests } = installFetchMock();
    const harness = createHonchoHarness({
      seed: {
        issueComments: [],
        issueDocuments: [],
        documentRevisions: [],
      },
    });

    await plugin.definition.setup(harness.ctx);
    await harness.emit("issue.created", {}, {
      entityId: "iss_1",
      entityType: "issue",
      companyId: "co_1",
    });

    expect(requestsMatching(requests, "/sessions").length).toBeGreaterThan(0);
    expect(requestsMatching(requests, "/messages")).toHaveLength(0);
  });

  it("syncs only unsynced comments, dedupes replayed events, and includes provenance", async () => {
    const { requests } = installFetchMock();
    const harness = createHonchoHarness();

    await plugin.definition.setup(harness.ctx);
    await harness.emit("issue.comment.created", { commentId: "c_2" }, {
      entityId: "iss_1",
      entityType: "issue",
      companyId: "co_1",
    });
    await harness.emit("issue.comment.created", { commentId: "c_2" }, {
      entityId: "iss_1",
      entityType: "issue",
      companyId: "co_1",
    });

    const messageRequests = requestsMatching(requests, "/messages");
    expect(messageRequests).toHaveLength(1);
    const messages = (messageRequests[0]?.body?.messages ?? []) as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.metadata).toMatchObject({
      sourceSystem: "paperclip",
      issueId: "iss_1",
      commentId: "c_1",
      contentType: "issue_comment",
    });
    expect(messages[1]?.metadata).toMatchObject({
      sourceSystem: "paperclip",
      issueId: "iss_1",
      commentId: "c_2",
      contentType: "issue_comment",
    });

    const state = harness.getState({
      scopeKind: "issue",
      scopeId: "iss_1",
      namespace: "honcho",
      stateKey: "issue-sync-status",
    }) as Record<string, unknown>;
    expect(state.lastSyncedCommentId).toBe("c_2");
  });

  it("marks blank comments as synced without appending empty Honcho messages", async () => {
    const { requests } = installFetchMock();
    const fixtures = buildDefaultFixtures();
    const harness = createHonchoHarness({
      seed: {
        issueComments: [
          ...fixtures.issueComments,
          {
            ...fixtures.issueComments[1],
            id: "c_3",
            body: "   ",
            createdAt: new Date("2026-03-15T12:03:00.000Z"),
            updatedAt: new Date("2026-03-15T12:03:00.000Z"),
          },
        ],
      },
    });

    await plugin.definition.setup(harness.ctx);
    await harness.emit("issue.comment.created", { commentId: "c_3" }, {
      entityId: "iss_1",
      entityType: "issue",
      companyId: "co_1",
    });

    const messageRequests = requestsMatching(requests, "/messages");
    expect(messageRequests).toHaveLength(1);
    const messages = (messageRequests[0]?.body?.messages ?? []) as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.id)).not.toContain("issue_comment:c_3");

    const state = harness.getState({
      scopeKind: "issue",
      scopeId: "iss_1",
      namespace: "honcho",
      stateKey: "issue-sync-status",
    }) as Record<string, unknown>;
    expect(state.lastSyncedCommentId).toBe("c_3");
  });

  it("replays the full issue history on resync_issue after an incremental sync", async () => {
    const { requests } = installFetchMock();
    const harness = createHonchoHarness();

    await plugin.definition.setup(harness.ctx);
    await harness.emit("issue.comment.created", { commentId: "c_2" }, {
      entityId: "iss_1",
      entityType: "issue",
      companyId: "co_1",
    });
    await harness.performAction("resync-issue", { issueId: "iss_1", companyId: "co_1" });

    const messageRequests = requestsMatching(requests, "/messages");
    expect(messageRequests).toHaveLength(2);
    for (const request of messageRequests) {
      expect((request.body?.messages ?? [])).toHaveLength(2);
    }

    const state = harness.getState({
      scopeKind: "issue",
      scopeId: "iss_1",
      namespace: "honcho",
      stateKey: "issue-sync-status",
    }) as Record<string, unknown>;
    expect(typeof state.replayRequestedAt).toBe("string");
    expect(state.replayInProgress).toBe(false);
  });

  it("records replay failures and clears replayInProgress", async () => {
    const harness = createHonchoHarness();
    installFetchMock({ failOn: ["/messages"] });

    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction("resync-issue", { issueId: "iss_1", companyId: "co_1" })).rejects.toThrow("forced failure");

    const state = harness.getState({
      scopeKind: "issue",
      scopeId: "iss_1",
      namespace: "honcho",
      stateKey: "issue-sync-status",
    }) as Record<string, unknown>;
    expect(state.replayInProgress).toBe(false);
    expect(state.lastError).toMatchObject({
      issueId: "iss_1",
      message: expect.stringContaining("forced failure"),
    });
  });

  it("ignores document events when document sync is disabled", async () => {
    const { requests } = installFetchMock();
    const harness = createHonchoHarness();

    await plugin.definition.setup(harness.ctx);
    await harness.emit("issue.document.updated", { key: "design" }, {
      entityId: "iss_1",
      entityType: "issue",
      companyId: "co_1",
    });

    expect(requestsMatching(requests, "/messages")).toHaveLength(0);
    expect(harness.getState({
      scopeKind: "issue",
      scopeId: "iss_1",
      namespace: "honcho",
      stateKey: "issue-sync-status",
    })).toBeUndefined();
  });

  it("syncs document revisions with section provenance and dedupes repeated document events", async () => {
    const { requests } = installFetchMock();
    const harness = createHonchoHarness({
      config: {
        syncIssueComments: false,
        syncIssueDocuments: true,
      },
    });

    await plugin.definition.setup(harness.ctx);
    await harness.emit("issue.document.updated", { key: "design" }, {
      entityId: "iss_1",
      entityType: "issue",
      companyId: "co_1",
    });
    await harness.emit("issue.document.updated", { key: "design" }, {
      entityId: "iss_1",
      entityType: "issue",
      companyId: "co_1",
    });

    const messageRequests = requestsMatching(requests, "/messages");
    expect(messageRequests).toHaveLength(1);
    const messages = (messageRequests[0]?.body?.messages ?? []) as Array<Record<string, unknown>>;
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.metadata).toMatchObject({
        sourceSystem: "paperclip",
        issueId: "iss_1",
        contentType: "issue_document_section",
      });
      expect((message.metadata as Record<string, unknown>).documentRevisionId).toBeTypeOf("string");
      expect((message.metadata as Record<string, unknown>).sectionKey).toBeTypeOf("string");
    }

    const state = harness.getState({
      scopeKind: "issue",
      scopeId: "iss_1",
      namespace: "honcho",
      stateKey: "issue-sync-status",
    }) as Record<string, unknown>;
    expect(state.lastSyncedDocumentRevisionId).toBe("rev_2");
  });

  it("isolates document sync failures so the event bus does not reject the event", async () => {
    installFetchMock({ failOn: ["/messages"] });
    const harness = createHonchoHarness({
      config: {
        syncIssueComments: false,
        syncIssueDocuments: true,
      },
    });

    await plugin.definition.setup(harness.ctx);

    await expect(harness.emit("issue.document.updated", { key: "design" }, {
      entityId: "iss_1",
      entityType: "issue",
      companyId: "co_1",
    })).resolves.toBeUndefined();

    expect(harness.logs).toContainEqual(expect.objectContaining({
      level: "warn",
      message: "Honcho sync on issue.document.updated failed",
    }));
  });

  it("avoids duplicate workspace upserts during append and context refresh", async () => {
    const { requests } = installFetchMock();
    const harness = createHonchoHarness();

    await plugin.definition.setup(harness.ctx);
    await harness.emit("issue.comment.created", { commentId: "c_2" }, {
      entityId: "iss_1",
      entityType: "issue",
      companyId: "co_1",
    });

    expect(requests.filter((request) => request.url.endsWith("/v3/workspaces"))).toHaveLength(2);
  });
});
