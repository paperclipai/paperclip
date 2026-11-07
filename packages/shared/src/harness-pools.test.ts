import { describe, expect, it } from "vitest";
import { aiConnectionPoolConfigSchema } from "./ai-connection-router.js";
import { agentRuntimeConfigSchema } from "./validators/agent.js";
import { harnessPoolConfigSchema, harnessPoolToRuntimeConfig, decodeHarnessPoolConfig, harnessPoolBindingSchema, effectiveAiConnectionInput } from "./harness-pools.js";

const binding = { mode: "delegated" as const, provider: "openai" as const, method: "api_key" as const,
  connectionId: "11111111-1111-4111-8111-111111111111", grantId: "22222222-2222-4222-8222-222222222222" };
const member = { id: "33333333-3333-4333-8333-333333333333", harness: { type: "codex" as const }, connection: binding, model: "configured-model" };
const pool = { schemaVersion: 2 as const, kind: "harness_pool" as const, name: "Smart", enabled: true, mode: "failover" as const, members: [member] };

describe("harness pool contracts", () => {
  it("projects Pool intent into the existing authorized connection boundary without mutating it", () => {
    const runtime = { harnessPool: { poolId: binding.connectionId } };
    expect(effectiveAiConnectionInput(runtime)).toEqual({ mode: "router", connectionId: binding.connectionId });
    expect(runtime).toEqual({ harnessPool: { poolId: binding.connectionId } });
    expect(effectiveAiConnectionInput({ aiConnection: binding })).toEqual(binding);
    expect(() => effectiveAiConnectionInput({ ...runtime, aiConnection: binding })).toThrow();
    expect(() => effectiveAiConnectionInput({ harnessPool: { poolId: "invalid" } })).toThrow();
  });
  it("round trips a versioned runtime envelope without changing the concrete member", () => {
    const stored = harnessPoolToRuntimeConfig(pool);
    expect(aiConnectionPoolConfigSchema.parse(stored)).toEqual(stored);
    expect(decodeHarnessPoolConfig(stored)).toEqual({ kind: "harness_pool", config: pool });
    expect(stored.members[0]).toMatchObject({ binding, profile: { provider: "codex", model: member.model } });
  });
  it("keeps V1 records legacy and never opts them into Pool execution", () => {
    const old = aiConnectionPoolConfigSchema.parse({ name: "Old", enabled: true, mode: "failover", members: [{ id: member.id, binding, profile: { provider: "codex", model: member.model } }] });
    expect(decodeHarnessPoolConfig(old)).toEqual({ kind: "legacy", config: old });
  });
  it("permits different models on the same account but rejects identical configurations", () => {
    const second = { ...member, id: "44444444-4444-4444-8444-444444444444", model: "second-model" };
    expect(harnessPoolConfigSchema.safeParse({ ...pool, members: [member, second] }).success).toBe(true);
    expect(aiConnectionPoolConfigSchema.safeParse(harnessPoolToRuntimeConfig({ ...pool, members: [member, second] })).success).toBe(true);
    expect(harnessPoolConfigSchema.safeParse({ ...pool, members: [member, { ...second, model: member.model }] }).success).toBe(false);
  });
  it("requires explicit account grants and caps pools at100 members", () => {
    expect(harnessPoolConfigSchema.safeParse({ ...pool, members: [{ ...member, connection: { mode: "responsible_user" } }] }).success).toBe(false);
    const members = Array.from({ length: 100 }, (_, i) => ({ ...member, id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`, model: `model-${i}` }));
    expect(harnessPoolConfigSchema.safeParse({ ...pool, members }).success).toBe(true);
    expect(harnessPoolConfigSchema.safeParse({ ...pool, members: [...members, { ...member, model: "overflow" }] }).success).toBe(false);
    expect(harnessPoolBindingSchema.safeParse({ poolId: binding.connectionId }).success).toBe(true);
  });
  it("rejects conflicting agent connection authority and partial version markers", () => {
    expect(agentRuntimeConfigSchema.safeParse({ harnessPool: { poolId: binding.connectionId } }).success).toBe(true);
    expect(agentRuntimeConfigSchema.safeParse({ harnessPool: { poolId: binding.connectionId }, aiConnection: binding }).success).toBe(false);
    const stored = harnessPoolToRuntimeConfig(pool);
    expect(aiConnectionPoolConfigSchema.safeParse({ ...stored, schemaVersion: undefined }).success).toBe(false);
    expect(aiConnectionPoolConfigSchema.safeParse({ ...stored, kind: undefined }).success).toBe(false);
  });
});
