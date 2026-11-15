import { beforeEach, describe, expect, it, vi } from "vitest";
import { forbidden } from "../errors.js";

const mocks = vi.hoisted(() => ({
  findActiveServerAdapter: vi.fn(),
  select: vi.fn(),
  prepareManagedAiRuntime: vi.fn(),
}));

vi.mock("../adapters/index.js", () => ({ findActiveServerAdapter: mocks.findActiveServerAdapter }));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ select: mocks.select }) }));
vi.mock("../services/ai-connection-runtime.js", () => ({ prepareManagedAiRuntime: mocks.prepareManagedAiRuntime }));

import {
  normalizeAdapterAiConnectionFields,
  resolveAdapterAiConnectionFields,
  stableAdapterAiConnectionConfig,
} from "../services/adapter-ai-connection-fields.js";

const companyId = "c0000000-0000-4000-8000-000000000001";
const connectionId = "11111111-1111-4111-8111-111111111111";
const grantId = "21111111-1111-4111-8111-111111111111";
const binding = { mode: "shared", provider: "anthropic", method: "subscription", connectionId, grantId };

function declareField(meta: Record<string, unknown> = { harness: "claude_local", providers: ["anthropic"], protocols: ["messages"] }) {
  mocks.findActiveServerAdapter.mockReturnValue({
    getConfigSchema: async () => ({ fields: [
      { key: "judge", label: "Judge", type: "text", meta: { aiConnection: meta } },
      { key: "plain", label: "Plain", type: "text" },
    ] }),
  });
}

function selection(ai: Record<string, unknown>) {
  return { connection: { id: connectionId, config: { ai } }, grant: { id: grantId } };
}

function dbReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.where = () => Promise.resolve(rows);
  return { select: () => chain } as never;
}

beforeEach(() => {
  mocks.findActiveServerAdapter.mockReset();
  mocks.select.mockReset();
  mocks.prepareManagedAiRuntime.mockReset();
});

describe("normalizeAdapterAiConnectionFields", () => {
  it("leaves configs untouched when the adapter declares no connection field", async () => {
    mocks.findActiveServerAdapter.mockReturnValue({ getConfigSchema: async () => ({ fields: [{ key: "plain", label: "P", type: "text" }] }) });
    const config = { plain: "x" };
    await expect(normalizeAdapterAiConnectionFields(dbReturning([]), companyId, config, { adapterType: "ext" })).resolves.toBe(config);
  });

  it("stores the canonical binding after the acting user may use the connection with the declared harness", async () => {
    declareField();
    mocks.select.mockResolvedValue(selection({ provider: "anthropic", method: "subscription" }));
    const ok = await normalizeAdapterAiConnectionFields(dbReturning([]), companyId,
      { judge: binding, plain: "x" }, { adapterType: "ext", actor: { userId: "user-1" } });
    expect(ok).toEqual({ judge: binding, plain: "x" });
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ companyId, userId: "user-1", adapterType: "claude_local", binding }));
  });

  it("rejects a connection the user may not use with 422", async () => {
    declareField();
    mocks.select.mockRejectedValue(forbidden("This connection is not permitted"));
    await expect(normalizeAdapterAiConnectionFields(dbReturning([]), companyId, { judge: binding },
      { adapterType: "ext", actor: { userId: "user-1" } })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a connection whose provider or protocol does not match the declaration", async () => {
    declareField({ harness: "claude_local", protocols: ["responses"] });
    mocks.select.mockResolvedValue(selection({ provider: "anthropic", method: "subscription" }));
    await expect(normalizeAdapterAiConnectionFields(dbReturning([]), companyId, { judge: binding },
      { adapterType: "ext", actor: { userId: "user-1" } })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects bindings carrying unknown properties", async () => {
    declareField();
    await expect(normalizeAdapterAiConnectionFields(dbReturning([]), companyId, { judge: { ...binding, extra: true } },
      { adapterType: "ext", actor: { userId: "user-1" } })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects values that are not fixed connection bindings", async () => {
    declareField();
    for (const value of ["text", { mode: "responsible_user", provider: "anthropic", method: "subscription" }, { mode: "shared" }]) {
      await expect(normalizeAdapterAiConnectionFields(dbReturning([]), companyId, { judge: value },
        { adapterType: "ext", actor: { userId: "user-1" } })).rejects.toMatchObject({ status: 422 });
    }
  });

  it("clears the field for empty values", async () => {
    declareField();
    const result = await normalizeAdapterAiConnectionFields(dbReturning([]), companyId, { judge: null, plain: "x" }, { adapterType: "ext" });
    expect(result).toEqual({ plain: "x" });
  });

  it("checks company scope without an acting user", async () => {
    declareField();
    const row = {
      connection: { config: { ai: { provider: "anthropic", method: "subscription" } } },
      grant: { status: "active", kind: "organization" },
    };
    await expect(normalizeAdapterAiConnectionFields(dbReturning([row]), companyId, { judge: binding }, { adapterType: "ext" }))
      .resolves.toEqual({ judge: binding });
    await expect(normalizeAdapterAiConnectionFields(dbReturning([]), companyId, { judge: binding }, { adapterType: "ext" }))
      .rejects.toMatchObject({ status: 422 });
    await expect(normalizeAdapterAiConnectionFields(dbReturning([{ ...row, grant: { status: "active", kind: "user" } }]), companyId,
      { judge: binding }, { adapterType: "ext" })).rejects.toMatchObject({ status: 422 });
  });
});

describe("resolveAdapterAiConnectionFields", () => {
  const home = "/tmp/paperclip-ai-home";
  function runtime(extra: Record<string, unknown>, routing?: Record<string, unknown>) {
    return {
      accountName: "Team Claude",
      attribution: { provider: "anthropic", method: "subscription" },
      home,
      cleanup: vi.fn(),
      config: {
        managedAiRouting: routing,
        env: { CLAUDE_CONFIG_DIR: `${home}/provider`, HOME: home, ANTHROPIC_API_KEY: "", ...extra },
      },
    };
  }
  const base = { companyId, agentId: "a1", responsibleUserId: "user-1", adapterType: "ext" };

  it("hands the adapter the harness environment for a subscription and reports the runtime for cleanup", async () => {
    declareField();
    const acquired = runtime({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" });
    mocks.prepareManagedAiRuntime.mockResolvedValue(acquired);
    const onRuntime = vi.fn();
    const result = await resolveAdapterAiConnectionFields(dbReturning([]), { ...base, config: { judge: binding }, onRuntime });
    expect(mocks.prepareManagedAiRuntime).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      adapterType: "claude_local", binding, skipProjectAuthCheck: true, responsibleUserId: "user-1",
    }));
    expect(onRuntime).toHaveBeenCalledWith(acquired);
    expect(result.values.judge).toEqual({
      connectionId, name: "Team Claude", provider: "anthropic", method: "subscription", routing: null,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" },
    });
    expect(result.secretValues).toEqual(["oauth-token-value"]);
  });

  it("includes gateway routing and its environment", async () => {
    declareField();
    mocks.prepareManagedAiRuntime.mockResolvedValue({
      ...runtime({ ANTHROPIC_BASE_URL: "https://gateway.example.com", ANTHROPIC_AUTH_TOKEN: "gateway-secret" },
        { kind: "gateway", protocol: "messages", baseUrl: "https://gateway.example.com/", auth: "bearer", models: [] }),
      attribution: { provider: "anthropic", method: "api_key" },
    });
    const result = await resolveAdapterAiConnectionFields(dbReturning([]),
      { ...base, config: { judge: { ...binding, method: "api_key" } }, onRuntime: vi.fn() });
    expect(result.values.judge).toMatchObject({
      method: "api_key",
      routing: { kind: "gateway", protocol: "messages", baseUrl: "https://gateway.example.com" },
      env: { ANTHROPIC_BASE_URL: "https://gateway.example.com", ANTHROPIC_AUTH_TOKEN: "gateway-secret" },
    });
  });

  it("reports a resolution failure on the field and keeps the run going", async () => {
    declareField();
    mocks.prepareManagedAiRuntime.mockRejectedValue(new Error("Reconnect or validate the selected AI account"));
    const result = await resolveAdapterAiConnectionFields(dbReturning([]), { ...base, config: { judge: binding }, onRuntime: vi.fn() });
    expect(result.values.judge).toEqual({ connectionId, error: "Reconnect or validate the selected AI account" });
    expect(result.secretValues).toEqual([]);
  });

  it("fails the field, after reporting the runtime, when the connection no longer matches the declaration", async () => {
    declareField({ harness: "claude_local", protocols: ["responses"] });
    const acquired = runtime({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" });
    mocks.prepareManagedAiRuntime.mockResolvedValue(acquired);
    const onRuntime = vi.fn();
    const result = await resolveAdapterAiConnectionFields(dbReturning([]), { ...base, config: { judge: binding }, onRuntime });
    expect(onRuntime).toHaveBeenCalledWith(acquired);
    expect(result.values.judge).toMatchObject({ connectionId, error: expect.any(String) });
    expect(result.values.judge.env).toBeUndefined();
  });

  it("skips unset fields and non-connection adapters", async () => {
    declareField();
    const result = await resolveAdapterAiConnectionFields(dbReturning([]), { ...base, config: {}, onRuntime: vi.fn() });
    expect(result.values).toEqual({});
    expect(mocks.prepareManagedAiRuntime).not.toHaveBeenCalled();
  });
});

describe("stableAdapterAiConnectionConfig", () => {
  it("drops volatile credentials from resolved values but keeps stored bindings", () => {
    const resolved = { connectionId, name: "n", env: { ANTHROPIC_API_KEY: "k" } };
    expect(stableAdapterAiConnectionConfig({ judge: resolved, stored: binding, other: "x" }))
      .toEqual({ judge: { connectionId }, stored: binding, other: "x" });
  });
});
