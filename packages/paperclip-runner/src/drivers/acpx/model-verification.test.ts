import { describe, expect, it, vi } from "vitest";

import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { createAcpxEffectiveModelGate, requireVerifiedAcpxModel } from "./model-verification.js";

describe("ACPX requested model verification", () => {
  it.each(["claude", "codex", "pi", "grok", "cursor", "copilot"] as const)("selects and verifies an unlisted model unchanged with %s", async agent => {
    const model = "custom/model[context=272k,reasoning=medium]";
    let currentModelId = "default";
    const getStatus = vi.fn(async () => ({
      models: { currentModelId, availableModelIds: ["default"] },
    }));
    const setModel = vi.fn(async (selected: string) => { currentModelId = selected; });
    await expect(requireVerifiedAcpxModel(
      { getStatus, setModel }, resolveQualifiedAcpxProfile(agent, model),
    )).resolves.toMatchObject({ models: { currentModelId: model } });
    expect(setModel).toHaveBeenCalledExactlyOnceWith(model);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("propagates a provider's model rejection without selecting a fallback", async () => {
    const rejected = new Error("Model is not available for this account");
    const getStatus = vi.fn(async () => ({ models: { currentModelId: "default" } }));
    const setModel = vi.fn(async () => { throw rejected; });
    await expect(requireVerifiedAcpxModel(
      { getStatus, setModel }, resolveQualifiedAcpxProfile("codex", "unavailable-model"),
    )).rejects.toBe(rejected);
    expect(setModel).toHaveBeenCalledExactlyOnceWith("unavailable-model");
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact model already reported by the provider", async () => {
    const getStatus = vi.fn(async () => ({
      models: {
        currentModelId: "gpt-5.6-sol",
        availableModelIds: ["gpt-5.6-sol"],
      },
    }));
    const setModel = vi.fn(async () => undefined);

    await expect(
      requireVerifiedAcpxModel(
        { getStatus, setModel },
        resolveQualifiedAcpxProfile("codex", "gpt-5.6-sol"),
      ),
    ).resolves.toMatchObject({
      models: { currentModelId: "gpt-5.6-sol" },
    });
    expect(setModel).not.toHaveBeenCalled();
  });

  it("accepts and normalizes Claude's requested ACP selector", async () => {
    const setModel = vi.fn(async () => undefined);
    const getStatus = vi.fn(async () => ({
      models: {
        currentModelId: "claude-sonnet-5",
        availableModelIds: ["default", "claude-sonnet-5", "opus"],
      },
    }));

    await expect(
      requireVerifiedAcpxModel(
        { getStatus, setModel },
        resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"),
      ),
    ).resolves.toMatchObject({
      models: {
        currentModelId: "claude-sonnet-5",
        availableModelIds: ["default", "claude-sonnet-5", "opus"],
      },
    });
    expect(setModel).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("selects Claude's requested ACP selector from a stale default", async () => {
    let selected = false;
    const setModel = vi.fn(async (model: string) => {
      expect(model).toBe("claude-sonnet-5");
      selected = true;
    });
    const getStatus = vi.fn(async () => ({
      models: {
        currentModelId: selected ? "claude-sonnet-5" : "default",
        availableModelIds: ["default", "claude-sonnet-5", "opus"],
      },
    }));

    await expect(
      requireVerifiedAcpxModel(
        { getStatus, setModel },
        resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"),
      ),
    ).resolves.toMatchObject({
      models: {
        currentModelId: "claude-sonnet-5",
        availableModelIds: ["default", "claude-sonnet-5", "opus"],
      },
    });
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith("claude-sonnet-5");
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("selects a stale default before accepting an exact-selector profile", async () => {
    let selected = false;
    const setModel = vi.fn(async () => {
      selected = true;
    });
    const getStatus = vi.fn(async () => ({
      models: {
        currentModelId: selected ? "gpt-5.6-sol" : "default",
        availableModelIds: ["default", "gpt-5.6-sol"],
      },
    }));

    await requireVerifiedAcpxModel(
      { getStatus, setModel },
      resolveQualifiedAcpxProfile("codex", "gpt-5.6-sol"),
    );
    expect(setModel).toHaveBeenCalledWith("gpt-5.6-sol");
  });

  it("fails closed when status or model selection is unavailable", async () => {
    const profile = resolveQualifiedAcpxProfile("codex", "gpt-5.6-sol");
    await expect(requireVerifiedAcpxModel({}, profile)).rejects.toThrow(
      /cannot verify its effective model/,
    );
    await expect(
      requireVerifiedAcpxModel(
        {
          getStatus: async () => ({
            models: { currentModelId: "default", availableModelIds: [] },
          }),
        },
        profile,
      ),
    ).rejects.toThrow(/config options/);
  });

  it("rejects a provider that ignores the requested model selection", async () => {
    const profile = resolveQualifiedAcpxProfile(
      "pi",
      "openrouter/deepseek/deepseek-v4-flash-0731",
    );
    await expect(
      requireVerifiedAcpxModel(
        {
          getStatus: async () => ({
            models: {
              currentModelId: "openrouter/other",
              availableModelIds: ["openrouter/other"],
            },
          }),
          setModel: async () => undefined,
        },
        profile,
      ),
    ).rejects.toThrow(/effective model mismatch/);
  });
});

describe("ACPX effective model gate", () => {
  const config = (model: string) => [{ id: "model", category: "model", type: "select", currentValue: model, options: [] }];
  const loaded = (gate: ReturnType<typeof createAcpxEffectiveModelGate>, result: unknown) => {
    gate.observe("outbound", { jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s" } });
    gate.observe("inbound", { jsonrpc: "2.0", id: 1, result });
  };

  it("admits a prompt only after the provider reports the expected model", () => {
    const gate = createAcpxEffectiveModelGate("model-a");
    gate.assertActive();
    loaded(gate, { configOptions: config("model-b") });
    expect(() => gate.assertActive()).toThrow(expect.objectContaining({ code: "ACPX_EFFECTIVE_MODEL_MISMATCH" }));
    gate.observe("outbound", { jsonrpc: "2.0", id: 2, method: "session/set_config_option", params: { sessionId: "s", configId: "model", value: "model-a" } });
    gate.observe("inbound", { jsonrpc: "2.0", id: 2, result: { configOptions: config("model-a") } });
    gate.assertActive();
  });

  it("fails closed when a load reports no model or an acknowledgement disagrees", () => {
    const gate = createAcpxEffectiveModelGate("model-a");
    loaded(gate, { sessionId: "s" });
    expect(() => gate.assertActive()).toThrow(/received unverified/);
    gate.observe("outbound", { jsonrpc: "2.0", id: 2, method: "session/set_config_option", params: { sessionId: "s", configId: "model", value: "model-a" } });
    gate.observe("inbound", { jsonrpc: "2.0", id: 2, result: { configOptions: config("model-c") } });
    expect(() => gate.assertActive()).toThrow(/received model-c/);
  });

  it("follows provider config updates and legacy model metadata, and resets per connection", () => {
    const gate = createAcpxEffectiveModelGate("model-a");
    loaded(gate, { models: { currentModelId: "model-a" } });
    gate.assertActive();
    gate.observe("inbound", { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "config_option_update", configOptions: config("model-b") } } });
    expect(() => gate.assertActive()).toThrow(/received model-b/);
    gate.connect();
    gate.assertActive();
  });

  it("ignores failed requests and unrelated replies", () => {
    const gate = createAcpxEffectiveModelGate("model-a");
    loaded(gate, { configOptions: config("model-a") });
    gate.observe("outbound", { jsonrpc: "2.0", id: 2, method: "session/set_config_option", params: { sessionId: "s", configId: "model", value: "model-b" } });
    gate.observe("inbound", { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "rejected" } });
    gate.observe("inbound", { jsonrpc: "2.0", id: 99, result: { configOptions: config("model-z") } });
    gate.assertActive();
  });
});
