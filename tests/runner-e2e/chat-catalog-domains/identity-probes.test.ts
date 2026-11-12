import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { cleanupIdentityProbes, identityDefinition, probeAgentPermission, readAgentResource } from "./identity-support.js";
afterEach(() => vi.restoreAllMocks());
function context() {
  const create = vi.fn(async () => ({ id: "key", token: "attempt-private-token" }));
  const revoke = vi.fn(async () => {}); const privateSecrets: string[] = [];
  const ctx = { input: { nonce: "nonce", privateSecrets, fixtures: { agent: { id: "ceo" } }, api: { baseURL: "http://127.0.0.1:3100", postSensitive: create, delete: revoke } } } as unknown as ChatCatalogContext;
  return { ctx, create, revoke, privateSecrets };
}
describe("identity attempt-private credential lifetime", () => {
  it("shares one credential for concurrent probes but performs every read freshly", async () => {
    const f = context(); let reads = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ revision: ++reads }), { status: 200 }));
    const results = await Promise.all([readAgentResource(f.ctx, "/api/issues/task"), readAgentResource(f.ctx, "/api/issues/task")]);
    expect(results.map(row => row.data)).toEqual([{ revision: 1 }, { revision: 2 }]);
    await probeAgentPermission(f.ctx, "/api/companies/company/budgets/policies", "POST", {});
    expect(f.create).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(3); expect(f.revoke).not.toHaveBeenCalled();
    expect(f.privateSecrets).toEqual(["attempt-private-token"]);
    await cleanupIdentityProbes(f.ctx); await cleanupIdentityProbes(f.ctx);
    expect(f.revoke).toHaveBeenCalledTimes(1);
  });
  it("retains cleanup responsibility after a transport failure and isolates attempts", async () => {
    const a = context(); const b = context();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("transport failed"));
    await expect(readAgentResource(a.ctx, "/api/issues/task")).rejects.toThrow();
    await expect(readAgentResource(b.ctx, "/api/issues/task")).rejects.toThrow();
    await cleanupIdentityProbes(a.ctx); await cleanupIdentityProbes(b.ctx);
    expect(a.create).toHaveBeenCalledTimes(1); expect(b.create).toHaveBeenCalledTimes(1);
    expect(a.revoke).toHaveBeenCalledTimes(1); expect(b.revoke).toHaveBeenCalledTimes(1);
  });
  it("cleans a partial setup and composes the domain cleanup", async () => {
    const f = context(); vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const ownCleanup = vi.fn(async () => {});
    const definition = identityDefinition("access.private-resource", async ctx => { await readAgentResource(ctx, "/api/issues/task"); throw new Error("setup failed"); },
      () => ({ passed: false, checks: [] }), { cleanup: ownCleanup });
    await expect(definition.setup(f.ctx)).rejects.toThrow("setup failed"); expect(f.revoke).toHaveBeenCalledTimes(1);
    await definition.cleanup!(f.ctx, {}); expect(ownCleanup).toHaveBeenCalledTimes(1);
  });
  it("rejects absent redaction ownership and foreign URLs before issuing credentials", async () => {
    const f = context();
    await expect(readAgentResource(f.ctx, "https://elsewhere.test/api/issues/task")).rejects.toThrow("escaped");
    delete f.ctx.input.privateSecrets;
    await expect(readAgentResource(f.ctx, "/api/issues/task")).rejects.toThrow("redaction"); expect(f.create).not.toHaveBeenCalled();
  });
});
