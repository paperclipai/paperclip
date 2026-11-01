import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { spawnRunner, type RunnerProcessLaunchSpec } from "../control-plane/durable-prp-control-plane.js";
import { bindAcpxCandidateAdmission, type AcpxCandidateAdmission } from "../drivers/acpx/candidate-admission.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "../drivers/acpx/generated-profiles.js";
import { resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { createRunnerdCodexTransport, runnerdLaunchProfileInternals } from "./runnerd-codex-transport.js";

const identity = { runnerInstanceId: "runner-candidate", environmentLeaseId: "lease-candidate", runId: "run-candidate", normalizedSessionId: "session-candidate", turnId: "turn-candidate", itemId: "item-candidate" };
const candidate = (): AcpxCandidateAdmission => ({ schema: "paperclip.acpx-candidate-admission.v1", companyId: "company-candidate", agent: "antigravity", model: "gemini-3.8-flash-low",
  profileDigest: resolveQualifiedAcpxProfile("antigravity", "gemini-3.8-flash-low").commandDigest,
  nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256}`,
  platform: "darwin", architecture: "arm64", expiresAt: Date.now() + 60_000 });
const supported = process.platform === "darwin" && process.arch === "arm64";

describe("Antigravity candidate trusted startup", () => {
  it("bounds argv and structured launches by the absolute candidate expiry across replacement", () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const admission = bindAcpxCandidateAdmission({ ...candidate(), expiresAt: now + 2_000 }, identity);
      const launches: RunnerProcessLaunchSpec[] = [];
      const handle = spawnRunner({ connectUrl: "ws://127.0.0.1:43127", stateDirectory: "/unused/candidate", identity,
        ticket: "inert-ticket", maxOutboxBytes: 262144, p0ReserveBytes: 65536, maxRuntimeMs: 0, maxLifetimeMs: 10_000,
        runnerVersion: "fixture", runnerDigest: `sha256:${"f".repeat(64)}`,
        acpxLaunchProfile: { candidateAdmission: admission, authorityDigest: `sha256:${"d".repeat(64)}`, command: "/owned/node", commandSha256: `sha256:${"b".repeat(64)}`,
          sidecarScript: "/owned/sidecar.cjs", sidecarScriptSha256: `sha256:${"c".repeat(64)}` },
        processLauncher: spec => { launches.push(spec); return { child: { pid: 42, exitCode: 0, signalCode: null, kill: () => true },
          completion: Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "" }) }; },
      });
      expect(launches[0]!.args).not.toContain("--max-lifetime-ms");
      expect(launches[0]!.args.slice(-2)).toEqual(["--max-runtime-ms", "2000"]);
      expect(launches[0]!.nativeRunner).toMatchObject({ maxRuntimeMs: 2000, maxLifetimeMs: 2000 });
      now += 1_500;
      handle.restart!("replacement-ticket");
      expect(launches[1]!.args.slice(-2)).toEqual(["--max-runtime-ms", "500"]);
      expect(launches[1]!.nativeRunner).toMatchObject({ maxRuntimeMs: 500, maxLifetimeMs: 500 });
      now += 501;
      expect(() => handle.restart!("expired-ticket")).toThrow("runner_process_lifetime_expired");
      expect(launches).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });

  it.skipIf(!supported)("allows an explicit cold local owner while rejecting absent and broadened authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "antigravity-candidate-startup-"));
    try {
      const options = { provider: "acpx" as const, acpxAgent: "antigravity" as const, stateDirectory: root, acpxCandidateAdmission: candidate() };
      expect(() => createRunnerdCodexTransport({ ...options, acpxCandidateAdmission: undefined })).toThrow("evaluation opt-in");
      const owner = createRunnerdCodexTransport(options);
      await owner.transport.close();
      for (const change of [{ lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 1000 } }, { runnerFilesystemRoot: "/guest" },
        { homeMode: "preconfigured" as const }, { resumeProviderSession: { driverSessionId: "old-session" } },
        { provider: "codex" as const },
        { acpxCandidateAdmission: { ...candidate(), nativeClosureDigest: `sha256:${"a".repeat(64)}` } }]) {
        expect(() => createRunnerdCodexTransport({ ...options, ...change })).toThrow();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(!supported)("loads a settled native conversation only through a fresh current-run owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "antigravity-candidate-continuation-"));
    const admission = candidate();
    const retained = { driverSessionId: "driver-retained", providerSessionId: "native-retained", providerIdentity: {
      kind: "acpx", normalizedSessionId: identity.normalizedSessionId,
      // The recovery binding digest is distinct from the release command digest.
      profileDigest: `sha256:${"a".repeat(64)}`, requestedModel: admission.model, effectiveModel: admission.model,
    } };
    try {
      const options = { provider: "acpx" as const, acpxAgent: "antigravity" as const, stateDirectory: root,
        acpxCandidateAdmission: admission, prpIdentity: identity, resumeWorkingDirectory: root,
        resumeProviderSession: retained, providerRecoveryPolicy: "allow_replacement_after_governed_wait" as const };
      const owner = createRunnerdCodexTransport(options);
      expect(owner.transport.prepareConversationResume).toBeTypeOf("function");
      await expect(owner.transport.prepareConversationResume!({ threadId: retained.driverSessionId, model: "wrong-model", cwd: root })).rejects.toThrow("exact current conversation");
      await expect(owner.transport.prepareConversationResume!({ threadId: retained.driverSessionId, model: admission.model, cwd: "/wrong-workspace" })).rejects.toThrow("exact current conversation");
      await owner.transport.close();
      expect(() => createRunnerdCodexTransport({ ...options, resumeActiveTurnId: "stale-active-turn" })).toThrow("fresh local isolated");
      expect(() => createRunnerdCodexTransport({ ...options, resumeProviderSession: { ...retained,
        providerIdentity: { ...retained.providerIdentity, effectiveModel: "wrong-model" } } })).toThrow("exact retained native conversation");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("binds the startup authority to the actual Runner identity and keeps it out of provider configuration", () => {
    const admission = bindAcpxCandidateAdmission(candidate(), identity);
    const launches: RunnerProcessLaunchSpec[] = [];
    spawnRunner({ connection: { mode: "connect", connectUrl: "ws://127.0.0.1:43127" }, stateDirectory: "/unused/candidate", identity,
      ticket: "inert-ticket", maxOutboxBytes: 262144, p0ReserveBytes: 65536, runnerVersion: "fixture", runnerDigest: `sha256:${"f".repeat(64)}`,
      acpxLaunchProfile: { candidateAdmission: admission, authorityDigest: `sha256:${"d".repeat(64)}`, command: "/owned/node", commandSha256: `sha256:${"b".repeat(64)}`, sidecarScript: "/owned/sidecar.cjs", sidecarScriptSha256: `sha256:${"c".repeat(64)}` },
      environment: {}, processLauncher: spec => { launches.push(spec); return { child: { pid: 42, exitCode: 0, signalCode: null, kill: () => true }, completion: Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "" }) }; },
    });
    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    const flag = launch.args.indexOf("--acpx-candidate-admission-json");
    expect(flag).toBeGreaterThan(0);
    expect(JSON.parse(launch.args[flag + 1]!)).toEqual({ ...candidate(), ...admission });
    expect(launch.nativeRunner?.acpxLaunchProfile?.candidateAdmission).toEqual(admission);
    expect(JSON.stringify(launch.environment)).not.toContain(admission.schema);
    expect(runnerdLaunchProfileInternals.openedThreadModelProvider("acpx", "antigravity", admission.model)).toBe("google");
  });
});
