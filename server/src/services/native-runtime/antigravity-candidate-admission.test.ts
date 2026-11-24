import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { QUALIFIED_ACPX_PROFILES } from "../../vendor/paperclip-runner/index.js";
import { ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, ANTIGRAVITY_REMOTE_TARGET, antigravityRemoteCandidateAdmitted, resolveAntigravityCandidateAdmission } from "./acpx-qualification.js";
import { resolvePaperclipRunnerNativeProviderInput, resolvePaperclipRunnerProviderProfile } from "./provider-profile.js";
import { resolveNativeRuntimeMode } from "./runtime-mode.js";

const companyId = "candidate-company";
const model = "gemini-3.8-flash-low";
const config = { provider: "acpx", acpxAgent: "antigravity", model };
const distributions = JSON.parse(readFileSync(new URL("../../../../packages/paperclip-runner/antigravity-distributions.json", import.meta.url), "utf8"));
const verifiedTargets = Object.keys(distributions.platforms).filter(target => distributions.platforms[target].provisioning === "verified-closure");
const hostTarget = `${process.platform}-${process.arch}`;
const localHost = verifiedTargets.includes(hostTarget);
const targetAdmission = (target: string) => {
  const [platform, architecture] = target.split("-");
  return { schema: "paperclip.acpx-candidate-admission.v1", companyId,
    agent: "antigravity", model, profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest,
    nativeClosureDigest: `sha256:${distributions.platforms[target].closureSha256}`,
    platform, architecture, expiresAt: Date.now() + 60_000 };
};
const admission = () => targetAdmission(localHost ? hostTarget : "darwin-arm64");

describe("Antigravity operator candidate admission", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps saved configuration and runtime environment from authorizing a candidate", () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, undefined);
    const injected = { ...config, candidateAdmission: admission(),
      env: { [ANTIGRAVITY_CANDIDATE_ADMISSION_ENV]: JSON.stringify(admission()) } };
    expect(() => resolvePaperclipRunnerProviderProfile(injected, { companyId }))
      .toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_agent_unavailable" }));
  });

  it("requires explicit company authority and never projects it to another company", () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, JSON.stringify(admission()));
    expect(resolveAntigravityCandidateAdmission({})).toBeUndefined();
    expect(resolveAntigravityCandidateAdmission({ companyId: "another-company", model })).toBeUndefined();
    expect(() => resolvePaperclipRunnerProviderProfile(config)).toThrow(/awaiting native Runner acceptance/);
    expect(() => resolvePaperclipRunnerProviderProfile(config, { companyId: "another-company" }))
      .toThrow(/awaiting native Runner acceptance/);
  });

  it("admits only the exact configured local candidate while leaving global release pending", () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, JSON.stringify(admission()));
    expect(QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus).toBe("pending");
    if (!localHost) {
      expect(resolveAntigravityCandidateAdmission({ companyId, model })).toBeUndefined();
      return;
    }
    expect(resolveAntigravityCandidateAdmission({ companyId })).toMatchObject({ companyId, model, agent: "antigravity" });
    expect(resolvePaperclipRunnerProviderProfile(config, { companyId })).toMatchObject(config);
    expect(resolvePaperclipRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: config, companyId }))
      .toMatchObject({ ...config, acpxPermissionMode: "approve-all" });
    expect(() => resolvePaperclipRunnerProviderProfile({ ...config, model: "different-model" }, { companyId }))
      .toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_qualification_invalid" }));
    expect(resolveNativeRuntimeMode({ enabled: false, runtimeConfig: {}, adapterConfig: config,
      agent: { id: "candidate-agent", companyId, adapterType: "paperclip_runner", status: "active" },
      issue: { id: "candidate-task", workMode: "standard" }, target: { kind: "local" }, workspaceId: null }))
      .toMatchObject({ kind: "native", profile: { backend: "acpx_runtime" } });
  });

  it("binds a cloud grant to linux-x64 and the patched closure, for its company and model only", () => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, JSON.stringify(targetAdmission("linux-x64")));
    expect(resolveAntigravityCandidateAdmission({ companyId, model, target: ANTIGRAVITY_REMOTE_TARGET }))
      .toMatchObject({ companyId, model, platform: "linux", architecture: "x64" });
    expect(antigravityRemoteCandidateAdmitted({ companyId, model })).toBe(true);
    expect(antigravityRemoteCandidateAdmitted({ companyId: "another-company", model })).toBe(false);
    expect(antigravityRemoteCandidateAdmitted({ companyId, model: "gemini-3.8-flash-high" })).toBe(false);
    if (hostTarget !== "linux-x64") {
      expect(() => resolveAntigravityCandidateAdmission({ companyId, model, target: { platform: process.platform, architecture: process.arch } }))
        .toThrow(/does not match the execution target/);
    }
    for (const grant of [targetAdmission("linux-arm64"), targetAdmission("darwin-arm64"),
      { ...targetAdmission("linux-x64"), nativeClosureDigest: `sha256:${distributions.platforms["linux-x64"].vendorClosureSha256}` }]) {
      vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, JSON.stringify(grant));
      expect(antigravityRemoteCandidateAdmitted({ companyId, model })).toBe(false);
    }
  });

  it("declares verified closures for macOS ARM and both Linux architectures", () => {
    expect(verifiedTargets.sort()).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"]);
  });

  it.runIf(localHost)("rejects another verified platform's exact record on this host", () => {
    // linux-x64 is also the cloud target, so a grant for it is a valid surface grant on any host.
    for (const target of verifiedTargets.filter(target => target !== hostTarget && target !== "linux-x64")) {
      vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, JSON.stringify(targetAdmission(target)));
      expect(() => resolveAntigravityCandidateAdmission({ companyId, model })).toThrow(/does not match this host/);
    }
  });

  it.runIf(localHost).each([
    { expiresAt: 0 }, { profileDigest: `sha256:${"0".repeat(64)}` },
    { nativeClosureDigest: `sha256:${"0".repeat(64)}` }, { platform: process.platform === "linux" ? "darwin" : "linux" },
    { architecture: process.arch === "x64" ? "arm64" : "x64" }, { allowAll: true },
  ])("rejects expired, changed or broad operator authorization %j", changes => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, JSON.stringify({ ...admission(), ...changes }));
    expect(() => resolveAntigravityCandidateAdmission({ companyId, model })).toThrow();
    expect(() => resolvePaperclipRunnerProviderProfile(config, { companyId }))
      .toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_qualification_invalid" }));
  });
});
