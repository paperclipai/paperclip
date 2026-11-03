import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseNativeExecutionInput, NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest, nativeRuntimePromptDigest } from "../../vendor/paperclip-runner/index.js";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { RunnerHarnessCheckpoint } from "@paperclipai/runner-sdk/contracts";
import { buildNativeHarnessBackupManifest, providerSessionIdentityFromDurableProviderState, resolveNativeBilling, resolveNativeHarnessPersistenceProfile } from "./native-session-executor.js";
import { prepareRemoteExtensionCheckpoint } from "./extension-session-persistence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const release = { harnessId: "fixture.native/independent", packageName: "@fixture/native", version: "1.0.0",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, runtimeDigest: `sha256:${"a".repeat(64)}`, protocolVersion: 1 as const };
const assetDigest = "0".repeat(64);
const context = { prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
  instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, rootPath: "/instructions", digest: assetDigest,
    manifestDigest: assetDigest, fileCount: 1, totalBytes: 10 } }, skills: [], mcp: { assignmentSetId: "none", digest: assetDigest, bindingId: null } };
const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v11", homeMode: "isolated",
  binding: { companyId: "company", agentId: "agent", issueId: "issue", runId: "next", executionWorkspaceId: "workspace" },
  provider: { kind: "extension", release, harnessId: release.harnessId, model: "exact-model", config: { mode: "native" }, capabilities: {} },
  task: { identifier: "FIX-1", title: "Persist native conversation", description: null, prompt: "Complete the persistence fixture.", workMode: "standard" },
  session: { normalizedSessionId: "normalized-session", driverKind: "extension", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
  workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
  completionContract: { id: "contract", sha256: "contract-digest", schemaVersion: "1", contract: { revision: "1", objective: "Persist native conversation",
    criteria: [{ id: "objective", requirement: "Native history remains available" }] } },
  interactionResponses: [], credentialBindings: [], executionMode: "default", planningContext: null,
  runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) },
});
const nativeIds = { providerSessionId: "native-thread", backendSessionId: "native-session" };
const empty = { providerSessionId: null, providerBackendSessionId: null, providerSessionIdentity: null };

it("attributes an installed harness without inheriting a built-in account identity", () => {
  expect(resolveNativeBilling(execution.provider, {}, { provider: "openai", biller: "openai", billingType: "metered_api" }))
    .toEqual({ provider: release.harnessId, biller: "unknown", billingType: "unknown" });
});

it("uses only core-observed native identities and refuses normalized IDs as invented fallback", () => {
  const state = { schema: "paperclip.harness-state.v1", sessionId: "normalized-session", activeTurn: false, processGroup: null,
    pendingRequests: {}, identity: release, provider: execution.provider, providerSessionIdentity: nativeIds };
  expect(providerSessionIdentityFromDurableProviderState({ execution, providerState: state })).toMatchObject({
    providerSessionId: "native-thread", providerBackendSessionId: "native-session",
    providerSessionIdentity: { kind: "extension", normalizedSessionId: "normalized-session", ...nativeIds },
  });
  for (const invalid of [{ ...state, providerSessionIdentity: undefined }, { ...state, providerSessionIdentity: { providerSessionId: "native-thread" } },
    { ...state, activeTurn: true }, { ...state, processGroup: 123 }, { ...state, pendingRequests: { live: {} } },
    { ...state, identity: { ...release, version: "2.0.0" } }]) {
    expect(providerSessionIdentityFromDurableProviderState({ execution, providerState: invalid })).toEqual(empty);
  }
  expect(providerSessionIdentityFromDurableProviderState({ execution, providerState: { ...state,
    providerSessionIdentity: { ...nativeIds, release: "override", normalizedSessionId: "unrelated" } } })).toMatchObject({
    providerSessionIdentity: { release, normalizedSessionId: "normalized-session" },
  });
  expect(resolveNativeHarnessPersistenceProfile(execution).directories.map(directory => directory.name)).toEqual(["runner", "extension"]);
});

const runner: Pick<CommandManagedRuntimeRunner, "execute"> = { execute: spec => new Promise(resolve => {
  const child = spawn(spec.command, spec.args ?? [], { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr, timedOut: false, pid: child.pid ?? null, startedAt: null }));
}) };

async function fixture(outcome: "resumed" | "replacement") {
  const root = await mkdtemp(join(tmpdir(), "extension-persistence-")); roots.push(root);
  const backupRoot = join(root, "backup"), remoteSessionRoot = join(root, "remote-session");
  const remoteHomeDirectory = join(remoteSessionRoot, "filesystem", "extension"), remoteStateDirectory = join(remoteSessionRoot, "runner", "next");
  await mkdir(join(backupRoot, "runner"), { recursive: true, mode: 0o700 });
  await mkdir(join(backupRoot, "extension"), { mode: 0o700 });
  await writeFile(join(backupRoot, "extension", "native-history.json"), JSON.stringify({ turns: 1 }), { mode: 0o600 });
  const checkpoint: RunnerHarnessCheckpoint = { schema: "paperclip.harness-checkpoint.v1", identity: release,
    normalizedSessionId: "normalized-session", model: "exact-model", config: { mode: "native" },
    providerSessionIdentity: nativeIds, providerState: { nativeSessionId: "native-session", turns: 1 }, processGroup: null,
    runtimeDirectory: remoteHomeDirectory };
  const provider = { schema: "paperclip.harness-state.v1", identity: release, runId: "prior", sessionId: "normalized-session",
    activeTurn: false, processGroup: null, events: [], pendingRequests: {}, providerSessionIdentity: nativeIds, snapshot: checkpoint.providerState,
    provider: { ...execution.provider, runtimeDirectory: remoteHomeDirectory } };
  const sourceRunner = { schema: "paperclip.runner.durable.state.v1", runId: "prior", lifecycle: "suspended",
    runnerInstanceId: "prior-runner", normalizedSessionId: "normalized-session", outbox: [], pendingTerminalDelivery: null };
  await writeFile(join(backupRoot, "runner", "runner-state.json"), JSON.stringify(sourceRunner));
  await writeFile(join(backupRoot, "runner", "extension-provider-state.json"), JSON.stringify(provider));
  const identity = providerSessionIdentityFromDurableProviderState({ execution, providerState: provider });
  const manifest = buildNativeHarnessBackupManifest({ backupRoot, execution, runnerInstanceId: "prior-runner",
    providerSessionIdentity: identity, sourceProviderLeaseId: "prior-lease" });
  await mkdir(remoteSessionRoot, { recursive: true });
  if (outcome === "resumed") {
    await cp(join(backupRoot, "runner"), join(remoteSessionRoot, "runner", "prior"), { recursive: true });
    await mkdir(join(remoteSessionRoot, "filesystem"), { recursive: true });
    await cp(join(backupRoot, "extension"), remoteHomeDirectory, { recursive: true });
  }
  const restoreHome = vi.fn(async (source: string, target: string) => { await mkdir(join(remoteSessionRoot, "filesystem"), { recursive: true }); await cp(source, target, { recursive: true }); });
  const input = { checkpoint, backup: { root: backupRoot, manifest }, currentRunId: "next", checkpointSourceRunId: "prior", remoteSessionRoot,
    remoteStateDirectory, remoteHomeDirectory, acquisitionOutcome: outcome,
    currentProviderLeaseId: outcome === "resumed" ? "prior-lease" : "replacement-lease", runner, restoreHome };
  return { root, input, restoreHome };
}

it.each(["resumed", "replacement"] as const)("recovers only the native home on a %s environment and keeps the new Runner epoch empty", async outcome => {
  const f = await fixture(outcome);
  await prepareRemoteExtensionCheckpoint(f.input);
  expect(await readFile(join(f.input.remoteHomeDirectory, "native-history.json"), "utf8")).toBe('{"turns":1}');
  await expect(access(join(f.input.remoteStateDirectory, "runner-state.json"))).rejects.toThrow();
  expect(f.restoreHome).toHaveBeenCalledTimes(outcome === "replacement" ? 1 : 0);
});

it("refuses a reused lease whose prior settled epoch or native history changed", async () => {
  const f = await fixture("resumed");
  await writeFile(join(f.input.remoteHomeDirectory, "native-history.json"), '{"turns":2}');
  await expect(prepareRemoteExtensionCheckpoint(f.input)).rejects.toThrow("source_unproven");
  expect(f.restoreHome).not.toHaveBeenCalled();
});

it("refuses a stale checkpoint, unrelated reused lease and an existing current Runner epoch", async () => {
  for (const kind of ["checkpoint", "lease", "epoch"] as const) {
    const f = await fixture("resumed");
    if (kind === "checkpoint") f.input.checkpointSourceRunId = "unrelated-prior-run";
    if (kind === "lease") f.input.currentProviderLeaseId = "unrelated-lease";
    if (kind === "epoch") { await mkdir(f.input.remoteStateDirectory, { recursive: true }); await writeFile(join(f.input.remoteStateDirectory, "runner-state.json"), "existing authority"); }
    await expect(prepareRemoteExtensionCheckpoint(f.input)).rejects.toThrow("source_unproven");
    expect(f.restoreHome).not.toHaveBeenCalled();
  }
});
