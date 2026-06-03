import { describe, expect, it, vi } from "vitest";
import { registerPartnerBridge, type RegisterDeps } from "./register.js";
import { FakePaperclipApi } from "./paperclip/api.js";
import { MemoryStore } from "./store/memory-store.js";
import { MockHermesConnector } from "./hermes/mock.js";
import type { LinkConfig } from "./types.js";

const LINK: LinkConfig = {
  linkId: "L",
  companyA: { companyId: "A", channelIssueId: "iss-A", label: "Rossignol" },
  companyB: { companyId: "B", channelIssueId: "iss-B", label: "PCC" },
  transport: { telegramChat: "chat:1", emailA: "a@x.com", emailB: "b@x.com" },
};

function fakeCtx() {
  const jobs = new Map<string, Function>(); const data = new Map<string, Function>(); const actions = new Map<string, Function>();
  return {
    jobs: { register: (k: string, fn: Function) => jobs.set(k, fn) },
    data: { register: (k: string, fn: Function) => data.set(k, fn) },
    actions: { register: (k: string, fn: Function) => actions.set(k, fn) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    _maps: { jobs, data, actions },
  };
}

function deps(): RegisterDeps {
  return { api: new FakePaperclipApi(), store: new MemoryStore(), hermes: new MockHermesConnector(), links: [LINK], inboundSecret: "s3cret" };
}

describe("registerPartnerBridge", () => {
  it("registers bridge-sync job, inbound action, health data", () => {
    const ctx = fakeCtx();
    registerPartnerBridge(ctx as never, deps());
    expect([...ctx._maps.jobs.keys()]).toContain("bridge-sync");
    expect([...ctx._maps.actions.keys()]).toContain("inbound");
    expect([...ctx._maps.data.keys()]).toContain("health");
  });
  it("inbound action rejects a wrong secret", async () => {
    const ctx = fakeCtx(); const d = deps();
    registerPartnerBridge(ctx as never, d);
    const res = await ctx._maps.actions.get("inbound")!({ linkId: "L", channel: "telegram", from: "x", body: "hi", secret: "WRONG" });
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
  });
  it("inbound action with correct secret routes a message", async () => {
    const ctx = fakeCtx(); const d = deps();
    registerPartnerBridge(ctx as never, d);
    const res = await ctx._maps.actions.get("inbound")!({ linkId: "L", channel: "email", from: "pcc", body: "réponse", secret: "s3cret" });
    expect(res).toMatchObject({ ok: true });
    expect((await (d.api as FakePaperclipApi).listComments("iss-B")).length).toBe(1);
  });
});
