import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindAcpxCandidateAdmission, type AcpxCandidateAdmission } from "../drivers/acpx/candidate-admission.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "../drivers/acpx/generated-profiles.js";
import { QUALIFIED_ACPX_PROFILES, resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { createRunnerdCodexTransport, runnerdLaunchProfileInternals } from "./runnerd-codex-transport.js";

const identity = { runnerInstanceId: "runner-candidate", environmentLeaseId: "lease-candidate", runId: "run-candidate", normalizedSessionId: "session-candidate", turnId: "turn-candidate", itemId: "item-candidate" };
const candidate = (): AcpxCandidateAdmission => ({ schema: "paperclip.acpx-candidate-admission.v1", companyId: "company-candidate", agent: "antigravity", model: "gemini-3.8-flash-low",
  profileDigest: resolveQualifiedAcpxProfile("antigravity", "gemini-3.8-flash-low").commandDigest,
  nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256}`,
  platform: "darwin", architecture: "arm64", expiresAt: Date.now() + 60_000 });
const linuxCandidate = (): AcpxCandidateAdmission => ({ ...candidate(), platform: "linux", architecture: "x64",
  nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["linux-x64"].closureSha256}` });

describe("Antigravity qualified startup", () => {
  it("rejects stale candidate grants once Antigravity is qualified", () => {
    expect(QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus).toBeUndefined();
    expect(() => bindAcpxCandidateAdmission(candidate(), identity)).toThrow("ACPX candidate admission is missing, expired, or does not match");
    expect(() => bindAcpxCandidateAdmission(linuxCandidate(), identity)).toThrow("ACPX candidate admission is missing, expired, or does not match");
    expect(runnerdLaunchProfileInternals.openedThreadModelProvider("acpx", "antigravity", "gemini-3.8-flash-low")).toBe("google");
  });

  it("opens ordinary local and remote Antigravity transports without a candidate grant while refusing stale grants", async () => {
    const root = await mkdtemp(join(tmpdir(), "antigravity-qualified-startup-"));
    try {
      const localOptions = { provider: "acpx" as const, acpxAgent: "antigravity" as const, stateDirectory: root };
      const localOwner = createRunnerdCodexTransport(localOptions);
      expect(localOwner.transport.prepareConversationResume).toBeUndefined();
      await localOwner.transport.close();

      expect(() => createRunnerdCodexTransport({ ...localOptions, acpxCandidateAdmission: candidate() })).toThrow();
      expect(() => createRunnerdCodexTransport({ ...localOptions, homeMode: "preconfigured" as const })).toThrow("preconfigured_home_unsupported_provider");

      const remoteOptions = { ...localOptions, runnerFilesystemRoot: "/owned-runner" };
      const remoteOwner = createRunnerdCodexTransport(remoteOptions);
      await remoteOwner.transport.close();
      expect(() => createRunnerdCodexTransport({ ...remoteOptions, acpxCandidateAdmission: linuxCandidate() })).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
