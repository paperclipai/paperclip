import { describe, it, expect, vi } from "vitest";
import { handleIssueUpdated } from "../src/triggers.js";
import type { PluginConfig, CachedIssueState } from "../src/config-schema.js";

const CEO = "506c873e-3a40-4483-9a45-0eb0fa1554bb";
const WALTER = "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9";
const WHI = "9cebf3cf-efe8-4597-a400-f06488900a87";

function baseConfig(): PluginConfig {
  return {
    pushoverUserKeyRef: "key-uuid",
    pushoverAppTokenRef: "token-uuid",
    boardUserId: WALTER,
    clickbackBaseUrl: "https://company.whitestag.ai",
    dryRun: false,
    companies: [
      { companyId: WHI, issuePrefix: "WHI", topAgentIds: [CEO], enabled: true },
    ],
  };
}

function makeCtx(prev: CachedIssueState | null) {
  return {
    state: {
      get: vi.fn(async (s: any) => {
        if (
          s.scopeKind === "issue" &&
          s.scopeId === "iss-1" &&
          s.stateKey === "pushover-watch:last-seen"
        ) {
          return prev;
        }
        return null;
      }),
      set: vi.fn(async () => {}),
    },
    http: { fetch: vi.fn(async () => new Response("{}", { status: 200 })) },
    secrets: { resolve: vi.fn(async (ref: string) => `resolved-${ref}`) },
    issues: { listComments: vi.fn(async () => []) },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as any;
}

function event(over: any = {}) {
  return {
    eventId: "evt-1",
    eventType: "issue.updated",
    occurredAt: "2026-05-11T10:00:00.000Z",
    companyId: WHI,
    entityId: "iss-1",
    entityType: "issue",
    payload: {
      id: "iss-1",
      identifier: "WHI-42",
      title: "Cleanup",
      status: "done",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      ...over,
    },
  };
}

describe("handleIssueUpdated", () => {
  it("fires T1 when CEO task moves to done", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev);
    await handleIssueUpdated(ctx, baseConfig(), event() as any);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] CEO erledigt:/);
    expect(body.get("url")).toBe("https://company.whitestag.ai/WHI/issues/WHI-42");
    expect(body.get("priority")).toBe("0");
  });

  it("does not fire when prev state is unknown (post-bootstrap-gap safety)", async () => {
    const ctx = makeCtx(null);
    await handleIssueUpdated(ctx, baseConfig(), event() as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("fires T2 when status moves to in_review and assigneeUserId is the board user", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev);
    await handleIssueUpdated(
      ctx,
      baseConfig(),
      event({ status: "in_review", assigneeUserId: WALTER }) as any,
    );
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] Review-Handover:/);
  });

  it("fires T3 when status moves to blocked AND latest comment mentions board user", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev);
    ctx.issues.listComments = vi.fn(async () => [
      {
        id: "c-1",
        body: `Waiting on [@Walter](user://${WALTER})`,
        authorAgentId: "agent-x",
        authorUserId: null,
        createdAt: new Date(),
      },
    ]);
    await handleIssueUpdated(ctx, baseConfig(), event({ status: "blocked" }) as any);
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] Blockiert, braucht dich:/);
    expect(body.get("priority")).toBe("1");
  });

  it("does NOT fire T3 when latest comment doesn't mention board user", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev);
    ctx.issues.listComments = vi.fn(async () => [
      { id: "c-1", body: "no mentions", authorAgentId: "x", authorUserId: null, createdAt: new Date() },
    ]);
    await handleIssueUpdated(ctx, baseConfig(), event({ status: "blocked" }) as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });
});
