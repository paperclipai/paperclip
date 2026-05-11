import { describe, it, expect, vi } from "vitest";
import { bootstrapCompany } from "../src/bootstrap.js";

function makeCtx() {
  const stateStore = new Map<string, unknown>();
  const stateKey = (s: any) =>
    `${s.scopeKind}:${s.scopeId ?? "_"}:${s.stateKey}`;

  return {
    state: {
      get: vi.fn(async (s: any) => stateStore.get(stateKey(s)) ?? null),
      set: vi.fn(async (s: any, v: unknown) => {
        stateStore.set(stateKey(s), v);
      }),
      delete: vi.fn(async (s: any) => {
        stateStore.delete(stateKey(s));
      }),
    },
    issues: {
      list: vi.fn(async ({ status }: { status: string }) => {
        if (status === "in_progress")
          return [
            {
              id: "iss-1",
              status: "in_progress",
              assigneeAgentId: "agent-1",
              assigneeUserId: null,
              updatedAt: new Date("2026-05-11T09:00:00.000Z"),
            },
          ];
        if (status === "in_review")
          return [
            {
              id: "iss-2",
              status: "in_review",
              assigneeAgentId: null,
              assigneeUserId: "user-1",
              updatedAt: new Date("2026-05-11T09:30:00.000Z"),
            },
          ];
        return [];
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as any;
}

describe("bootstrapCompany", () => {
  it("seeds state for all open issues and sets the bootstrap marker", async () => {
    const ctx = makeCtx();
    await bootstrapCompany(ctx, {
      companyId: "company-1",
      issuePrefix: "WHI",
      topAgentIds: ["agent-1"],
    });

    const marker = await ctx.state.get({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "pushover-watch:bootstrap-done",
    });
    expect(marker).not.toBeNull();

    const iss1 = await ctx.state.get({
      scopeKind: "issue",
      scopeId: "iss-1",
      stateKey: "pushover-watch:last-seen",
    });
    expect(iss1).toMatchObject({
      status: "in_progress",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    });

    const iss2 = await ctx.state.get({
      scopeKind: "issue",
      scopeId: "iss-2",
      stateKey: "pushover-watch:last-seen",
    });
    expect(iss2).toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "user-1",
    });
  });

  it("is idempotent — does nothing on the second call", async () => {
    const ctx = makeCtx();
    await bootstrapCompany(ctx, {
      companyId: "company-1",
      issuePrefix: "WHI",
      topAgentIds: ["agent-1"],
    });
    ctx.issues.list.mockClear();
    await bootstrapCompany(ctx, {
      companyId: "company-1",
      issuePrefix: "WHI",
      topAgentIds: ["agent-1"],
    });
    expect(ctx.issues.list).not.toHaveBeenCalled();
  });
});
