import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "comp-1";
const PROJECT_ID = "proj-1";
const ISSUE_ID = "iss-1";
const CHANNEL_ID = "C123";

type SlackCall = {
  url: string;
  body: Record<string, unknown>;
};

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    companyId: COMPANY_ID,
    goalId: null,
    name: "Paperclip",
    description: null,
    context: null,
    status: "planned" as const,
    leadAgentId: null,
    targetDate: null,
    color: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Slack sync should only send title",
    description: "Detailed body lives in thread",
    status: "todo" as const,
    priority: "medium" as const,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1379,
    identifier: "PAP-1379",
    originKind: "manual",
    originId: null,
    originRunId: null,
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function jsonResponse(payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}

function installSlackMock(calls: SlackCall[]) {
  let postCounter = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });

    if (url.endsWith("/chat.postMessage")) {
      postCounter += 1;
      return jsonResponse({ ok: true, ts: `ts-${postCounter}` });
    }

    if (url.endsWith("/chat.update")) {
      return jsonResponse({ ok: true, ts: String(body.ts ?? "ts-1") });
    }

    if (url.endsWith("/pins.add")) {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected Slack API call: ${url}`);
  }));
}

async function setupIssueHarness() {
  const calls: SlackCall[] = [];
  installSlackMock(calls);

  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "issues.update"],
    config: { slackBotToken: "xoxb-test-token" },
  });
  await plugin.definition.setup(harness.ctx);

  harness.seed({
    projects: [makeProject()],
    issues: [makeIssue()],
  });

  await harness.ctx.state.set({
    scopeKind: "project",
    scopeId: PROJECT_ID,
    stateKey: "slack-channel-id",
  }, CHANNEL_ID);

  return { harness, calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("slack-sync plugin", () => {
  it("posts a title-only anchor when issue.created fires", async () => {
    const { harness, calls } = await setupIssueHarness();

    await harness.emit(
      "issue.created",
      { issueId: ISSUE_ID },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );

    const postCalls = calls.filter((call) => call.url.endsWith("/chat.postMessage"));
    expect(postCalls).toHaveLength(2);
    expect(postCalls[0].body.text).toBe("Slack sync should only send title");
    expect(postCalls[0].body.thread_ts).toBeUndefined();
  });

  it("pins the new issue anchor on issue.created", async () => {
    const { harness, calls } = await setupIssueHarness();

    await harness.emit(
      "issue.created",
      { issueId: ISSUE_ID },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );

    const pinCall = calls.find((call) => call.url.endsWith("/pins.add"));
    expect(pinCall).toBeDefined();
    expect(pinCall?.body).toMatchObject({ channel: CHANNEL_ID, timestamp: "ts-1" });
  });

  it("posts the issue description as the first thread reply on issue.created", async () => {
    const { harness, calls } = await setupIssueHarness();

    await harness.emit(
      "issue.created",
      { issueId: ISSUE_ID },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );

    const postCalls = calls.filter((call) => call.url.endsWith("/chat.postMessage"));
    expect(postCalls[1].body.thread_ts).toBe("ts-1");
    expect(String(postCalls[1].body.text)).toContain("Detailed body lives in thread");
    expect(String(postCalls[1].body.text)).toContain("PAP-1379");
  });

  it("writes issue.updated details into the thread without updating the main message when title is unchanged", async () => {
    const { harness, calls } = await setupIssueHarness();

    await harness.ctx.state.set({
      scopeKind: "issue",
      scopeId: ISSUE_ID,
      stateKey: "slack-message-ts",
    }, `${CHANNEL_ID}:ts-1`);
    await harness.ctx.issues.update(
      ISSUE_ID,
      { status: "in_progress", description: "Updated details stay in thread" },
      COMPANY_ID,
    );

    await harness.emit(
      "issue.updated",
      { status: "in_progress", description: "Updated details stay in thread", _previous: { status: "todo" } },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );

    expect(calls.some((call) => call.url.endsWith("/chat.update"))).toBe(false);
    const threadReply = calls.find((call) => call.url.endsWith("/chat.postMessage"));
    expect(threadReply?.body.thread_ts).toBe("ts-1");
    expect(String(threadReply?.body.text)).toContain(":memo: Issue updated");
    expect(String(threadReply?.body.text)).toContain("Updated details stay in thread");
  });

  it("updates the main message only when the title changes, and sends comments to the thread", async () => {
    const { harness, calls } = await setupIssueHarness();

    await harness.ctx.state.set({
      scopeKind: "issue",
      scopeId: ISSUE_ID,
      stateKey: "slack-message-ts",
    }, `${CHANNEL_ID}:ts-1`);
    await harness.ctx.issues.update(
      ISSUE_ID,
      { title: "New issue title", description: "Fresh details" },
      COMPANY_ID,
    );

    await harness.emit(
      "issue.updated",
      { title: "New issue title", _previous: { title: "Slack sync should only send title" } },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );

    harness.seed({
      issueComments: [{
        id: "comment-1",
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        authorAgentId: null,
        authorUserId: null,
        body: "A follow-up comment",
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    });

    await harness.emit(
      "issue.comment.created",
      { commentId: "comment-1" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );

    const updateCall = calls.find((call) => call.url.endsWith("/chat.update"));
    expect(updateCall?.body).toMatchObject({ channel: CHANNEL_ID, ts: "ts-1", text: "New issue title" });

    const postCalls = calls.filter((call) => call.url.endsWith("/chat.postMessage"));
    expect(postCalls).toHaveLength(2);
    expect(postCalls[0].body.thread_ts).toBe("ts-1");
    expect(String(postCalls[0].body.text)).toContain("Fresh details");
    expect(postCalls[1].body).toMatchObject({ channel: CHANNEL_ID, thread_ts: "ts-1", text: "A follow-up comment" });
  });

  it("sends a done notification to the source Slack thread when status changes to done and metadata has source info", async () => {
    const { harness, calls } = await setupIssueHarness();

    const SOURCE_CHANNEL = "C-SOURCE";
    const SOURCE_THREAD_TS = "source-ts-1";

    await harness.ctx.state.set({
      scopeKind: "issue",
      scopeId: ISSUE_ID,
      stateKey: "slack-message-ts",
    }, `${CHANNEL_ID}:ts-1`);
    await harness.ctx.issues.update(
      ISSUE_ID,
      { status: "done", metadata: { sourceChannel: SOURCE_CHANNEL, sourceThreadTs: SOURCE_THREAD_TS } } as Record<string, unknown>,
      COMPANY_ID,
    );

    await harness.emit(
      "issue.updated",
      { status: "done", _previous: { status: "in_progress" } },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );

    const postCalls = calls.filter((call) => call.url.endsWith("/chat.postMessage"));
    const doneNotification = postCalls.find(
      (call) => call.body.channel === SOURCE_CHANNEL && call.body.thread_ts === SOURCE_THREAD_TS,
    );
    expect(doneNotification).toBeDefined();
    expect(String(doneNotification?.body.text)).toContain("✅");
    expect(String(doneNotification?.body.text)).toContain("PAP-1379");
    expect(String(doneNotification?.body.text)).toContain("已完成");
  });

  it("does NOT send a done notification when status changes to done but metadata lacks source info", async () => {
    const { harness, calls } = await setupIssueHarness();

    await harness.ctx.state.set({
      scopeKind: "issue",
      scopeId: ISSUE_ID,
      stateKey: "slack-message-ts",
    }, `${CHANNEL_ID}:ts-1`);
    await harness.ctx.issues.update(
      ISSUE_ID,
      { status: "done" },
      COMPANY_ID,
    );

    await harness.emit(
      "issue.updated",
      { status: "done", _previous: { status: "in_progress" } },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );

    const postCalls = calls.filter((call) => call.url.endsWith("/chat.postMessage"));
    // Should only have the regular thread update, no source-thread notification
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].body.channel).toBe(CHANNEL_ID);
  });

  it("does NOT send a done notification when issue is already done and gets updated again", async () => {
    const { harness, calls } = await setupIssueHarness();

    const SOURCE_CHANNEL = "C-SOURCE";
    const SOURCE_THREAD_TS = "source-ts-1";

    await harness.ctx.state.set({
      scopeKind: "issue",
      scopeId: ISSUE_ID,
      stateKey: "slack-message-ts",
    }, `${CHANNEL_ID}:ts-1`);
    await harness.ctx.issues.update(
      ISSUE_ID,
      { status: "done", metadata: { sourceChannel: SOURCE_CHANNEL, sourceThreadTs: SOURCE_THREAD_TS } } as Record<string, unknown>,
      COMPANY_ID,
    );

    await harness.emit(
      "issue.updated",
      { title: "Renamed", _previous: { title: "Old", status: "done" } },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID },
    );

    const postCalls = calls.filter((call) => call.url.endsWith("/chat.postMessage"));
    const doneNotifications = postCalls.filter(
      (call) => call.body.channel === SOURCE_CHANNEL,
    );
    expect(doneNotifications).toHaveLength(0);
  });
});
