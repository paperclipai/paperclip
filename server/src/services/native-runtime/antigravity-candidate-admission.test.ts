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

describe("released Antigravity admission ignores candidate grants", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("admits released Antigravity without candidate authority and ignores candidate env values", () => {
    for (const value of [undefined, "malformed", JSON.stringify(admission()), JSON.stringify(targetAdmission("linux-x64"))]) {
      vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, value);
      expect(QUALIFIED_ACPX_PROFILES.antigravity.agentProfileVersion).toBe(2);
      expect(QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus).toBeUndefined();
      expect(resolveAntigravityCandidateAdmission({ companyId, model })).toBeUndefined();
      expect(resolveAntigravityCandidateAdmission({ companyId, model, target: ANTIGRAVITY_REMOTE_TARGET })).toBeUndefined();
      expect(antigravityRemoteCandidateAdmitted({ companyId, model })).toBe(false);
      expect(resolvePaperclipRunnerProviderProfile(config, { companyId })).toMatchObject(config);
      expect(resolvePaperclipRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: config, companyId }))
        .toMatchObject({ ...config, acpxPermissionMode: "approve-all" });
      expect(resolveNativeRuntimeMode({ enabled: false, runtimeConfig: {}, adapterConfig: config,
        agent: { id: "candidate-agent", companyId, adapterType: "paperclip_runner", status: "active" },
        issue: { id: "candidate-task", workMode: "standard" }, target: { kind: "local" }, workspaceId: null }))
        .toMatchObject({ kind: "native", profile: { backend: "acpx_runtime" } });
    }
  });

  it("requires an explicit Antigravity model ID", () => {
    for (const emptyModel of [undefined, "", "   "]) {
      expect(() => resolvePaperclipRunnerProviderProfile({ ...config, model: emptyModel }, { companyId }))
        .toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_model_required" }));
    }
  });

  it("declares verified closures for macOS ARM and both Linux architectures", () => {
    expect(verifiedTargets.sort()).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"]);
  });
});
