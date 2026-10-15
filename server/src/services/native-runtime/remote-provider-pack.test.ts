import { describe, expect, it, vi } from "vitest";
import { prepareVerifiedRemoteProviderPack, useVerifiedPreinstalledRemoteProviderPack } from "./remote-provider-pack.js";

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


describe("standard remote provider pack discovery", () => {
  const roots = ["/opt/paperclip-runner/provider-pack", "/home/operator/.local/share/paperclip-runner/provider-pack"];
  it.each(["old manifest", "modified artifact", "failed link"])("tries the matching home pack after %s rejects /opt", async reason => {
    const verifyAndLink = vi.fn(async (root: string) => {
      if (root === roots[0]) throw new Error(reason);
    });
    await expect(useVerifiedPreinstalledRemoteProviderPack({ candidates: roots, verifyAndLink })).resolves.toBe(true);
    expect(verifyAndLink.mock.calls.map(([root]) => root)).toEqual(roots);
  });
  it("keeps the first matching pack without consulting another installation", async () => {
    const verifyAndLink = vi.fn(async () => {});
    await expect(useVerifiedPreinstalledRemoteProviderPack({ candidates: roots, verifyAndLink })).resolves.toBe(true);
    expect(verifyAndLink).toHaveBeenCalledExactlyOnceWith(roots[0]);
  });
  it("fails closed when every standard installation is incompatible", async () => {
    const verifyAndLink = vi.fn().mockRejectedValue(new Error("manifest mismatch"));
    await expect(useVerifiedPreinstalledRemoteProviderPack({ candidates: roots, verifyAndLink })).resolves.toBe(false);
    expect(verifyAndLink).toHaveBeenCalledTimes(2);
  });
});
