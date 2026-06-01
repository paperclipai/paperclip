import { describe, expect, it, vi } from "vitest";
import plugin from "../worker.js";
import { STATE_KEYS, WEBHOOK_KEYS } from "../constants.js";

const COMPANY = "company-1";
const APPROVAL = "approval-1";
const CHANNEL = "C_APPROVALS";
const TS = "1717200000.000100";

function makeContext(configOverrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Array<(event: any) => Promise<void>>>();
  const jobHandlers = new Map<string, () => Promise<void>>();
  const config = {
    slackTokenRef: "secret:slack-token",
    notifyOnIssueCreated: true,
    notifyOnIssueDone: true,
    notifyOnApprovalCreated: true,
    ...configOverrides,
  };
  return {
    handlers,
    jobHandlers,
    ctx: {
      config: {
        get: vi.fn(async () => config),
      },
      secrets: {
        resolve: vi.fn(async () => "xoxb-test"),
      },
      companies: {
        list: vi.fn(async () => [{ id: "fallback-company" }]),
      },
      issues: {
        list: vi.fn(async () => []),
      },
      agents: {
        list: vi.fn(async () => []),
      },
      events: {
        on: vi.fn((eventType: string, handler: (event: any) => Promise<void>) => {
          const existing = handlers.get(eventType) ?? [];
          handlers.set(eventType, [...existing, handler]);
        }),
        emit: vi.fn(async () => undefined),
      },
      state: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
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
        register: vi.fn((jobKey: string, handler: () => Promise<void>) => {
          jobHandlers.set(jobKey, handler);
        }),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      http: {
        fetch: vi.fn(async () => ({
          status: 200,
          json: async () => ({ ok: true, ts: TS }),
        })),
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
      companyId: COMPANY,
      entityId: "issue-1",
      payload: { identifier: "BLO-1", title: "Created issue" },
    });
    for (const handler of handlers.get("issue.updated") ?? []) await handler({
      eventType: "issue.updated",
      companyId: COMPANY,
      entityId: "issue-1",
      payload: { identifier: "BLO-1", title: "Created issue", status: "done" },
    });
    for (const handler of handlers.get("approval.created") ?? []) await handler({
      eventType: "approval.created",
      companyId: COMPANY,
      entityId: APPROVAL,
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

  it("records approval card lookup state when Slack posts an approval message", async () => {
    const { ctx, handlers } = makeContext({
      approvalsChannelId: CHANNEL,
    });
    await plugin.definition.setup?.(ctx as any);

    for (const handler of handlers.get("approval.created") ?? []) await handler({
      eventType: "approval.created",
      companyId: COMPANY,
      entityId: APPROVAL,
      payload: { type: "request_board_approval", status: "pending" },
    });

    expect(ctx.state.set).toHaveBeenCalledWith(
      {
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: STATE_KEYS.approvalMessage(APPROVAL),
      },
      { channel: CHANNEL, ts: TS },
    );
    expect(ctx.state.set).toHaveBeenCalledWith(
      {
        scopeKind: "company",
        scopeId: COMPANY,
        stateKey: STATE_KEYS.approvalByTs(CHANNEL, TS),
      },
      APPROVAL,
    );
  });

  it("uses configured companyId for Slack Events callbacks without listing companies", async () => {
    const { ctx } = makeContext({
      companyId: COMPANY,
    });
    await plugin.definition.setup?.(ctx as any);

    await plugin.definition.onWebhook?.({
      endpointKey: WEBHOOK_KEYS.slackEvents,
      headers: {},
      rawBody: "{}",
      parsedBody: {
        type: "event_callback",
        event: {
          type: "reaction_added",
          reaction: "white_check_mark",
          user: "U_OMAR",
          item: { channel: CHANNEL, ts: TS },
        },
      },
    } as any);

    expect(ctx.companies.list).not.toHaveBeenCalled();
    expect(ctx.state.get).toHaveBeenCalledWith({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: STATE_KEYS.approvalByTs(CHANNEL, TS),
    });
  });

  it("uses configured companyId for scheduled jobs without listing companies", async () => {
    const { ctx, jobHandlers } = makeContext({
      companyId: COMPANY,
    });
    await plugin.definition.setup?.(ctx as any);

    await jobHandlers.get("check-escalation-timeouts")?.();
    await jobHandlers.get("check-watches")?.();

    expect(ctx.companies.list).not.toHaveBeenCalled();
    expect(ctx.state.get).toHaveBeenCalledWith({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: "escalation-records-index",
    });
    expect(ctx.state.get).toHaveBeenCalledWith({
      scopeKind: "company",
      scopeId: COMPANY,
      stateKey: "recent-watch-events",
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
