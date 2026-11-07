import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareVerifiedRemoteProviderPack, useVerifiedPreinstalledRemoteProviderPack, runRemoteProviderVerification, shouldUseBundledAcpxImageAssets } from "./remote-provider-pack.js";

describe("remote provider verification", () => {
  const ok = { exitCode: 0, timedOut: false, stdout: "verified", stderr: "", signal: null };
  it.each([
    { ...ok, exitCode: null, timedOut: true },
    { ...ok, exitCode: null },
    { ...ok, exitCode: 137, signal: "SIGKILL" },
  ])("retries an interrupted read without calling it incompatible: %j", async result => {
    const execute = vi.fn().mockResolvedValueOnce(result).mockResolvedValueOnce(ok);
    await expect(runRemoteProviderVerification(execute, "pack")).resolves.toEqual(ok);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("exhausts its own read budget after two inconclusive reads, including empty stderr", async () => {
    const execute = vi.fn().mockResolvedValue({ ...ok, exitCode: null, timedOut: true });
    await expect(runRemoteProviderVerification(execute, "pack"))
      .rejects.toThrow("runner_remote_provider_verification_unavailable: pack unavailable after 2 verification attempts (exitCode=null; timedOut=true");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each(["", "manifest mismatch", "dist tree digest mismatch"])("fails closed without retrying a completed rejection: %s", async stderr => {
    const execute = vi.fn().mockResolvedValue({ ...ok, exitCode: 1, stderr });
    await expect(runRemoteProviderVerification(execute, "pack")).rejects.toThrow("runner_remote_provider_artifact_incompatible: pack failed (exitCode=1");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("retains a bounded redacted rejection from a combined-output transport", async () => {
    const execute = vi.fn().mockResolvedValue({ ...ok, exitCode: 1,
      stdout: "Error: manifest mismatch\nANTHROPIC_API_KEY=secret-fixture-value", stderr: "" });
    const failure = await runRemoteProviderVerification(execute, "pack").catch(error => error);
    expect(failure.message).toContain("manifest mismatch");
    expect(failure.message).not.toContain("secret-fixture-value");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("recovers a transport exception and propagates cancellation", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("connection unavailable")).mockResolvedValueOnce(ok);
    await expect(runRemoteProviderVerification(execute, "pack")).resolves.toEqual(ok);
    const abort = new DOMException("cancelled", "AbortError");
    execute.mockReset().mockRejectedValue(abort);
    await expect(runRemoteProviderVerification(execute, "pack")).rejects.toBe(abort);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("retries after a real timed-out subprocess exits while unrelated work remains responsive", async () => {
    let attempts = 0;
    let responsive = false;
    const unrelated = new Promise<void>(resolve => setTimeout(() => { responsive = true; resolve(); }, 5));
    const result = await runRemoteProviderVerification(async () => {
      attempts += 1;
      try {
        const result = await promisify(execFile)(process.execPath, ["-e", attempts === 1 ? "setInterval(()=>{},1000)" : "process.stdout.write('verified')"], { timeout: attempts === 1 ? 100 : 2_000 });
        return { ...ok, ...result };
      } catch (error) {
        const failure = error as Error & { killed: boolean; signal: string; stdout: string; stderr: string };
        if (!failure.killed) throw error;
        return { ...ok, exitCode: null, timedOut: true, signal: failure.signal, stderr: failure.stderr };
      }
    }, "pack");
    await unrelated;
    expect({ attempts, responsive, stdout: result.stdout }).toEqual({ attempts: 2, responsive: true, stdout: "verified" });
  });
});

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
