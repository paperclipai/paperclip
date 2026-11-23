import { describe, expect, it, vi } from "vitest";

const status = vi.hoisted(() => ({ released: false }));
// Simulate the qualification flip: the same build with Antigravity's
// `qualificationStatus` removed from its declaration.
vi.mock("./qualified-profiles.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./qualified-profiles.js")>();
  const profile = (agent: string) => {
    const value = actual.QUALIFIED_ACPX_PROFILES[agent as keyof typeof actual.QUALIFIED_ACPX_PROFILES];
    if (agent !== "antigravity" || !status.released) return value;
    const { qualificationStatus: _pending, ...released } = value;
    return released;
  };
  const QUALIFIED_ACPX_PROFILES = Object.fromEntries(Object.keys(actual.QUALIFIED_ACPX_PROFILES).map(agent => [agent, undefined]));
  for (const agent of Object.keys(QUALIFIED_ACPX_PROFILES)) Object.defineProperty(QUALIFIED_ACPX_PROFILES, agent, { get: () => profile(agent), enumerable: true });
  return {
    ...actual, QUALIFIED_ACPX_PROFILES,
    assertAcpxProfileReleased: (agent: string) => {
      if ((profile(agent) as { qualificationStatus?: string }).qualificationStatus === "pending") {
        throw Object.assign(new Error(`ACPX ${agent} qualification is pending; this build cannot launch the provider.`), { code: "ACPX_PROFILE_QUALIFICATION_PENDING" });
      }
    },
    resolveQualifiedAcpxProfile: (agent: string, model: string) => ({ ...structuredClone(profile(agent)), qualificationModel: model, reportedModelId: model }),
  };
});

const { parseAcpxCandidateAdmission, bindAcpxCandidateAdmission, assertAcpxExecutionAdmission } = await import("./candidate-admission.js");
const { QUALIFIED_ACPX_PROFILES, resolveQualifiedAcpxProfile } = await import("./qualified-profiles.js");
const { ANTIGRAVITY_DISTRIBUTION_PINS } = await import("./generated-profiles.js");

const now = 1_800_000_000_000;
const model = "gemini-3.8-flash-low";
const expected = { companyId: "company-antigravity", agent: "antigravity", model };
const candidate = () => ({
  schema: "paperclip.acpx-candidate-admission.v1" as const, ...expected, agent: "antigravity" as const,
  profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest,
  nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256}`,
  platform: "darwin" as const, architecture: "arm64" as const, expiresAt: now + 60_000,
});

describe("Antigravity candidate admission across the qualification flip", () => {
  it("binds operator candidate authority only while the profile is pending", () => {
    status.released = false;
    expect(QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus).toBe("pending");
    expect(parseAcpxCandidateAdmission(candidate(), expected, now)).toEqual(candidate());
    expect(() => assertAcpxExecutionAdmission(resolveQualifiedAcpxProfile("antigravity", model))).toThrow("qualification is pending");
  });

  it("rejects every candidate grant once the declaration is released, and launches without one", () => {
    status.released = true;
    try {
      expect(QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus).toBeUndefined();
      expect(() => parseAcpxCandidateAdmission(candidate(), expected, now)).toThrow(expect.objectContaining({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" }));
      expect(() => bindAcpxCandidateAdmission(candidate(), { runId: "run-1", normalizedSessionId: "session-1" })).toThrow(expect.objectContaining({ code: "ACPX_CANDIDATE_ADMISSION_INVALID" }));
      const profile = resolveQualifiedAcpxProfile("antigravity", model);
      expect(() => assertAcpxExecutionAdmission(profile)).not.toThrow();
      // A saved or injected startup grant cannot ride along a released launch.
      expect(() => assertAcpxExecutionAdmission(profile, { ...candidate(), runId: "run-1", normalizedSessionId: "session-1" })).toThrow();
    } finally { status.released = false; }
  });
});
