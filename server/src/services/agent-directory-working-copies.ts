import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, environmentLeases, environments, agentInstructionWorkingCopies as copies, type Db } from "@paperclipai/db";
import { syncDirectoryToSsh, restoreWorkspaceFromSshExecution } from "@paperclipai/adapter-utils/ssh";
import { prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget, type PreparedAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";
import { withDirectoryMergeLock, directorySnapshotSha256, parseDirectorySnapshot, serializeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { AGENT_FILES_CONTRACT, AgentFileLimitError, agentFileStore, agentStorageWarning, inspectAgentDirectory } from "./agent-file-store.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot } from "./agent-instructions.js";
import { instructionGitExcludeProgram } from "./agent-instruction-files.js";
import { resolveInstructionActor } from "./agent-instruction-authorization.js";
import { HttpError, conflict, notFound } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { cachedAgentFileManifest, captureAgentFileCheckpoint, checkpointBaseline, checkpointSnapshot, type AgentFileManifest } from "./agent-file-checkpoints.js";
import { logger } from "../middleware/logger.js";

type Copy = typeof copies.$inferSelect;
const completed = new Set(["saved", "unchanged", "resolved", "unavailable"]);
const transports = new Map<string, PreparedAdapterExecutionTargetRuntime>();
const key = (row: Pick<Copy, "companyId" | "runId">) => `${row.companyId}:${row.runId}`;
export function isAgentDirectoryCopy(row: Pick<Copy, "receipt"> | null): boolean {
  return row?.receipt?.schema === AGENT_FILES_CONTRACT;
}
function baseline(row: Copy) {
  const snapshot = parseDirectorySnapshot(row.receipt?.baseline);
  if (!snapshot || directorySnapshotSha256(snapshot) !== row.baseHash) throw new Error("Agent directory baseline is invalid");
  return snapshot;
}
function actor(row: Copy): AuthorizationActor {
  return { type: "agent", companyId: row.companyId, agentId: row.agentId, runId: row.runId, onBehalfOfUserId: row.responsibleUserId };
}
export function agentDirectoryWorkingCopyService(db: Db, get: (companyId: string, runId: string) => Promise<Copy | null>, patch: (row: Copy, values: Partial<typeof copies.$inferInsert>) => Promise<Copy>, environmentRuntime?: EnvironmentRuntimeService) {
  const store = agentFileStore(db);
  const ownerFile = (row: Copy) => path.join(path.dirname(row.localRoot), "owner.json");
  async function owns(row: Copy) {
    if (row.receipt?.warm !== true) return true;
    return await fs.readFile(ownerFile(row), "utf8").then(s => JSON.parse(s).runId === row.runId).catch(error => error.code === "ENOENT" && row.processStoppedAt !== null);
  }
  async function canReuse(companyId: string, agentId: string, runId: string) {
    const row = await get(companyId, runId);
    if (!row || row.agentId !== agentId || row.state !== "warm_saved" || row.errorCode || !await owns(row)) return false;
    const entry = baseline(row).entries.get(row.entryFile);
    if (entry?.kind !== "file" || entry.hash !== row.receipt?.sessionEntryHash) return false;
    return store.locked(companyId, agentId, actor(row), false, async (_tx, _agent, root) =>
      directorySnapshotSha256(checkpointSnapshot(await cachedAgentFileManifest(root))) === row.baseHash);
  }
  async function transport(row: Copy, target: AdapterExecutionTarget, recovering: boolean) {
    if (target.kind !== "remote" || row.location !== `remote:${target.environmentId ?? ""}`) throw new Error("Agent directory environment changed");
    if (recovering && target.transport === "ssh") throw new Error("The original SSH collector is unavailable");
    if (target.transport === "ssh") {
      // Reuse SSH's plain directory transfer without its task-workspace suffix
      // or Git-history discovery. The registered root is the exact writable root.
      await syncDirectoryToSsh({ spec: target.spec, localDir: row.localRoot, remoteDir: row.executionRoot, exclude: [".paperclip-runtime"] });
      return { target, workspaceRemoteDir: row.executionRoot, runtimeRootDir: null,
        assetDirs: {}, additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null,
        restoreWorkspace: () => restoreWorkspaceFromSshExecution({ spec: target.spec, localDir: row.localRoot,
          remoteDir: row.executionRoot, baselineSnapshot: { ...baseline(row), exclude: [".paperclip-runtime"] }, restoreGitHistory: false }) };
    }
    return prepareAdapterExecutionTargetRuntime({ target, runId: row.runId, adapterKey: "agent-files",
      workspaceLocalDir: row.localRoot, workspaceRemoteDir: row.executionRoot,
      syncWorkspace: true, workspaceInboundMode: recovering ? "adopt_remote" : undefined,
      workspaceBaseline: baseline(row), workspaceGitSnapshot: null, workspaceFileMode: "all",
      workspaceExclude: [".paperclip-runtime", ".paperclip-runtime/**"] });
  }
  async function prepare(input: { companyId: string; agentId: string; runId: string; target?: AdapterExecutionTarget | null; cwd: string; warm?: boolean; reuseRunId?: string }) {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    if (!agent) throw notFound("Agent not found");
    if (agentInstructionsBundleMode(agent) !== "managed") return null;
    const bound = await resolveInstructionActor(db, { type: "agent", companyId: input.companyId, agentId: input.agentId, runId: input.runId });
    const root = resolveManagedInstructionsRoot(agent);
    if (input.reuseRunId) {
      const prior = await get(input.companyId, input.reuseRunId);
      if (!prior || prior.agentId !== input.agentId) throw conflict("Managed warm directory owner changed");
      return serial(prior, async current => {
        if (current.state !== "warm_saved" || current.errorCode || !await owns(current) || current.location !== (input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local")) throw conflict("Managed warm directory is not reusable");
        const receipt = { ...current.receipt, cleanup: input.target?.kind === "remote" ? { leaseId: input.target.leaseId ?? null, remoteCwd: input.target.remoteCwd } : undefined };
        await db.insert(copies).values({ runId: input.runId, companyId: input.companyId, agentId: input.agentId, responsibleUserId: bound.onBehalfOfUserId!,
          entryFile: current.entryFile, baseHash: current.baseHash, localRoot: current.localRoot, executionRoot: current.executionRoot, location: current.location, state: "prepared", receipt });
        // The controller-owned marker fences every old callback before the
        // successor can execute. Never put it in the agent-writable directory.
        const temporary = `${ownerFile(current)}.next`;
        await fs.writeFile(temporary, JSON.stringify({ runId: input.runId }));
        await fs.rename(temporary, ownerFile(current));
        const runtime = transports.get(key(current));
        if (runtime) transports.set(key({ companyId: input.companyId, runId: input.runId }), runtime);
        transports.delete(key(current));
        await patch(current, { state: "superseded", receipt: { schema: AGENT_FILES_CONTRACT, warm: true, successorRunId: input.runId } });
        return (await get(input.companyId, input.runId))!;
      });
    }
    const localRoot = path.join(path.dirname(root), "file-sync", "runs", input.runId, "live");
    // Local copies live outside the task cwd. Remote copies use the reserved,
    // excluded runtime area inside the provider's confined workspace. They are
    // synchronized independently; provider HOME is never reinterpreted.
    const executionRoot = input.target?.kind === "remote"
      ? path.posix.join(input.target.remoteCwd, ".paperclip-runtime", "agent-files", input.agentId, input.runId)
      : localRoot;
    const location = input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local";
    let row = await get(input.companyId, input.runId);
    if (row && (row.localRoot !== localRoot || row.executionRoot !== executionRoot || row.agentId !== input.agentId || row.location !== location)) throw conflict("Agent directory belongs to a different execution environment");
    if (row && !completed.has(row.state) && row.state !== "preparing") {
      if (input.target?.kind === "remote" && !transports.has(key(row))) transports.set(key(row), await transport(row, input.target, true));
      return row;
    }
    // Register ownership before creating any bytes, so a crash during the copy
    // leaves a recoverable preparing receipt instead of an orphan directory.
    const preparing = { entryFile: deriveBundleState(agent).entryFile, baseRevisionId: null, baseHash: "preparing",
      localRoot, executionRoot, location, state: "preparing", candidateBase64: null, candidateHash: null,
      receipt: { schema: AGENT_FILES_CONTRACT, ...(input.warm ? { warm: true, directoryRunId: input.runId } : {}), ...(input.target?.kind === "remote"
        ? { cleanup: { leaseId: input.target.leaseId ?? null, remoteCwd: input.target.remoteCwd } } : {}) }, processStoppedAt: null, attempts: 0,
      nextAttemptAt: null, errorCode: null, errorMessage: null };
    if (row) row = await patch(row, preparing);
    else {
      await db.insert(copies).values({ runId: input.runId, companyId: input.companyId, agentId: input.agentId, responsibleUserId: bound.onBehalfOfUserId!, ...preparing });
      row = (await get(input.companyId, input.runId))!;
    }
    const { snapshot, storageWarning } = await store.locked(input.companyId, input.agentId, bound, false, async (_tx, _agent, canonical) => {
      // Storage quotas govern saves, never admission to a future run. Restore
      // existing bytes so the agent can work normally and remove excess files.
      // Path/link validation remains mandatory even for an over-quota folder.
      const inspected = await inspectAgentDirectory(canonical, false);
      // A stopped lifecycle has already accounted for all its bytes. No live
      // or pending candidate ever enters this replacement path.
      await fs.rm(localRoot, { recursive: true, force: true });
      await fs.mkdir(path.dirname(localRoot), { recursive: true, mode: 0o700 });
      try {
        await fs.cp(canonical, localRoot, { recursive: true, preserveTimestamps: true });
        return inspected;
      } catch (error) {
        await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
        throw error;
      }
    }).catch(async error => {
      await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
      throw error;
    });
    const loadedEntry = snapshot.entries.get(deriveBundleState(agent).entryFile);
    const values = { entryFile: deriveBundleState(agent).entryFile, baseRevisionId: null, baseHash: directorySnapshotSha256(snapshot),
      localRoot, executionRoot, location, state: "preparing", candidateBase64: null, candidateHash: null,
      receipt: { ...preparing.receipt, baseline: serializeDirectorySnapshot(snapshot), storageWarning,
        ...(input.warm ? { sessionEntryHash: loadedEntry?.kind === "file" ? loadedEntry.hash : null } : {}) },
      processStoppedAt: null, attempts: 0, nextAttemptAt: null, errorCode: null, errorMessage: null };
    try {
      row = await patch(row, values);
      if (input.warm) await fs.writeFile(ownerFile(row), JSON.stringify({ runId: row.runId }));
    } catch (error) {
      await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
      throw error;
    }
    try {
      if (input.target?.kind === "remote") {
        const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
        const excluded = await runAdapterExecutionTargetShellCommand(input.runId, input.target,
          `node -e ${quote(instructionGitExcludeProgram)} ${quote(input.target.remoteCwd)}`,
          { cwd: input.target.remoteCwd, env: {}, timeoutSec: 15 });
        if (excluded.exitCode !== 0 || excluded.timedOut) throw new Error("Could not exclude agent files from task Git staging");
        transports.set(key(row), await transport(row, input.target, false));
      }
      return await patch(row, { state: "prepared" });
    } catch (error) {
      // Preparation failed before a provider could start using this copy.
      row = await patch(row, { state: "unavailable", processStoppedAt: new Date(), errorCode: "AGENT_FILES_PREPARE_FAILED",
        errorMessage: "Agent files could not be staged. The temporary copy was discarded.", nextAttemptAt: null });
      await release(row, input.target);
      throw error;
    }
  }

  async function retrieve(row: Copy, target?: AdapterExecutionTarget | null) {
    if (row.location !== "local") {
      let runtime = transports.get(key(row));
      if (!runtime) {
        if (!target) throw new Error("Agent directory transport is unavailable");
        runtime = await transport(row, target, true);
        transports.set(key(row), runtime);
      }
      await runtime.restoreWorkspace();
    }
    return inspectAgentDirectory(row.localRoot);
  }
  async function hasChanges(_row: Copy, _target?: AdapterExecutionTarget | null) {
    // A whole-directory collector needs a quiescent provider, including its
    // child processes. Checkpoint and close at the turn boundary before reading
    // either local or remote files. The provider conversation remains resumable;
    // ordinary file edits do not change the session configuration digest.
    return true;
  }
  async function checkpoint(row: Copy, target?: AdapterExecutionTarget | null, stopped = false): Promise<Copy> {
    if (!await owns(row) || row.state === "superseded") return row;
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      let captured: Awaited<ReturnType<typeof captureAgentFileCheckpoint>> | undefined;
      try {
        const previous = row.receipt?.checkpointManifest as AgentFileManifest | undefined ?? checkpointBaseline(baseline(row));
        captured = await captureAgentFileCheckpoint({ runId: row.runId, localRoot: row.localRoot, executionRoot: row.executionRoot, previous, target });
        const snapshot = checkpointSnapshot(captured.manifest);
        const nextHash = directorySnapshotSha256(snapshot);
        const changed = nextHash !== row.baseHash;
        const { storageWarning } = changed
          ? await store.apply({ companyId: row.companyId, agentId: row.agentId, sourceDir: path.join(captured.directory, "files"), baseline: baseline(row), checkpoint: captured.manifest }, actor(row))
          : await store.locked(row.companyId, row.agentId, actor(row), true, async () => ({
            storageWarning: typeof row.receipt?.storageWarning === "string" ? row.receipt.storageWarning : null,
          }));
        row = await patch(row, { state: stopped ? (changed ? "saved" : "unchanged") : "warm_saved", baseHash: nextHash,
          candidateHash: nextHash, errorCode: null, errorMessage: null, attempts: 0, nextAttemptAt: null,
          ...(stopped ? { processStoppedAt: new Date() } : {}),
          receipt: { ...row.receipt, baseline: serializeDirectorySnapshot(snapshot), checkpointManifest: captured.manifest,
            checkpointState: changed ? "saved" : "unchanged", checkpointStats: captured.stats, storageWarning } });
        return row;
      } catch (error) {
        failure = error;
        logger.warn({ err: error, runId: row.runId, attempt: attempt + 1, stopped }, "Agent file checkpoint failed");
      }
      finally {
        await captured?.cleanup().catch(error => logger.warn({ err: error, runId: row.runId }, "Agent checkpoint scratch cleanup deferred to session retirement"));
      }
    }
    if (!stopped) return patch(row, { errorCode: "AGENT_FILES_CHECKPOINT_UNSTABLE", errorMessage: "Incremental checkpoint could not be validated; collecting after provider stop.", nextAttemptAt: null });
    const storageLimit = failure instanceof AgentFileLimitError || String(failure).includes("LIMIT_EXCEEDED");
    return patch(row, { state: "unavailable", processStoppedAt: new Date(), errorCode: storageLimit ? "AGENT_FILES_LIMIT_EXCEEDED" : "AGENT_FILES_SAVE_FAILED",
      errorMessage: "Agent-file synchronization failed after provider stop. No successful save is claimed.", nextAttemptAt: null,
      receipt: { ...row.receipt, storageWarning: storageLimit ? agentStorageWarning(failure instanceof AgentFileLimitError ? failure.message : "Agent folder exceeds a storage limit") : null } });
  }
  async function collectStopped(row: Copy, target?: AdapterExecutionTarget | null) {
    if (!await owns(row) || row.state === "superseded") return row;
    if (row.receipt?.warm === true && !completed.has(row.state)) {
      row = await checkpoint(row, target, true);
      await release(row, target);
      return (await get(row.companyId, row.runId))!;
    }
    if (completed.has(row.state)) { await release(row); return (await get(row.companyId, row.runId))!; }
    row = await patch(row, { processStoppedAt: row.processStoppedAt ?? new Date() });
    // The stopped working copy is the only temporary tree. Retry transient I/O
    // at this boundary, then clean it up; there are no preserved run snapshots.
    let inspected: Awaited<ReturnType<typeof retrieve>> | undefined;
    for (;;) {
      row = await patch(row, { attempts: row.attempts + 1 });
      try {
        inspected ??= await retrieve(row, target);
        const { snapshot } = inspected;
        const candidateHash = directorySnapshotSha256(snapshot);
        let storageWarning = inspected.storageWarning;
        if (candidateHash === row.baseHash) {
          row = await patch(row, { state: "unchanged", errorCode: null, errorMessage: null, nextAttemptAt: null });
        } else {
          ({ storageWarning } = await store.apply({ companyId: row.companyId, agentId: row.agentId, sourceDir: row.localRoot, baseline: baseline(row) }, actor(row)));
          row = await patch(row, { state: "saved", candidateHash, errorCode: null, errorMessage: null, nextAttemptAt: null });
        }
        row = await patch(row, { receipt: { ...row.receipt, storageWarning } });
        break;
      } catch (error) {
        const retryable = !(error instanceof HttpError) || error.status >= 500;
        if (retryable && row.attempts < 3) continue;
        row = await patch(row, { state: "unavailable", nextAttemptAt: null,
          receipt: { ...row.receipt, storageWarning: error instanceof AgentFileLimitError ? agentStorageWarning(error.message) : row.receipt?.storageWarning ?? null },
          errorCode: error instanceof AgentFileLimitError ? "AGENT_FILES_LIMIT_EXCEEDED" : "AGENT_FILES_SAVE_FAILED",
          errorMessage: error instanceof HttpError && error.status === 422
            ? `${error.message}. This run's agent-folder changes were not saved; the temporary copy is discarded.`
            : "Agent-file synchronization failed. No successful save is claimed; the temporary copy is discarded.",
        });
        break;
      }
    }
    await release(row);
    return (await get(row.companyId, row.runId))!;
  }
  async function release(row: Copy, target?: AdapterExecutionTarget | null) {
    if (row.state === "superseded" || !await owns(row) || row.receipt?.warm === true && !row.processStoppedAt) return;
    // Collection and environment teardown can both release the same copy.
    // A compact successful cleanup receipt is final, even after restart.
    if (completed.has(row.state) && row.processStoppedAt && row.receipt?.cleanupPending === false) return;
    const runtime = transports.get(key(row));
    transports.delete(key(row));
    let cleanupPending = false;
    await runtime?.cleanupWorkspaceSnapshot?.().catch(() => { cleanupPending = true; });
    const cleanupTarget = target ?? runtime?.target;
    if (row.processStoppedAt && completed.has(row.state) && cleanupTarget?.kind === "remote") {
      const expected = path.posix.join(cleanupTarget.remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, String(row.receipt?.directoryRunId ?? row.runId));
      if (row.executionRoot !== expected) throw new Error("Agent directory cleanup path changed");
      const quoted = `'${expected.replaceAll("'", `'"'"'`)}'`;
      const remoteCleanupFailed = await runAdapterExecutionTargetShellCommand(row.runId, cleanupTarget, `rm -rf -- ${quoted}`,
        { cwd: cleanupTarget.remoteCwd, env: {}, timeoutSec: 15 }).then(result => result.exitCode !== 0 || result.timedOut, () => true);
      cleanupPending ||= remoteCleanupFailed;
    } else if (row.processStoppedAt && completed.has(row.state) && row.location !== "local") {
      // Rebind only the original host-owned lease. Never acquire a replacement
      // sandbox or persist transport credentials in a working-copy receipt.
      cleanupPending ||= !await cleanupRemoteAfterRestart(row).catch(() => false);
    }
    if (completed.has(row.state) && row.processStoppedAt) {
      try { await fs.rm(path.dirname(row.localRoot), { recursive: true, force: true }); }
      catch {
        // Leave the baseline marker so restart recovery retries failed cleanup.
        await patch(row, { receipt: { ...row.receipt, cleanupPending: true } });
        return;
      }
      await patch(row, { receipt: { schema: AGENT_FILES_CONTRACT, state: row.state, appliedCandidateHash: row.candidateHash, storageWarning: row.receipt?.storageWarning ?? null, cleanupPending,
        ...(row.receipt?.directoryRunId ? { directoryRunId: row.receipt.directoryRunId } : {}),
        ...(cleanupPending ? { cleanup: row.receipt?.cleanup } : {}) },
        nextAttemptAt: cleanupPending ? new Date(Date.now() + 30_000) : null });
    }
  }
  async function cleanupRemoteAfterRestart(row: Copy): Promise<boolean> {
    const cleanup = row.receipt?.cleanup as { leaseId?: string; remoteCwd?: string } | undefined;
    // Older preview receipts did not record the lease ID. Accept only a unique
    // lease still bound to this run and environment in that compatibility case.
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, row.companyId),
      cleanup?.leaseId ? eq(environmentLeases.id, cleanup.leaseId) : and(
        eq(environmentLeases.environmentId, row.location.slice("remote:".length)), eq(environmentLeases.heartbeatRunId, row.runId)),
    ));
    if (leases.length !== 1) return false;
    const lease = leases[0]!;
    const termination = lease.metadata?.remoteExecutionTermination as { state?: string } | undefined;
    if (hasRemoteTerminationReceipt(lease) && termination?.state === "destroyed") return true;
    if (!environmentRuntime || !lease.environmentId || row.location !== `remote:${lease.environmentId}`) return false;
    const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId));
    if (!environment) return false;
    const remoteCwd = cleanup?.remoteCwd ?? lease.metadata?.remoteCwd;
    if (typeof remoteCwd !== "string" || row.executionRoot !== path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, String(row.receipt?.directoryRunId ?? row.runId))) return false;
    const result = await environmentRuntime.execute({ environment: environment as Environment, lease: lease as EnvironmentLease, command: "rm", args: ["-rf", "--", row.executionRoot],
      cwd: remoteCwd, env: {}, timeoutMs: 15_000, bypassSession: true });
    return result.exitCode === 0 && !result.timedOut;
  }
  async function serial<T>(row: Copy, fn: (current: Copy) => Promise<T>): Promise<T> {
    // Duplicate stop callbacks and restart recovery must not race while moving
    // the stopped working copy. This lock is outside the writable tree.
    return withDirectoryMergeLock(path.resolve(row.localRoot, "../../.."), async () => {
      const current = await get(row.companyId, row.runId);
      if (!current) throw notFound("Agent directory copy not found");
      return fn(current);
    });
  }
  return { prepare, hasChanges, canReuse,
    checkpointWarm: (row: Copy, target?: AdapterExecutionTarget | null) => serial(row, current => current.receipt?.warm === true ? checkpoint(current, target) : Promise.resolve(current)),
    collectStopped: (row: Copy, target?: AdapterExecutionTarget | null) => serial(row, current => collectStopped(current, target)),
    release: (row: Copy) => serial(row, release),
  };
}
