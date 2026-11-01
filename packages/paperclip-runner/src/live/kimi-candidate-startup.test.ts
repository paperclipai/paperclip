import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AcpxCandidateAdmission } from "../drivers/acpx/candidate-admission.js";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256 } from "../drivers/acpx/kimi-closure-pins.js";
import { QUALIFIED_ACPX_PROFILES, resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { createRunnerdCodexTransport } from "./runnerd-codex-transport.js";

const candidate = (remote = false): AcpxCandidateAdmission => ({ schema: "paperclip.acpx-candidate-admission.v1", companyId: "company-kimi", agent: "kimi", model: "kimi-for-coding",
  profileDigest: resolveQualifiedAcpxProfile("kimi", "kimi-for-coding").commandDigest,
  nativeClosureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[remote ? "linux-x64" : "darwin-arm64"]}`,
  platform: remote ? "linux" : "darwin", architecture: remote ? "x64" : "arm64", expiresAt: Date.now() + 60_000 });

describe("Kimi trusted qualification startup", () => {
  it("retains exact provider and isolated home authority for a valid Kimi grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-candidate-startup-"));
    try {
      const options = { provider: "acpx" as const, acpxAgent: "kimi" as const, stateDirectory: root, acpxCandidateAdmission: candidate() };
      for (const changes of [{ provider: "codex" as const }, { provider: "opencode" as const }, { homeMode: "preconfigured" as const },
        { acpxAgent: "copilot" as const }, { acpxCandidateAdmission: { ...candidate(), profileDigest: `sha256:${"f".repeat(64)}` } }]) {
        expect(() => createRunnerdCodexTransport({ ...options, ...changes })).toThrow();
      }
      if (QUALIFIED_ACPX_PROFILES.kimi.qualificationStatus === "pending") {
        expect(() => createRunnerdCodexTransport({ ...options, acpxCandidateAdmission: undefined })).toThrow("evaluation opt-in");
      } else {
        expect(() => createRunnerdCodexTransport(options)).toThrow();
        const ordinary = createRunnerdCodexTransport({ ...options, acpxCandidateAdmission: undefined });
        await ordinary.transport.close();
        expect(() => createRunnerdCodexTransport({ ...options, acpxCandidateAdmission: undefined, homeMode: "preconfigured" })).toThrow();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("keeps ordinary Kimi warm transport capability under target-bound authority: remote=%s", async remote => {
    const root = await mkdtemp(join(tmpdir(), "kimi-candidate-warm-"));
    try {
      const owner = createRunnerdCodexTransport({ provider: "acpx", acpxAgent: "kimi", stateDirectory: root,
        ...(QUALIFIED_ACPX_PROFILES.kimi.qualificationStatus === "pending" ? { acpxCandidateAdmission: candidate(remote) } : {}), lifecyclePolicy: { mode: "warm", idleTimeoutMs: 1000 },
        ...(remote ? { runnerFilesystemRoot: "/owned-runner" } : {}) });
      await owner.transport.close();
      if (QUALIFIED_ACPX_PROFILES.kimi.qualificationStatus !== "pending") {
        expect(() => createRunnerdCodexTransport({ provider: "acpx", acpxAgent: "kimi", stateDirectory: root,
          acpxCandidateAdmission: candidate(remote), lifecyclePolicy: { mode: "warm", idleTimeoutMs: 1000 },
          ...(remote ? { runnerFilesystemRoot: "/owned-runner" } : {}) })).toThrow();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
