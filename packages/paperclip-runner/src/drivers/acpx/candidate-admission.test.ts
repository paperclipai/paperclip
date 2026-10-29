import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "./generated-profiles.js";
import { assertAcpxProfileReleased, resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { assertAcpxExecutionAdmission, bindAcpxCandidateAdmission, parseAcpxCandidateAdmission, parseAcpxCandidateStartupAdmission, type AcpxCandidateAdmission } from "./candidate-admission.js";
import { verifyAcpxProfileInstallation } from "./profile-installation.js";
import { AcpxRuntimeHost } from "./runtime-host.js";
import * as integrity from "./installation-integrity.js";

vi.mock("./installation-integrity.js", async importOriginal => ({
  ...await importOriginal<typeof import("./installation-integrity.js")>(),
  verifyNativeAcpxInstallation: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

const now = 1_800_000_000_000;
const expected = { companyId: "company-candidate", agent: "antigravity", model: "gemini-3.8-flash-low" };
const candidate = (): AcpxCandidateAdmission => ({ schema: "paperclip.acpx-candidate-admission.v1", ...expected, agent: "antigravity",
  profileDigest: resolveQualifiedAcpxProfile("antigravity", expected.model).commandDigest,
  nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256}`,
  platform: "darwin", architecture: "arm64", expiresAt: now + 60_000 });

describe("operator candidate execution admission", () => {
  it("binds an exact company/model/profile/native closure without changing release admission", () => {
    const source = candidate();
    const value = parseAcpxCandidateAdmission(source, expected, now);
    expect(value).toEqual(source);
    expect(value).not.toBe(source);
    expect(() => assertAcpxProfileReleased("antigravity")).toThrow("qualification is pending");
    expect(() => assertAcpxExecutionAdmission(resolveQualifiedAcpxProfile("antigravity", expected.model))).toThrow("qualification is pending");
  });

  it.each([
    { companyId: "another-company" }, { agent: "codex" }, { model: "gemini-3.8-flash-high" },
    { profileDigest: `sha256:${"a".repeat(64)}` }, { nativeClosureDigest: `sha256:${"b".repeat(64)}` },
    { platform: "linux" }, { architecture: "x64" }, { expiresAt: now }, { expiresAt: now + 86_400_001 },
    { expiresAt: "1800000060000" }, { unknown: true }, { runId: "injected-run" }, { model: "auto" },
  ])("rejects mismatched or broadened authority %j", change => {
    expect(() => parseAcpxCandidateAdmission({ ...candidate(), ...change }, expected, now)).toThrow(expect.objectContaining({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" }));
  });

  it("binds actual startup run/session and refuses replay against another identity", () => {
    const current = { ...candidate(), expiresAt: Date.now() + 60_000 };
    const startup = bindAcpxCandidateAdmission(current, { runId: "actual-run", normalizedSessionId: "actual-session" });
    expect(parseAcpxCandidateStartupAdmission(startup, { ...expected, runId: "actual-run", normalizedSessionId: "actual-session" })).toEqual(startup);
    for (const identity of [{ runId: "other-run" }, { normalizedSessionId: "other-session" }, { model: "other-model" }]) {
      expect(() => parseAcpxCandidateStartupAdmission(startup, { ...expected, ...identity })).toThrow();
    }
    expect(() => parseAcpxCandidateStartupAdmission({ ...startup, trusted: true }, expected)).toThrow();
    expect(() => parseAcpxCandidateStartupAdmission(startup, expected, startup.expiresAt)).toThrow();
  });

  it("permits only the pinned native candidate at the execution exception", () => {
    const startup = bindAcpxCandidateAdmission({ ...candidate(), expiresAt: Date.now() + 60_000 }, { runId: "actual-run", normalizedSessionId: "actual-session" });
    const profile = resolveQualifiedAcpxProfile("antigravity", expected.model);
    if (process.platform === "darwin" && process.arch === "arm64") expect(() => assertAcpxExecutionAdmission(profile, startup)).not.toThrow();
    else expect(() => assertAcpxExecutionAdmission(profile, startup)).toThrow();
    expect(() => assertAcpxExecutionAdmission(resolveQualifiedAcpxProfile("codex", expected.model), startup)).toThrow();
    expect(() => assertAcpxExecutionAdmission({ ...profile, commandDigest: `sha256:${"c".repeat(64)}` }, startup)).toThrow();
    for (const agent of ["codex", "claude", "grok", "cursor", "pi", "copilot"] as const) {
      expect(() => assertAcpxExecutionAdmission(resolveQualifiedAcpxProfile(agent, "caller-selected-model"))).not.toThrow();
    }
  });
});

describe("candidate installation remains cryptographically verified", () => {
  const profile = resolveQualifiedAcpxProfile("antigravity", "gemini-3.8-flash-low");
  const admission = () => bindAcpxCandidateAdmission({ schema: "paperclip.acpx-candidate-admission.v1", companyId: "company-candidate", agent: "antigravity", model: profile.qualificationModel,
    profileDigest: profile.commandDigest, nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256}`,
    platform: "darwin", architecture: "arm64", expiresAt: Date.now() + 60_000 }, { runId: "run-candidate", normalizedSessionId: "session-candidate" });

  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("delegates the admitted exception to the exact complete native closure verifier", async () => {
    const native = { commandDigest: "native-closure-verifier-result" } as integrity.VerifiedAcpxInstallation;
    vi.mocked(integrity.verifyNativeAcpxInstallation).mockResolvedValue(native);
    const result = await verifyAcpxProfileInstallation(profile, admission());
    expect(result.commandDigest).toBe(profile.commandDigest);
    expect(integrity.verifyNativeAcpxInstallation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      expectedClosureSha256: ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256,
      executable: "agy_acp_server.par", fixedArguments: [],
    }));
  });

  it("denies absent, altered, or other-provider authority before any native files are opened", async () => {
    vi.mocked(integrity.verifyNativeAcpxInstallation).mockClear();
    await expect(verifyAcpxProfileInstallation(profile)).rejects.toMatchObject({ code: "ACPX_PROFILE_QUALIFICATION_PENDING" });
    await expect(verifyAcpxProfileInstallation(profile, { ...admission(), model: "gemini-3.8-flash-high" })).rejects.toMatchObject({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" });
    await expect(verifyAcpxProfileInstallation(resolveQualifiedAcpxProfile("codex", profile.qualificationModel), admission())).rejects.toMatchObject({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" });
    expect(integrity.verifyNativeAcpxInstallation).not.toHaveBeenCalled();
  });

  it("rejects a candidate session mismatch before installation, credentials, or runtime acquisition", async () => {
    const verifyInstallation = vi.fn(), openRuntime = vi.fn();
    await expect(AcpxRuntimeHost.open({ candidateAdmission: admission(), runtimeDirectory: "/unused", normalizedSessionId: "another-session", workingDirectory: "/unused", agent: "antigravity", model: profile.qualificationModel,
      permissionMode: "deny-all", providerPolicy: { readOnly: true } }, { verifyInstallation, openRuntime, retainAdmissionCleanup: () => {}, reportRetainedCleanupFailure: () => {} })).rejects.toMatchObject({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" });
    expect(verifyInstallation).not.toHaveBeenCalled();
    expect(openRuntime).not.toHaveBeenCalled();
  });
});
