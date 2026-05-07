import { describe, it, expect, vi } from "vitest";
import { handleIssueOpened } from "../src/handlers/issue-opened.js";
import { acquireDelivery } from "../src/idempotency.js";
import fixture from "./fixtures/issue-opened.json" with { type: "json" };

const config = {
  hmacSecret: "x",
  ceoAgentId: "agent-ceo",
  labelGate: "agent-eligible",
  repoToProject: { "acme/sample-repo": "project-1" },
  companyId: "company-1",
};

describe("idempotency end-to-end (PRD primary metric)", () => {
  it("5 deliveries of the same payload create exactly 1 task", async () => {
    const stateStore = new Map<string, string>();
    const issueStore = new Map<string, { id: string; originKind: string; originId: string }>();
    const ctx = {
      state: {
        get: async (s: any) => stateStore.get(s.stateKey) ?? null,
        set: async (s: any, v: string) => { stateStore.set(s.stateKey, v); },
      },
      issues: {
        list: vi.fn(async (q: any) => {
          for (const v of issueStore.values()) {
            if (v.originKind === q.originKind && v.originId === q.originId) return [{ id: v.id }];
          }
          return [];
        }),
        create: vi.fn(async (input: any) => {
          const id = `issue-${issueStore.size + 1}`;
          issueStore.set(id, { id, originKind: input.originKind, originId: input.originId });
          return { id };
        }),
      },
      config,
    };
    const deliveryId = "delivery-abc-123";
    let runs = 0;
    for (let i = 0; i < 5; i++) {
      const acquired = await acquireDelivery(ctx.state as any, config.companyId, deliveryId);
      if (!acquired) continue;
      await handleIssueOpened(fixture as any, ctx as any, config);
      runs++;
    }
    expect(runs).toBe(1);
    expect(ctx.issues.create).toHaveBeenCalledOnce();
    expect(issueStore.size).toBe(1);
  });

  it("if state layer is bypassed, origin lookup still prevents duplicates", async () => {
    const issueStore = new Map<string, { id: string; originKind: string; originId: string }>();
    const ctx = {
      issues: {
        list: vi.fn(async (q: any) => {
          for (const v of issueStore.values()) {
            if (v.originKind === q.originKind && v.originId === q.originId) return [{ id: v.id }];
          }
          return [];
        }),
        create: vi.fn(async (input: any) => {
          const id = `issue-${issueStore.size + 1}`;
          issueStore.set(id, { id, originKind: input.originKind, originId: input.originId });
          return { id };
        }),
      },
      config,
    };
    for (let i = 0; i < 5; i++) {
      await handleIssueOpened(fixture as any, ctx as any, config);
    }
    expect(issueStore.size).toBe(1);
    expect(ctx.issues.create).toHaveBeenCalledOnce();
  });
});
