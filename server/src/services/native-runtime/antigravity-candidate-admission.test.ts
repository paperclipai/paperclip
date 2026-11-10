import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { QUALIFIED_ACPX_PROFILES } from "../../vendor/paperclip-runner/index.js";
import { ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, resolveAntigravityCandidateAdmission } from "./acpx-qualification.js";
import { resolvePaperclipRunnerNativeProviderInput, resolvePaperclipRunnerProviderProfile } from "./provider-profile.js";
import { resolveNativeRuntimeMode } from "./runtime-mode.js";

const companyId = "candidate-company";
const model = "gemini-3.8-flash-low";
const config = { provider: "acpx", acpxAgent: "antigravity", model };
const localHost = process.platform === "darwin" && process.arch === "arm64";
const distributions = JSON.parse(readFileSync(new URL("../../../../packages/paperclip-runner/antigravity-distributions.json", import.meta.url), "utf8"));
const admission = () => ({ schema: "paperclip.acpx-candidate-admission.v1", companyId,
  agent: "antigravity", model, profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest,
  nativeClosureDigest: `sha256:${distributions.platforms["darwin-arm64"].closureSha256}`,
  platform: "darwin", architecture: "arm64", expiresAt: Date.now() + 60_000 });

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

  it.runIf(localHost).each([
    { expiresAt: 0 }, { profileDigest: `sha256:${"0".repeat(64)}` },
    { nativeClosureDigest: `sha256:${"0".repeat(64)}` }, { platform: "linux" },
    { architecture: "x64" }, { allowAll: true },
  ])("rejects expired, changed or broad operator authorization %j", changes => {
    vi.stubEnv(ANTIGRAVITY_CANDIDATE_ADMISSION_ENV, JSON.stringify({ ...admission(), ...changes }));
    expect(() => resolveAntigravityCandidateAdmission({ companyId, model })).toThrow();
    expect(() => resolvePaperclipRunnerProviderProfile(config, { companyId }))
      .toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_qualification_invalid" }));
  });
});
