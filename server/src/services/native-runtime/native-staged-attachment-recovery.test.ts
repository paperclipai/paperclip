import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurablePrpControlPlane, type DurablePrpCheckpoint } from "../../vendor/paperclip-runner/index.js";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { resolveNativeStagedAttachmentRecovery } from "./native-staged-attachment-recovery.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const issueId = "20000000-0000-4000-8000-000000000002";
const agentId = "30000000-0000-4000-8000-000000000003";
const sourceRunId = "40000000-0000-4000-8000-000000000004";
const currentRunId = "50000000-0000-4000-8000-000000000005";
const normalizedSessionId = "60000000-0000-4000-8000-000000000006";
const runnerInstanceId = "70000000-0000-4000-8000-000000000007";
const sourceIdentity = { runId: sourceRunId, normalizedSessionId, runnerInstanceId,
  environmentLeaseId: "environment-1", turnId: "opaque-source-turn", itemId: "opaque-source-item" };
const targetIdentity = { ...sourceIdentity, runId: currentRunId, turnId: "opaque-target-turn", itemId: "opaque-target-item" };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function execution(runId: string) {
  return buildNativeExecutionInput({ companyId, runId, agentId, normalizedSessionId,
    issue: { id: issueId, identifier: "TEST-1", title: "Continue", description: null, workMode: "standard" },
    taskPrompt: "Continue normally", provider: "codex", workspace: { id: "workspace-1", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    completionContract: { id: "80000000-0000-4000-8000-000000000008", sha256: `sha256:${"a".repeat(64)}`,
      schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Continue", criteria: [{ id: "done", requirement: "Answer" }] } },
    runtimeContext: nativeRuntimeContextFixture(),
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-staged-proof-")); roots.push(root);
  const core = new DurablePrpControlPlane({ stateDirectory: root, identity: sourceIdentity,
    expectedRunnerVersion: "0.0.0", expectedRunnerDigest: `sha256:${"f".repeat(64)}` });
  let saved!: DurablePrpCheckpoint;
  core.setCheckpointPersistence(async checkpoint => { saved = checkpoint; });
  core.persistRunAttachTemplate({ provider: { provider: "codex", command: "codex" }, authorizedTools: {} });
  await core.flushCheckpoint();
  const sourceHeader = saved.records.get("header")!;
  core.stageRunAttachment(targetIdentity, { provider: { provider: "codex", command: "codex" }, authorizedTools: {} });
  await core.flushCheckpoint();
  const header = saved.records.get("header")!;
  const base = { companyId, agentId, issueId, nativeIssueId: issueId, runnerInstanceId,
    nativeSessionId: normalizedSessionId, runtimeMode: "native", status: "running", finishedAt: null as Date | null };
  const currentRun = { ...base, id: currentRunId, runnerProfileJson: { nativeExecutionInput: execution(currentRunId) } };
  const sourceRun = { ...base, id: sourceRunId, status: "succeeded", finishedAt: new Date(), runnerProfileJson: {
    nativeExecutionInput: execution(sourceRunId), nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "codex"),
    sessionCheckpoint: { sessionId: "provider-thread-1", providerSessionId: "provider-thread-1", identity: {
      companyId, issueId, agentId, runId: sourceRunId, sessionId: normalizedSessionId },
    },
  } };
  const source = { run: sourceRun, coordinator: { runId: sourceRunId, companyId, issueId,
    phase: "committed", resultId: "result-1", leaseOwner: null, leaseExpiresAt: null }, resultId: "result-1", resultStatus: "accepted" };
  function database(sourceRows = [source], contents = sourceHeader, envelope = {}) {
    const material = createLocalEncryptedCipher("write").encrypt(JSON.stringify({ companyId, issueId, runId: sourceRunId, part: "header", contents, ...envelope }));
    const batches: unknown[][] = [sourceRows, [{ material }]];
    const select = vi.fn(() => {
      const chain = { from: () => chain, innerJoin: () => chain, where: () => chain,
        limit: vi.fn(async () => batches.shift() ?? []) };
      return chain;
    });
    return { db: { select } as unknown as Pick<Db, "select">, select };
  }
  return { header, sourceHeader, source, sourceRun, currentRun, database };
}

describe("private staged attachment restart evidence", () => {
  it("proves both frozen run bindings before the target has a session snapshot", async () => {
    const f = await fixture(); const { db, select } = f.database();
    const matchesExecution = vi.fn(() => true);
    const result = await resolveNativeStagedAttachmentRecovery({ db, header: f.header, currentRun: f.currentRun,
      expectedTarget: targetIdentity, matchesExecution });
    expect(result).toMatchObject({ sourceIdentity, targetIdentity, sourceRun: { id: sourceRunId }, hasTargetCheckpoint: false, targetCheckpoint: null,
      protocolIdentity: sourceIdentity, phase: "source_bootstrap", receipt: null });
    expect(matchesExecution).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledTimes(2); // one source point lookup and one encrypted header point lookup
    expect(f.currentRun.runnerProfileJson).not.toHaveProperty("sessionCheckpoint");
  });

  it("retains staged evidence when the target runtime has already published its snapshot", async () => {
    const f = await fixture();
    const snapshot = structuredClone(f.sourceRun.runnerProfileJson.sessionCheckpoint);
    snapshot.identity.runId = currentRunId;
    Object.assign(snapshot, { cursor: "target-cursor", activeTurnId: "target-current-turn", pendingRuntimeRequests: [{ requestId: "target-request" }] });
    Object.assign(f.currentRun.runnerProfileJson, { sessionCheckpoint: snapshot });
    const result = await resolveNativeStagedAttachmentRecovery({ ...f.database(), header: f.header, currentRun: f.currentRun });
    expect(result).toMatchObject({ sourceIdentity, targetIdentity, checkpoint: { identity: { runId: currentRunId } },
      hasTargetCheckpoint: true, targetCheckpoint: snapshot });
    expect(f.currentRun.runnerProfileJson).toHaveProperty("sessionCheckpoint", snapshot);
  });

  it("returns the codec's queued phase without assuming the Runner has activated the target", async () => {
    const f = await fixture(); const header = JSON.parse(f.header);
    // Header inspection deliberately does not certify separate command records.
    // Full restoration/authentication owns that later gate; no RPC runs here.
    header.state.stagedRunAttachment.commandId = "staged-attach-command";
    const result = await resolveNativeStagedAttachmentRecovery({ ...f.database(), header: JSON.stringify(header), currentRun: f.currentRun });
    expect(result).toMatchObject({ commandId: "staged-attach-command", protocolIdentity: sourceIdentity,
      phase: "attachment_queued", receipt: null, targetIdentity });
  });

  it.each(["runId", "companyId", "issueId", "agentId", "sessionId", "providerSessionId"])(
    "rejects a present target checkpoint with changed %s instead of replaying the source", async key => {
      const f = await fixture(); const snapshot = structuredClone(f.sourceRun.runnerProfileJson.sessionCheckpoint);
      snapshot.identity.runId = currentRunId;
      if (key === "providerSessionId") snapshot.providerSessionId = "foreign";
      else Object.assign(snapshot.identity, { [key]: "foreign" });
      Object.assign(f.currentRun.runnerProfileJson, { sessionCheckpoint: snapshot });
      expect(await resolveNativeStagedAttachmentRecovery({ ...f.database(), header: f.header, currentRun: f.currentRun })).toBeNull();
    });

  it.each(["runId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "turnId", "itemId"] as const)(
    "rejects a different expected target %s before querying the source", async key => {
      const f = await fixture(); const { db, select } = f.database();
      expect(await resolveNativeStagedAttachmentRecovery({ db, header: f.header, currentRun: f.currentRun,
        expectedTarget: { ...targetIdentity, [key]: "foreign" } })).toBeNull();
      expect(select).not.toHaveBeenCalled();
    });

  it.each(["agentId", "companyId", "nativeIssueId", "nativeSessionId", "runnerInstanceId"] as const)(
    "rejects mixed source DB %s", async key => {
      const f = await fixture(); Object.assign(f.source.run, { [key]: "foreign" });
      expect(await resolveNativeStagedAttachmentRecovery({ ...f.database(), header: f.header, currentRun: f.currentRun })).toBeNull();
    });

  it.each(["binding", "schema", "runner", "session"])("rejects current frozen evidence mismatch: %s", async kind => {
    const f = await fixture(); const { db, select } = f.database();
    if (kind === "binding") f.currentRun.runnerProfileJson.nativeExecutionInput.binding.agentId = sourceRunId;
    if (kind === "schema") Object.assign(f.currentRun.runnerProfileJson.nativeExecutionInput, { schema: "unsupported" });
    if (kind === "runner") f.currentRun.runnerInstanceId = sourceRunId;
    if (kind === "session") f.currentRun.nativeSessionId = sourceRunId;
    expect(await resolveNativeStagedAttachmentRecovery({ db, header: f.header, currentRun: f.currentRun })).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it.each(["phase", "leaseOwner", "resultStatus", "status", "finishedAt", "frozenRun", "workspace", "provider", "sourceTuple", "artifactVersion", "artifactDigest"])(
    "rejects unsupported or stale source evidence: %s", async kind => {
      const f = await fixture(); let sourceHeader = f.sourceHeader;
      if (kind === "phase") f.source.coordinator.phase = "observed";
      if (kind === "leaseOwner") Object.assign(f.source.coordinator, { leaseOwner: "another-owner", leaseExpiresAt: new Date(0) });
      if (kind === "resultStatus") f.source.resultStatus = "rejected";
      if (kind === "status") f.source.run.status = "running";
      if (kind === "finishedAt") Object.assign(f.source.run, { finishedAt: null });
      if (kind === "frozenRun") f.source.run.runnerProfileJson.nativeExecutionInput.binding.runId = currentRunId;
      if (kind === "workspace") f.source.run.runnerProfileJson.nativeExecutionInput.binding.executionWorkspaceId = "foreign";
      if (kind === "provider") Object.assign(f.source.run.runnerProfileJson.nativeExecutionInput.provider, { model: "another-model" });
      if (kind === "sourceTuple") { const h = JSON.parse(sourceHeader); h.state.identity.turnId = "foreign"; sourceHeader = JSON.stringify(h); }
      if (kind === "artifactVersion") { const h = JSON.parse(sourceHeader); h.runnerVersion = "other-version"; sourceHeader = JSON.stringify(h); }
      if (kind === "artifactDigest") { const h = JSON.parse(sourceHeader); h.runnerDigest = `sha256:${"d".repeat(64)}`; sourceHeader = JSON.stringify(h); }
      expect(await resolveNativeStagedAttachmentRecovery({ ...f.database([f.source], sourceHeader), header: f.header, currentRun: f.currentRun })).toBeNull();
    });

  it("keeps private executor scope/config verification mandatory when supplied", async () => {
    const f = await fixture();
    expect(await resolveNativeStagedAttachmentRecovery({ ...f.database(), header: f.header, currentRun: f.currentRun,
      matchesExecution: () => false })).toBeNull();
  });

  it.each(["companyId", "issueId", "runId", "part"])("rejects encrypted source header with another %s", async key => {
    const f = await fixture();
    expect(await resolveNativeStagedAttachmentRecovery({ ...f.database([f.source], f.sourceHeader, { [key]: "foreign" }),
      header: f.header, currentRun: f.currentRun })).toBeNull();
  });

  it("does not accept a source lacking the current tool contract or provider identity", async () => {
    const f = await fixture();
    f.source.run.runnerProfileJson.nativeToolContractFingerprint = "old-contract";
    expect(await resolveNativeStagedAttachmentRecovery({ ...f.database(), header: f.header, currentRun: f.currentRun })).toBeNull();
    f.source.run.runnerProfileJson.nativeToolContractFingerprint = nativeToolContractFingerprintForTarget("remote", "codex");
    f.source.run.runnerProfileJson.sessionCheckpoint.providerSessionId = "";
    expect(await resolveNativeStagedAttachmentRecovery({ ...f.database(), header: f.header, currentRun: f.currentRun })).toBeNull();
  });

  it("rejects corrupted or ordinary headers instead of promoting them to staged evidence", async () => {
    const f = await fixture();
    for (const header of [f.sourceHeader, "{}", "not-json"]) {
      const { db, select } = f.database();
      expect(await resolveNativeStagedAttachmentRecovery({ db, header, currentRun: f.currentRun })).toBeNull();
      expect(select).not.toHaveBeenCalled();
    }
  });
});
