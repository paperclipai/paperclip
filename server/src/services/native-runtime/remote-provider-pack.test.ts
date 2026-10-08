import { describe, expect, it, vi } from "vitest";
import { prepareVerifiedRemoteProviderPack, shouldUseBundledAcpxImageAssets } from "./remote-provider-pack.js";

describe("remote provider pack reuse", () => {
  it("keeps a verified staged pack without consulting the image or uploading again", async () => {
    const usePreinstalled = vi.fn();
    const stageAndVerify = vi.fn();
    expect(await prepareVerifiedRemoteProviderPack({
      verifyStaged: async () => {}, usePreinstalled, stageAndVerify,
    })).toBe("staged");
    expect(usePreinstalled).not.toHaveBeenCalled();
    expect(stageAndVerify).not.toHaveBeenCalled();
  });

  it.each(["missing pack", "manifest mismatch", "artifact hash mismatch"])(
    "replaces a %s with a verified image pack",
    async (reason) => {
      const stageAndVerify = vi.fn();
      expect(await prepareVerifiedRemoteProviderPack({
        verifyStaged: async () => { throw new Error(reason); },
        usePreinstalled: async () => true,
        stageAndVerify,
      })).toBe("preinstalled");
      expect(stageAndVerify).not.toHaveBeenCalled();
    },
  );

  it("uploads when neither existing pack is valid and fails closed if upload verification fails", async () => {
    const stageAndVerify = vi.fn().mockRejectedValue(new Error("artifact hash mismatch"));
    const input = {
      verifyStaged: async () => { throw new Error("stale staged pack"); },
      usePreinstalled: async () => false,
      stageAndVerify,
    };
    await expect(prepareVerifiedRemoteProviderPack(input)).rejects.toThrow("artifact hash mismatch");
    stageAndVerify.mockResolvedValue(undefined);
    await expect(prepareVerifiedRemoteProviderPack(input)).resolves.toBe("uploaded");
  });
});


describe("ordinary ACPX image artifacts", () => {
  const provider = (agent: string) => ({ kind: "acpx", agent, model: "selected-model" } as Parameters<typeof shouldUseBundledAcpxImageAssets>[0]["provider"]);
  it.each(["cursor", "copilot"])("selects bundled artifacts for remote %s without an operator override", agent => {
    expect(shouldUseBundledAcpxImageAssets({ requiresRemoteProviderPack: true, configuredProviderPackRoot: null, provider: provider(agent) })).toBe(true);
    expect(shouldUseBundledAcpxImageAssets({ requiresRemoteProviderPack: false, configuredProviderPackRoot: null, provider: provider(agent) })).toBe(false);
    expect(shouldUseBundledAcpxImageAssets({ requiresRemoteProviderPack: true, configuredProviderPackRoot: "/explicit/pack", provider: provider(agent) })).toBe(false);
  });
  it.each(["pi", "claude", "codex", "grok"])("does not change the artifact authority for %s", agent => {
    expect(shouldUseBundledAcpxImageAssets({ requiresRemoteProviderPack: true, configuredProviderPackRoot: null, provider: provider(agent) })).toBe(false);
  });
  it("does not admit a non-ACPX provider through bundled image selection", () => {
    expect(shouldUseBundledAcpxImageAssets({ requiresRemoteProviderPack: true, configuredProviderPackRoot: null, provider: { kind: "codex", model: null } })).toBe(false);
  });
});
