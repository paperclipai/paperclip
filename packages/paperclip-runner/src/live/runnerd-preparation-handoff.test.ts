import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { decodeDurablePrpCheckpoint, DurablePrpControlPlane, type DurablePrpCheckpoint } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

it("saves recoverable authority before external preparation and resumes the same run after controller loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-preparation-handoff-"));
  const oldRoot = join(root, "old"), newRoot = join(root, "new");
  const binary = defaultCapabilityRunnerdBinary();
  const runnerArtifact = { version: "0.3.0", digest: `sha256:${createHash("sha256").update(await readFile(binary)).digest("hex")}` };
  const identity = { runnerInstanceId: "preparing-runner", environmentLeaseId: "preparing-lease", runId: "preparing-run",
    normalizedSessionId: "preparing-session", turnId: "preparing-turn", itemId: "preparing-item" };
  let entered!: () => void, release!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const continuePreparation = new Promise<void>(resolve => { release = resolve; });
  let saved: DurablePrpCheckpoint | null = null;
  const persist = async (authority: DurablePrpControlPlane) => {
    authority.enablePreparationHandoff();
    authority.setCheckpointPersistence(async checkpoint => { saved = checkpoint; });
    await authority.flushCheckpoint();
  };
  const prepare = async (requirements: RunnerProviderLaunchRequirements) => ({
    configurationId: "same-preparation", requirementsDigest: runnerLaunchRequirementsDigest(requirements),
    provider: createRunnerProviderLaunch(requirements, { options: { codexArgs: fakeCodexArgs(root) }, root, cwd: tmpdir(),
      codexHome: join(root, "guest-home"), codexCommand: fakeCodex, providerNodeCommand: process.execPath,
      opencodeProxyPath: "", acpxSidecarPath: "" }),
  });
  const options = { runnerBinary: binary, runnerArtifact, prpIdentity: identity,
    controlPlaneCheckpointRegistration: persist,
    controlPlaneRegistration: async (authority: DurablePrpControlPlane) => {
      await authority.start();
      return { release: () => undefined };
    },
  };
  const launch = vi.fn(() => { throw new Error("old preparation must not launch"); });
  const first = createCapabilityRunnerdCodexTransport({ ...options, stateDirectory: oldRoot,
    prepareLaunch: async requirements => { entered(); await continuePreparation; return prepare(requirements); },
    runnerProcessLauncher: launch,
  });
  const pending = first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] }).catch(error => error);
  let successor: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  try {
    await preparing;
    expect(saved).not.toBeNull();
    await first.detachControllerForRestart();
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(launch).not.toHaveBeenCalled();
    const checkpoint = saved as DurablePrpCheckpoint | null;
    if (!checkpoint) throw new Error("preparation authority was not saved");
    checkpoint.restoreSessionDirectory(newRoot);
    successor = createCapabilityRunnerdCodexTransport({ ...options, stateDirectory: newRoot,
      codexCommand: fakeCodex, codexArgs: fakeCodexArgs(root),
    });
    const opened = await successor.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
    expect(opened.thread).toEqual(expect.objectContaining({ id: expect.any(String) }));
    expect(successor.evidence().runnerPid).toEqual(expect.any(Number));
    expect(launch).not.toHaveBeenCalled();
  } finally {
    release();
    await pending;
    await successor?.transport.close().catch(() => undefined);
    await first.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("restores an expired pending launch capability without minting a second credential", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const root = await mkdtemp(join(tmpdir(), "pending-launch-capability-"));
  const identity = { runnerInstanceId: "pending-runner", environmentLeaseId: "pending-lease", runId: "pending-run",
    normalizedSessionId: "pending-session", turnId: "pending-turn", itemId: "pending-item" };
  const core = new DurablePrpControlPlane({ stateDirectory: join(root, "old"), identity,
    expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
  let saved: DurablePrpCheckpoint | undefined;
  core.enablePreparationHandoff();
  core.setCheckpointPersistence(async checkpoint => { saved = checkpoint; });
  const ticket = core.issueBootstrapTicket(1_000);
  await core.flushCheckpoint();
  const original = structuredClone(core.store.state.preparationHandoff!.pendingBootstrap!);
  vi.setSystemTime(original.expiresAtUnixMs + 1);
  let next: DurablePrpControlPlane | undefined;
  try {
    const checkpoint = decodeDurablePrpCheckpoint(saved!.records);
    expect(JSON.parse(checkpoint.records.get("header")!).schema).toBe("paperclip.runner.controller-checkpoint.v3");
    if (process.env.PAPERCLIP_PREPARATION_CHECKPOINT_PROOF) await writeFile(process.env.PAPERCLIP_PREPARATION_CHECKPOINT_PROOF,
      JSON.stringify([...checkpoint.records]), { mode: 0o600 });
    checkpoint.restoreSessionDirectory(join(root, "new"));
    next = new DurablePrpControlPlane({ stateDirectory: join(root, "new", "control-plane"), identity,
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    await expect(next.renewPendingBootstrapTicket("bootstrap_foreign")).rejects.toThrow("identity_mismatch");
    await next.renewPendingBootstrapTicket(ticket);
    const resumed = next.store.state.tickets[original.credentialId];
    expect(resumed).toMatchObject({ recordId: original.recordId, credentialId: original.credentialId,
      authKeyDigest: original.authKeyDigest, identity, usedAt: null });
    expect(resumed.expiresAtUnixMs).toBeGreaterThan(original.expiresAtUnixMs);
    expect(next.store.state.freshBootstraps).toBe(1);
    expect(next.store.state.bootstrapHistory?.credentialsIssued).toBe(1);
  } finally {
    await next?.stop();
    await core.stop();
    await rm(root, { recursive: true, force: true });
    vi.useRealTimers();
  }
});
