import { describe, expect, it, vi } from "vitest";
import plugin from "../worker.js";
import { WEBHOOK_KEYS } from "../constants.js";

function makeContext() {
  const handlers = new Map<string, Array<(event: any) => Promise<void>>>();
  return {
    handlers,
    ctx: {
      config: {
        get: vi.fn(async () => ({
          slackTokenRef: "secret:slack-token",
          notifyOnIssueCreated: true,
          notifyOnIssueDone: true,
          notifyOnApprovalCreated: true,
        })),
      },
      secrets: {
        resolve: vi.fn(async () => "xoxb-test"),
      },
      events: {
        on: vi.fn((eventType: string, handler: (event: any) => Promise<void>) => {
          const existing = handlers.get(eventType) ?? [];
          handlers.set(eventType, [...existing, handler]);
        }),
      },
      state: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
      },
      metrics: {
        write: vi.fn(async () => undefined),
      },
      activity: {
        log: vi.fn(async () => undefined),
      },
      tools: {
        register: vi.fn(),
      },
      webhooks: {
        register: vi.fn(),
      },
      data: {
        register: vi.fn(),
      },
      actions: {
        register: vi.fn(),
      },
      jobs: {
        register: vi.fn(),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      http: {
        fetch: vi.fn(),
      },
    },
  };
}

describe("Slack notifications", () => {
  it("records failed notification metrics when no Slack channel resolves", async () => {
    const { ctx, handlers } = makeContext();
    await plugin.definition.setup?.(ctx as any);

    for (const handler of handlers.get("issue.created") ?? []) await handler({
      eventType: "issue.created",
      companyId: "company-1",
      entityId: "issue-1",
      payload: { identifier: "BLO-1", title: "Created issue" },
    });
    for (const handler of handlers.get("issue.updated") ?? []) await handler({
      eventType: "issue.updated",
      companyId: "company-1",
      entityId: "issue-1",
      payload: { identifier: "BLO-1", title: "Created issue", status: "done" },
    });
    for (const handler of handlers.get("approval.created") ?? []) await handler({
      eventType: "approval.created",
      companyId: "company-1",
      entityId: "approval-1",
      payload: { type: "request_board_approval", status: "pending" },
    });

    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.notifications.failed", 1, {
      event_type: "issue.created",
      error_code: "no_channel",
    });
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.notifications.failed", 1, {
      event_type: "issue.updated",
      error_code: "no_channel",
    });
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.notifications.failed", 1, {
      event_type: "approval.created",
      error_code: "no_channel",
    });
  });

  it("does not process mutating approval interactivity without a signing secret", async () => {
    const { ctx } = makeContext();
    await plugin.definition.setup?.(ctx as any);

    await plugin.definition.onWebhook?.({
      endpointKey: WEBHOOK_KEYS.interactivity,
      headers: {},
      rawBody: "",
      parsedBody: {
        payload: JSON.stringify({
          type: "block_actions",
          response_url: "https://hooks.slack.test/action",
          user: { id: "U_OMAR" },
          actions: [{ action_id: "approval_approve", value: "approval-1" }],
        }),
      },
    } as any);

    expect(ctx.http.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/approvals/"),
      expect.any(Object),
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Rejected mutating Slack approval webhook: missing Slack signing secret",
      { source: "interactivity" },
    );
  });
});
