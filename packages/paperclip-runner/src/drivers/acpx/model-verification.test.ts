import { describe, expect, it, vi } from "vitest";

import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { requireVerifiedAcpxModel } from "./model-verification.js";

describe("ACPX requested model verification", () => {
  const cursorSelector = "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]";

  it("selects Cursor's unique advertised full selector and normalizes the verified model", async () => {
    let currentModelId = "default";
    const getStatus = vi.fn(async () => ({ models: {
      currentModelId, availableModelIds: [cursorSelector, cursorSelector, "gpt-5.6-sol-mini[context=272k]"],
    } }));
    const setModel = vi.fn(async (model: string) => { currentModelId = model; });
    await expect(requireVerifiedAcpxModel({ getStatus, setModel }, resolveQualifiedAcpxProfile("cursor", "gpt-5.6-sol")))
      .resolves.toMatchObject({ models: { currentModelId: "gpt-5.6-sol", availableModelIds: ["gpt-5.6-sol", "gpt-5.6-sol-mini[context=272k]"] } });
    expect(setModel).toHaveBeenCalledExactlyOnceWith(cursorSelector);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("accepts Cursor's already reported full selector without changing it", async () => {
    const setModel = vi.fn();
    await expect(requireVerifiedAcpxModel({ getStatus: async () => ({ models: { currentModelId: cursorSelector } }), setModel }, resolveQualifiedAcpxProfile("cursor", "gpt-5.6-sol")))
      .resolves.toMatchObject({ models: { currentModelId: "gpt-5.6-sol" } });
    expect(setModel).not.toHaveBeenCalled();
  });

  it.each([
    [[], "ACPX_MODEL_SELECTION_UNAVAILABLE"],
    [["gpt-5.6-sol-mini[context=272k]"], "ACPX_MODEL_SELECTION_UNAVAILABLE"],
    [[cursorSelector, "gpt-5.6-sol[context=272k,reasoning=high,fast=false]"], "ACPX_MODEL_SELECTION_AMBIGUOUS"],
  ] as const)("rejects unavailable or ambiguous Cursor base names before selecting another model", async (availableModelIds, code) => {
    const setModel = vi.fn();
    await expect(requireVerifiedAcpxModel({ getStatus: async () => ({ models: { currentModelId: "default", availableModelIds } }), setModel }, resolveQualifiedAcpxProfile("cursor", "gpt-5.6-sol")))
      .rejects.toMatchObject({ code });
    expect(setModel).not.toHaveBeenCalled();
  });

  it("does not accept a Cursor provider that ignores the resolved selector", async () => {
    const setModel = vi.fn(async () => undefined);
    await expect(requireVerifiedAcpxModel({ getStatus: async () => ({ models: { currentModelId: "default", availableModelIds: [cursorSelector] } }), setModel }, resolveQualifiedAcpxProfile("cursor", "gpt-5.6-sol")))
      .rejects.toMatchObject({ code: "ACPX_EFFECTIVE_MODEL_MISMATCH" });
    expect(setModel).toHaveBeenCalledExactlyOnceWith(cursorSelector);
  });

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
