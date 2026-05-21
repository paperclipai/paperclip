import { describe, expect, it } from "vitest";
import type {
  AdapterRuntimeIdentityContext,
  AdapterRuntimeIdentityResult,
  ServerAdapterModule,
} from "./types.js";

const runtimeIdentityAdapter: ServerAdapterModule = {
  type: "test",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  ensureRuntimeIdentity: async (
    ctx: AdapterRuntimeIdentityContext,
  ): Promise<AdapterRuntimeIdentityResult> => ({
    adapterConfig: ctx.adapterConfig,
    metadata: ctx.metadata,
    detail: { ok: true },
  }),
};

describe("runtime identity adapter contract", () => {
  it("allows server adapters to expose an idempotent runtime identity hook", async () => {
    const result = await runtimeIdentityAdapter.ensureRuntimeIdentity?.({
      companyId: "company-1",
      companyName: "Acme",
      agentId: "agent-1",
      agentName: "Reviewer",
      adapterType: "test",
      adapterConfig: { env: { EXISTING: "1" } },
      metadata: { existing: true },
    });

    expect(result?.detail).toEqual({ ok: true });
  });

  it("allows the initial null metadata state", async () => {
    const result = await runtimeIdentityAdapter.ensureRuntimeIdentity?.({
      companyId: "company-1",
      companyName: "Acme",
      agentId: "agent-1",
      agentName: "Reviewer",
      adapterType: "test",
      adapterConfig: {},
      metadata: null,
    });

    expect(result?.metadata).toBeNull();
  });
});
