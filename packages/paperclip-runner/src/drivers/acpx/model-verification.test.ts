import { describe, expect, it, vi } from "vitest";

import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { requireVerifiedAcpxModel } from "./model-verification.js";
import { acpxSidecarErrorCode } from "../../cli/acpx-sidecar-input.js";

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

  it.each(["claude", "codex", "pi", "grok", "cursor", "copilot"] as const)("names an ACP rejection of an unadvertised model as an unsupported model with %s", async agent => {
    const model = "chaos-missing-model-abc12345";
    // claude-agent-acp 0.73.0 answers session/set_config_option for an unknown model with this
    // JSON-RPC error; ACPX wraps it as below (live probe, 2026-11-10).
    const acp = Object.assign(new Error("Internal error"), {
      code: -32603, data: { details: `Invalid value for config option model: ${model}` },
    });
    const wrapped = new Error(`Failed session/set_config_option for model "${model}": Invalid value for config option model: ${model} (ACP -32603, adapter reported "Internal error")`, { cause: acp });
    const getStatus = vi.fn(async () => ({ models: { currentModelId: "default", availableModelIds: ["default", "opus", "sonnet"] } }));
    const setModel = vi.fn(async () => { throw wrapped; });
    const failure = await requireVerifiedAcpxModel({ getStatus, setModel }, resolveQualifiedAcpxProfile(agent, model))
      .then(() => null, (error: unknown) => error as Error & { code?: unknown; retryable?: unknown });
    expect(failure).toMatchObject({ code: "ACP_MODEL_UNSUPPORTED", retryable: false });
    expect(failure?.cause).toBe(wrapped);
    expect(acpxSidecarErrorCode(failure!)).toBe("ACP_MODEL_UNSUPPORTED");
  });

  it("keeps a transport failure or an advertised model's rejection unchanged", async () => {
    const acp = Object.assign(new Error("Internal error"), { code: -32603, data: { details: "busy" } });
    for (const [rejected, available] of [[new Error("socket closed"), ["default"]], [acp, ["default", "listed-model"]]] as const) {
      const getStatus = vi.fn(async () => ({ models: { currentModelId: "default", availableModelIds: [...available] } }));
      const setModel = vi.fn(async () => { throw rejected; });
      await expect(requireVerifiedAcpxModel({ getStatus, setModel }, resolveQualifiedAcpxProfile("claude", "listed-model")))
        .rejects.toBe(rejected);
    }
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
