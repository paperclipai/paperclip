import { describe, expect, it, vi } from "vitest";

import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { requireVerifiedAcpxModel } from "./model-verification.js";

describe("ACPX qualified model verification", () => {
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

  it("selects Claude's canonical model and normalizes its ACP selector", async () => {
    const setModel = vi.fn(async () => undefined);
    const getStatus = vi.fn(async () => ({
      models: {
        currentModelId: "sonnet",
        availableModelIds: ["default", "sonnet", "opus"],
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

  it("rejects a provider that ignores the qualified model selection", async () => {
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
