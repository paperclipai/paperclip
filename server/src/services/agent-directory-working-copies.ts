import { persistentAgentFiles, readPersistentAgentFile, seedPersistentAgentHome } from "./persistent-agent-files.js";
import { materializeInstructionBytes, readInstructionBytes } from "./agent-instruction-files.js";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, environmentLeases, environments, agentInstructionWorkingCopies as copies, type Db } from "@paperclipai/db";
import { syncDirectoryToSsh, restoreWorkspaceFromSshExecution } from "@paperclipai/adapter-utils/ssh";
import { prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget, type PreparedAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";
import { withDirectoryMergeLock, directorySnapshotSha256, parseDirectorySnapshot, serializeDirectorySnapshot, type DirectoryMergeLockOperation } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { AGENT_FILES_CONTRACT, AgentFileLimitError, agentFileStore, agentStorageWarning, inspectAgentDirectory } from "./agent-file-store.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot } from "./agent-instructions.js";
import { instructionGitExcludeProgram } from "./agent-instruction-files.js";
import { resolveInstructionActor } from "./agent-instruction-authorization.js";
import { HttpError, conflict, notFound } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { agentDirectoryBaselineDigest, agentDirectoryProbeProgram, observeLocalAgentDirectory } from "./agent-directory-probe.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { cachedAgentFileManifest, captureAgentFileCheckpoint, checkpointBaseline, checkpointSnapshot, type AgentFileManifest } from "./agent-file-checkpoints.js";
import { logger } from "../middleware/logger.js";

type Copy = typeof copies.$inferSelect;
export class AgentDirectoryReuseInvalidatedError extends Error {}
const persistent = (row: Pick<Copy, "receipt">) => row.receipt?.fileAuthority === "remote-persistent";
const completed = new Set(["saved", "unchanged", "resolved", "unavailable"]);
const transports = new Map<string, PreparedAdapterExecutionTargetRuntime>();
const key = (row: Pick<Copy, "companyId" | "runId">) => `${row.companyId}:${row.runId}`;
function sandboxTransferRoot(row: Copy, remoteCwd: string): string {
  const origin = typeof row.receipt?.materializationRunId === "string" ? row.receipt.materializationRunId : String(row.receipt?.directoryRunId ?? row.runId);
  return path.posix.join(remoteCwd, ".paperclip-runtime", "paperclip-runner", "agent-file-transfers", row.agentId, origin);
}
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
    if (persistent(row) || row.receipt?.warm !== true) return true;
    return await fs.readFile(ownerFile(row), "utf8").then(s => JSON.parse(s).runId === row.runId).catch(error => error.code === "ENOENT" && row.processStoppedAt !== null);
  }
  async function canReuse(companyId: string, agentId: string, runId: string) {
    const row = await get(companyId, runId);
    if (!row || row.agentId !== agentId || row.state !== "warm_saved" || row.errorCode || !await owns(row)) return false;
    if (persistent(row)) {
      const remote = await persistentAgentFiles(db, companyId, agentId, String(row.receipt?.environmentId));
      if (!remote || remote.root !== row.executionRoot) return false;
      return (await readPersistentAgentFile(remote, row.entryFile))?.sha256 === row.receipt?.sessionEntryHash;
    }
    const entry = baseline(row).entries.get(row.entryFile);
    if (entry?.kind !== "file" || entry.hash !== row.receipt?.sessionEntryHash) return false;
    return store.locked(companyId, agentId, actor(row), false, async (_tx, _agent, root) =>
      directorySnapshotSha256(checkpointSnapshot(await cachedAgentFileManifest(root))) === row.baseHash);
  }
  async function transport(row: Copy, target: AdapterExecutionTarget, recovering: boolean) {
    if (target.kind !== "remote" || row.location !== `remote:${target.environmentId ?? ""}`) throw new Error("Agent directory environment changed");
    if (target.transport === "ssh") {
      // Reuse SSH's plain directory transfer without its task-workspace suffix
      // or Git-history discovery. The registered root is the exact writable root.
      if (!recovering) await syncDirectoryToSsh({ spec: target.spec, localDir: row.localRoot, remoteDir: row.executionRoot, exclude: [".paperclip-runtime"] });
      return { target, workspaceRemoteDir: row.executionRoot, runtimeRootDir: null,
        assetDirs: {}, additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null,
        restoreWorkspace: () => restoreWorkspaceFromSshExecution({ spec: target.spec, localDir: row.localRoot,
          remoteDir: row.executionRoot, baselineSnapshot: { ...baseline(row), exclude: [".paperclip-runtime"] }, restoreGitHistory: false }) };
    }
    return prepareAdapterExecutionTargetRuntime({ target, runId: row.runId, adapterKey: "agent-files",
      workspaceLocalDir: row.localRoot, workspaceRemoteDir: row.executionRoot,
      // Agent files are an independently observed native directory. Transfer
      // scratch belongs to the host runtime, including the fallback selected
      // while plugin capability discovery is cold after controller restart.
      runtimeRootDir: sandboxTransferRoot(row, target.remoteCwd),
      syncWorkspace: true, workspaceInboundMode: recovering ? "adopt_remote" : undefined,
      workspaceBaseline: baseline(row), workspaceGitSnapshot: null, workspaceFileMode: "all",
      workspaceExclude: [".paperclip-runtime", ".paperclip-runtime/**"] });
  }
  async function observe(row: Copy, target?: AdapterExecutionTarget | null) {
    if (row.location === "local") {
      // The same bounded program validates aliases on its actual host.
      return observeLocalAgentDirectory(row.localRoot);
    }
    if (!target || target.kind !== "remote" || row.location !== `remote:${target.environmentId ?? ""}`) throw new Error("Agent directory environment changed");
    const origin = typeof row.receipt?.materializationRunId === "string" ? row.receipt.materializationRunId : row.runId;
    if (row.executionRoot !== path.posix.join(target.remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, origin)) throw new Error("Agent directory root changed");
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const result = await runAdapterExecutionTargetShellCommand(row.runId, target,
      `node -e ${quote(agentDirectoryProbeProgram)} ${quote(row.executionRoot)}`, { cwd: target.remoteCwd, env: {}, timeoutSec: 10 });
    if (result.exitCode !== 0 || result.timedOut || result.stdout.length > 1024) throw new Error("Agent directory observation unavailable");
    const value = JSON.parse(result.stdout);
    if (!value || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.identity !== "string") throw new Error("Invalid agent directory observation");
    return value as { digest: string; identity: string };
  }
  async function prepareCopy(input: { companyId: string; agentId: string; runId: string; target?: AdapterExecutionTarget | null; cwd: string; warm?: boolean; reuseRunId?: string; onWarmHandoff?: (copy: Copy) => void }, serialHeld = false): Promise<Copy | null> {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    if (!agent) throw notFound("Agent not found");
    if (agentInstructionsBundleMode(agent) !== "managed") return null;
    const bound = await resolveInstructionActor(db, { type: "agent", companyId: input.companyId, agentId: input.agentId, runId: input.runId });
    const root = resolveManagedInstructionsRoot(agent);
    if (input.target?.kind === "remote" && input.target.transport === "computer" && input.target.fileAuthority?.kind === "remote-persistent") {
      const authority = input.target.fileAuthority;
      const remote = await persistentAgentFiles(db, input.companyId, input.agentId, input.target.environmentId ?? undefined);
      if (!remote || remote.root !== authority.agentHome) throw conflict("Persistent agent placement changed");
      await store.locked(input.companyId, input.agentId, bound, false, async (_tx, _agent, canonical) => seedPersistentAgentHome(remote, canonical));
      const entryFile = deriveBundleState(agent).entryFile;
      let entry = await readPersistentAgentFile(remote, entryFile);
      if (!entry) {
        // An adopted directory may predate Paperclip. Deliver the missing managed
        // entry with create-only CAS, without replacing any personal bytes.
        const seed = await readInstructionBytes(root, entryFile);
        if (!seed) throw notFound("The persistent agent instruction entry is missing");
        await remote.writeBytes(entryFile, seed, null);
        entry = await readPersistentAgentFile(remote, entryFile);
        if (!entry) throw notFound("The persistent agent instruction entry is missing");
      }
      // Only prompt bytes are staged locally. This scratch is never an authority
      // for personal files, nor is it uploaded into the persistent directory.
      const localRoot = path.join(path.dirname(root), "file-sync", "runs", input.runId, "live");
      await materializeInstructionBytes(localRoot, entryFile, entry.bytes);
      const values = { entryFile, baseRevisionId: null, baseHash: entry.sha256, localRoot,
        executionRoot: authority.agentHome, location: `remote:${input.target.environmentId}`, state: "prepared",
        candidateBase64: null, candidateHash: null, processStoppedAt: null, attempts: 0,
        nextAttemptAt: null, errorCode: null, errorMessage: null,
        receipt: { schema: AGENT_FILES_CONTRACT, fileAuthority: "remote-persistent", placementId: authority.placementId,
          environmentId: input.target.environmentId, workspaceCwd: input.cwd, warm: input.warm === true,
          sessionEntryHash: entry.sha256, cleanupPending: false } };
      const existing = await get(input.companyId, input.runId);
      if (existing && (!persistent(existing) || existing.executionRoot !== authority.agentHome)) throw conflict("Agent file authority changed");
      const result = existing ? await patch(existing, values)
        : (await db.insert(copies).values({ companyId: input.companyId, agentId: input.agentId, runId: input.runId,
            responsibleUserId: bound.onBehalfOfUserId!, ...values }).returning())[0]!;
      input.onWarmHandoff?.(result);
      return result;
    }
    if (input.reuseRunId) {
      const prior = await get(input.companyId, input.reuseRunId);
      if (!prior || prior.agentId !== input.agentId) throw conflict("Managed warm directory owner changed");
      return serial(prior, async current => {
        if (current.state !== "warm_saved" || current.errorCode || !await owns(current) || current.location !== (input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local")) throw conflict("Managed warm directory is not reusable");
        const receipt = { ...current.receipt, cleanup: input.target?.kind === "remote" ? { leaseId: input.target.leaseId ?? null, remoteCwd: input.target.remoteCwd } : undefined };
        // Insert before taking the agent-row lock: this foreign key needs an
        // independent transaction, and must survive post-handoff failures.
        const [successor] = await db.insert(copies).values({ runId: input.runId, companyId: input.companyId, agentId: input.agentId, responsibleUserId: bound.onBehalfOfUserId!,
          entryFile: current.entryFile, baseHash: current.baseHash, localRoot: current.localRoot, executionRoot: current.executionRoot, location: current.location, state: "prepared", receipt }).returning();
        let handedOff = false;
        try { return await store.locked(input.companyId, input.agentId, bound, false, async (_tx, lockedAgent, canonical) => {
          // The reservation's earlier check is only a hint. Serialize this last
          // validation and ownership transfer with every canonical writer.
          if (current.entryFile !== deriveBundleState(lockedAgent).entryFile ||
              directorySnapshotSha256(checkpointSnapshot(await cachedAgentFileManifest(canonical))) !== current.baseHash) {
            throw new AgentDirectoryReuseInvalidatedError("Managed agent files changed before warm directory handoff");
          }
          // The controller-owned marker fences old callbacks. Attach the new
          // collector immediately after it moves, before fallible bookkeeping.
          const temporary = `${ownerFile(current)}.next`;
          await fs.writeFile(temporary, JSON.stringify({ runId: input.runId }));
          await fs.rename(temporary, ownerFile(current));
          handedOff = true;
          input.onWarmHandoff?.(successor!);
          const runtime = transports.get(key(current));
          if (runtime) transports.set(key(successor!), runtime);
          transports.delete(key(current));
          await patch(current, { state: "superseded", receipt: { schema: AGENT_FILES_CONTRACT, warm: true, successorRunId: input.runId } });
          return successor!;
        }); } catch (error) {
          // No process used this proposed owner. Remove it after the canonical
          // lock releases so the same run can restore a fresh directory.
          if (!handedOff) await db.delete(copies).where(and(eq(copies.companyId, input.companyId), eq(copies.runId, input.runId)));
          throw error;
        }
      }, "agent_directory_handoff");
    }
    let row = await get(input.companyId, input.runId);
    if (row?.receipt?.retainedByRunId) throw conflict("Agent directory ownership passed to another run");
    const origin = typeof row?.receipt?.materializationRunId === "string" ? row.receipt.materializationRunId : input.runId;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(origin)) throw conflict("Invalid agent directory owner");
    const localRoot = path.join(path.dirname(root), "file-sync", "runs", origin, "live");
    // Local copies live outside the task cwd. Remote copies use the reserved,
    // excluded runtime area inside the provider's confined workspace. They are
    // synchronized independently; provider HOME is never reinterpreted.
    const executionRoot = input.target?.kind === "remote"
      ? path.posix.join(input.target.remoteCwd, ".paperclip-runtime", "agent-files", input.agentId, origin)
      : localRoot;
    const location = input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local";
    if (row && (row.localRoot !== localRoot || row.executionRoot !== executionRoot || row.agentId !== input.agentId || row.location !== location)) throw conflict("Agent directory belongs to a different execution environment");
    if (row && !serialHeld) {
      // Restart preparation can replace a completed copy under the same run ID.
      // Join cleanup's lock before resetting its receipt or creating new bytes.
      // Interrupted admission may have registered the row before making this root.
      await fs.mkdir(path.resolve(localRoot, "../../.."), { recursive: true, mode: 0o700 });
      return serial(row, () => prepareCopy(input, true), "agent_directory_prepare");
    }
    if (row && !completed.has(row.state) && row.state !== "preparing") {
      if (input.target?.kind === "remote" && !transports.has(key(row))) transports.set(key(row), await transport(row, input.target, true));
      return row;
    }
    // Register ownership before creating any bytes, so a crash during the copy
    // leaves a recoverable preparing receipt instead of an orphan directory.
    const preparing = { entryFile: deriveBundleState(agent).entryFile, baseRevisionId: null, baseHash: "preparing",
      localRoot, executionRoot, location, state: "preparing", candidateBase64: null, candidateHash: null,
      receipt: { schema: AGENT_FILES_CONTRACT, workspaceCwd: input.cwd, materializationRunId: origin, ...(input.warm ? { warm: true, directoryRunId: input.runId } : {}), ...(input.target?.kind === "remote"
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
        const runtime = await transport(row, input.target, false);
        transports.set(key(row), runtime);
        if (input.target.transport === "sandbox") {
          if (runtime.runtimeRootDir !== sandboxTransferRoot(row, input.target.remoteCwd)) throw new Error("Agent directory transfer scratch path changed");
        }
      }
      const observed = await observe(row, input.target).catch(() => null);
      return await patch(row, { state: "prepared", receipt: { ...row.receipt,
        ...(observed?.digest === agentDirectoryBaselineDigest(snapshot) ? { materializationIdentity: observed.identity } : {}) } });
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
  async function hasChanges(row: Copy, target?: AdapterExecutionTarget | null) {
    if (persistent(row)) return false; // Bytes already live on the authoritative computer.
    try {
      if (row.receipt?.retainedByRunId || row.receipt?.retirementRequired || typeof row.receipt?.materializationIdentity !== "string") return true;
      const observed = await observe(row, target);
      if (observed.identity !== row.receipt.materializationIdentity || observed.digest !== agentDirectoryBaselineDigest(baseline(row))) return true;
      const unchanged = await patch(row, { state: "unchanged_turn", nextAttemptAt: null });
      return unchanged.state !== "unchanged_turn" || Boolean(unchanged.receipt?.retainedByRunId) || Boolean(unchanged.processStoppedAt);
    } catch { return true; }
  }
  /** Rebind one physical materialization; earlier runs lose collection authority. */
  async function adopt(input: { companyId: string; agentId: string; runId: string; previousRunId: string; target?: AdapterExecutionTarget | null; cwd: string; allowRetirementHandoff?: boolean }) {
    if (input.target?.kind === "remote" && input.target.transport === "computer" && input.target.fileAuthority?.kind === "remote-persistent") return prepareCopy({ ...input, warm: true });
    let prior = await get(input.companyId, input.previousRunId);
    if (!prior || prior.agentId !== input.agentId || prior.state !== "unchanged_turn" || prior.receipt?.retainedByRunId || prior.processStoppedAt
      || prior.receipt?.workspaceCwd !== input.cwd || prior.location !== (input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local")) return null;
    const oldRuntime = transports.get(key(prior));
    const remote = input.target?.kind === "remote" ? input.target : null;
    const priorCleanup = prior.receipt?.cleanup as { leaseId?: string; remoteCwd?: string } | undefined;
    const validLeases = (leases: Array<typeof environmentLeases.$inferSelect>) => {
      if (!remote) return true;
      const previous = leases.find(lease => lease.id === priorCleanup?.leaseId);
      const successor = leases.find(lease => lease.id === remote.leaseId);
      return Boolean(previous && successor && previous.id !== successor.id
        && previous.companyId === input.companyId && successor.companyId === input.companyId
        && previous.heartbeatRunId === input.previousRunId && successor.heartbeatRunId === input.runId
        && previous.environmentId === remote.environmentId && successor.environmentId === remote.environmentId
        && previous.provider && previous.provider === successor.provider
        && previous.providerLeaseId && previous.providerLeaseId === successor.providerLeaseId
        && successor.status === "active" && !successor.releasedAt
        && !hasRemoteTerminationReceipt(previous) && !hasRemoteTerminationReceipt(successor)
        && (remote.transport !== "sandbox" || remote.providerKey === successor.provider)
        && (successor.metadata?.remoteCwd === undefined || successor.metadata.remoteCwd === remote.remoteCwd));
    };
    const leaseIds = remote && priorCleanup?.leaseId && remote.leaseId ? [priorCleanup.leaseId, remote.leaseId] : [];
    if (remote && (!oldRuntime || oldRuntime.target.kind !== "remote" || oldRuntime.target.transport !== remote.transport
      || oldRuntime.target.leaseId !== priorCleanup?.leaseId || oldRuntime.target.remoteCwd !== remote.remoteCwd
      || priorCleanup?.remoteCwd !== remote.remoteCwd || leaseIds.length !== 2
      || !validLeases(await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId), inArray(environmentLeases.id, leaseIds)))))) return null;
    const bound = await resolveInstructionActor(db, { type: "agent", companyId: input.companyId, agentId: input.agentId, runId: input.runId });
    const observedChange = await hasChanges(prior, input.target);
    if (observedChange && !input.allowRetirementHandoff) return null;
    prior = (await get(input.companyId, input.previousRunId))!;
    // adopt_remote constructs a collector on the successor target without
    // uploading the stale host mirror over the retained remote directory.
    const replacement = remote ? await transport({ ...prior, runId: input.runId }, remote, true) : undefined;
    let adopted: Copy | null;
    try { adopted = await store.locked(input.companyId, input.agentId, bound, false, async (tx, _agent, canonical) => {
      if (remote && !validLeases(await tx.select().from(environmentLeases).where(and(
        eq(environmentLeases.companyId, input.companyId), inArray(environmentLeases.id, leaseIds))).for("update"))) return null;
      const current = await inspectAgentDirectory(canonical);
      const canonicalChanged = agentDirectoryBaselineDigest(current.snapshot) !== agentDirectoryBaselineDigest(baseline(prior));
      if (canonicalChanged && !input.allowRetirementHandoff) return null;
      const [claimed] = await tx.update(copies).set({ receipt: { ...prior.receipt, retainedByRunId: input.runId }, updatedAt: new Date() })
        .where(and(eq(copies.companyId, input.companyId), eq(copies.runId, prior.runId), eq(copies.agentId, input.agentId), eq(copies.state, "unchanged_turn"),
          eq(copies.updatedAt, prior.updatedAt), eq(copies.baseHash, prior.baseHash), eq(copies.localRoot, prior.localRoot),
          isNull(copies.processStoppedAt), sql`${copies.receipt}->>'retainedByRunId' IS NULL`)).returning();
      if (!claimed) throw conflict("Agent directory ownership changed");
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...values } = prior;
      const [next] = await tx.insert(copies).values({ ...values, runId: input.runId, responsibleUserId: bound.onBehalfOfUserId!, state: "prepared",
        receipt: { ...prior.receipt, materializationRunId: prior.receipt?.materializationRunId ?? prior.runId,
          ...(remote ? { cleanup: { leaseId: remote.leaseId, remoteCwd: remote.remoteCwd } } : {}),
          ...(observedChange || canonicalChanged ? { retirementRequired: true } : {}) }, updatedAt: new Date(),
      }).returning();
      return next;
    }); } catch (error) { await replacement?.cleanupWorkspaceSnapshot?.(); throw error; }
    // Do not move the live transport until the database ownership commit succeeds.
    if (adopted) {
      if (replacement && oldRuntime) {
        const cleanup = replacement.cleanupWorkspaceSnapshot;
        replacement.cleanupWorkspaceSnapshot = async () => {
          try { await cleanup?.(); } finally { await oldRuntime.cleanupWorkspaceSnapshot?.(); }
        };
        transports.delete(key(prior)); transports.set(key(adopted), replacement);
      }
    } else await replacement?.cleanupWorkspaceSnapshot?.();
    return adopted;
  }
  async function checkpoint(row: Copy, target?: AdapterExecutionTarget | null, stopped = false): Promise<Copy> {
    if (persistent(row)) return patch(row, { state: stopped ? "unchanged" : "warm_saved", nextAttemptAt: null,
      ...(stopped ? { processStoppedAt: new Date() } : {}) });
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
        if (error instanceof HttpError && error.status < 500) break;
      }
      finally {
        await captured?.cleanup().catch(error => logger.warn({ err: error, runId: row.runId }, "Agent checkpoint scratch cleanup deferred to session retirement"));
      }
    }
    const rejection = failure instanceof HttpError && failure.status === 403 ? failure.message : null;
    if (!stopped) return patch(row, { errorCode: "AGENT_FILES_CHECKPOINT_UNSTABLE",
      errorMessage: rejection ? `Agent-file save rejected: ${rejection} Changes were not saved.` : "Incremental checkpoint could not be validated; collecting after provider stop.", nextAttemptAt: null });
    const storageLimit = failure instanceof AgentFileLimitError || String(failure).includes("LIMIT_EXCEEDED");
    return patch(row, { state: "unavailable", processStoppedAt: new Date(), errorCode: storageLimit ? "AGENT_FILES_LIMIT_EXCEEDED" : "AGENT_FILES_SAVE_FAILED",
      errorMessage: rejection ? `Agent-file save rejected: ${rejection} Changes were not saved.` : "Agent-file synchronization failed after provider stop. No successful save is claimed.", nextAttemptAt: null,
      receipt: { ...row.receipt, storageWarning: storageLimit ? agentStorageWarning(failure instanceof AgentFileLimitError ? failure.message : "Agent folder exceeds a storage limit") : null } });
  }
  async function collectStopped(row: Copy, target?: AdapterExecutionTarget | null) {
    if (persistent(row)) {
      const settled = await patch(row, { state: "unchanged", processStoppedAt: new Date(), nextAttemptAt: null });
      await release(settled);
      return settled;
    }
    if (row.receipt?.retainedByRunId) return row;
    if (!await owns(row) || row.state === "superseded") return row;
    if (row.receipt?.warm === true && !completed.has(row.state)) {
      row = await checkpoint(row, target, true);
      await release(row, target);
      return (await get(row.companyId, row.runId))!;
    }
    if (completed.has(row.state)) { await release(row); return (await get(row.companyId, row.runId))!; }
    const remoteLease = row.location !== "local" ? await ownedRemoteLease(row) : null;
    if (row.location !== "local" && (!remoteLease
      || remoteLease.releasedAt || remoteLease.status !== "active" || hasRemoteTerminationReceipt(remoteLease))) {
      return recoverStoppedRemote(row);
    }
    row = await patch(row, { processStoppedAt: row.processStoppedAt ?? new Date() });
    // Adoption may win between the initial read and the stop CAS. The returned
    // current row is authoritative; a transferred alias cannot inspect or save.
    if (row.receipt?.retainedByRunId || !row.processStoppedAt) return row;
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
          errorMessage: error instanceof HttpError && (error.status === 403 || error.status === 422)
            ? `${error.message}. This run's agent-folder changes were not saved; the temporary copy is discarded.`
            : "Agent-file synchronization failed. No successful save is claimed; the temporary copy is discarded.",
        });
        break;
      }
    }
    await release(row);
    return (await get(row.companyId, row.runId))!;
  }
  function releaseIsNoop(row: Copy) {
    return row.state === "superseded" || !row.processStoppedAt ||
      completed.has(row.state) && row.receipt?.cleanupPending === false;
  }
  async function release(row: Copy, target?: AdapterExecutionTarget | null) {
    if (persistent(row)) {
      // No remote command, snapshot, or directory deletion is legal here.
      if (row.processStoppedAt) await fs.rm(path.dirname(row.localRoot), { recursive: true, force: true });
      return;
    }
    if (releaseIsNoop(row) || !await owns(row)) return;
    const destroyedOnly = row.receipt?.cleanupDestroyedOnly === true;
    if (row.receipt?.retainedByRunId || row.state === "superseded" || !await owns(row) || !row.processStoppedAt) return;
    // Collection and environment teardown can both release the same copy.
    // A compact successful cleanup receipt is final, even after restart.
    if (completed.has(row.state) && row.processStoppedAt && row.receipt?.cleanupPending === false) return;
    const runtime = transports.get(key(row));
    transports.delete(key(row));
    let cleanupPending = false;
    await runtime?.cleanupWorkspaceSnapshot?.().catch(() => { cleanupPending = true; });
    const cleanupTarget = target ?? runtime?.target;
    const lease = row.location !== "local" ? await ownedRemoteLease(row) : null;
    const terminated = lease && hasRemoteTerminationReceipt(lease);
    const destroyed = destroyedOnly || terminated && (lease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "destroyed";
    const cleanupLeaseId = (row.receipt?.cleanup as { leaseId?: string } | undefined)?.leaseId;
    // Maintenance may run while the collector is still cached. A cached target
    // cannot override the current lease's stopped/destroyed/uncertain state.
    const remoteUnavailable = row.location !== "local" && !destroyed && (!lease || terminated
      || Boolean(lease && (lease.releasedAt || lease.status !== "active"))
      || Boolean(cleanupLeaseId && (!lease || cleanupTarget?.kind === "remote" && cleanupTarget.leaseId !== lease.id)));
    if (remoteUnavailable) cleanupPending = true;
    else if (!destroyed && row.processStoppedAt && completed.has(row.state) && cleanupTarget?.kind === "remote") {
      const expected = path.posix.join(cleanupTarget.remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, typeof row.receipt?.materializationRunId === "string" ? row.receipt.materializationRunId : String(row.receipt?.directoryRunId ?? row.runId));
      if (row.executionRoot !== expected) throw new Error("Agent directory cleanup path changed");
      const paths = cleanupTarget.transport === "sandbox" ? [expected, sandboxTransferRoot(row, cleanupTarget.remoteCwd)] : [expected];
      const quoted = paths.map(p => `'${p.replaceAll("'", `'"'"'`)}'`).join(" ");
      const remoteCleanupFailed = await runAdapterExecutionTargetShellCommand(row.runId, cleanupTarget, `rm -rf -- ${quoted}`,
        { cwd: cleanupTarget.remoteCwd, env: {}, timeoutSec: 15 }).then(result => result.exitCode !== 0 || result.timedOut, () => true);
      cleanupPending ||= remoteCleanupFailed;
    } else if (!destroyed && row.processStoppedAt && completed.has(row.state) && row.location !== "local") {
      // Rebind only the current host-owned lease. Never acquire a replacement.
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
        materializationRunId: row.receipt?.materializationRunId ?? row.runId,
        ...(row.receipt?.directoryRunId ? { directoryRunId: row.receipt.directoryRunId } : {}),
        ...(cleanupPending ? { cleanup: row.receipt?.cleanup, ...(destroyedOnly ? { cleanupDestroyedOnly: true } : {}) } : {}) },
        nextAttemptAt: cleanupPending ? new Date(Date.now() + 30_000) : null });
    }
  }
  async function destroyedRemoteCopy(row: Copy): Promise<boolean> {
    const cleanup = row.receipt?.cleanup as { leaseId?: string; remoteCwd?: string } | undefined;
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, row.companyId), eq(environmentLeases.heartbeatRunId, row.runId),
      cleanup?.leaseId ? eq(environmentLeases.id, cleanup.leaseId)
        : eq(environmentLeases.environmentId, row.location.slice("remote:".length)),
    ));
    if (leases.length !== 1) return false;
    const lease = leases[0]!;
    if (lease.environmentId !== null && row.location !== `remote:${lease.environmentId}`) return false;
    const remoteCwd = cleanup?.remoteCwd ?? lease.metadata?.remoteCwd;
    return typeof remoteCwd === "string" &&
      row.executionRoot === path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, String(row.receipt?.materializationRunId ?? row.receipt?.directoryRunId ?? row.runId)) &&
      hasRemoteTerminationReceipt(lease) && (lease.metadata?.remoteExecutionTermination as { state?: string }).state === "destroyed";
  }
  async function recoverUnavailable(row: Copy) {
    const eligible = (current: Copy) => isAgentDirectoryCopy(current) && current.location.startsWith("remote:") &&
      current.state === "unavailable" && !current.processStoppedAt;
    // Do not wait for a directory lock when no cleanup can be authorized.
    if (!eligible(row) || !await destroyedRemoteCopy(row)) return;
    await serial(row, async current => {
      if (!eligible(current) || !await destroyedRemoteCopy(current)) return;
      // The no-execute authority must survive a crash after this update. Every
      // later release, including one with a cached transport, honors it.
      const confirmed = await patch(current, { processStoppedAt: new Date(),
        receipt: { ...current.receipt, cleanupDestroyedOnly: true } });
      // A concurrent preparation can win the receipt CAS. Its bytes stay live.
      if (confirmed.state === "unavailable" && confirmed.processStoppedAt) await release(confirmed);
    }, "agent_directory_release");
  }
  async function ownedRemoteLease(row: Copy) {
    const cleanup = row.receipt?.cleanup as { leaseId?: string } | undefined;
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, row.companyId), eq(environmentLeases.heartbeatRunId, row.runId),
      cleanup?.leaseId ? eq(environmentLeases.id, cleanup.leaseId) : eq(environmentLeases.environmentId, row.location.slice("remote:".length)),
    ));
    if (leases.length !== 1) return null;
    const lease = leases[0]!;
    const destroyedWithoutEnvironment = lease.environmentId === null && hasRemoteTerminationReceipt(lease)
      && (lease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "destroyed";
    if (row.location !== `remote:${lease.environmentId}` && !destroyedWithoutEnvironment) return null;
    return lease;
  }
  async function recoverStoppedRemote(row: Copy) {
    if (persistent(row)) return patch(row, { state: "unchanged", processStoppedAt: row.processStoppedAt ?? new Date(), nextAttemptAt: null });
    const lease = await ownedRemoteLease(row);
    const destroyed = lease && hasRemoteTerminationReceipt(lease)
      && (lease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "destroyed";
    if (!destroyed) {
      // execute (including bypassSession) may restart a stopped sandbox. Keep
      // the only remaining bytes; a stop receipt is not a destruction receipt.
      return patch(row, { state: "pending_collection", errorCode: lease ? "INSTRUCTION_STOPPED_REMOTE_COLLECTION_PENDING" : "INSTRUCTION_REMOTE_LEASE_UNVERIFIED",
        errorMessage: lease ? "The remote provider stopped with its agent directory retained. Safe stopped-file retrieval is unavailable; no save or discard is claimed."
          : "The current remote lease could not be verified. Its agent directory is preserved; no retrieval, save or discard is claimed.", nextAttemptAt: new Date(Date.now() + 30_000) });
    }
    row = await patch(row, { state: "unavailable", processStoppedAt: row.processStoppedAt ?? new Date(),
      errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE", errorMessage: "The exact remote sandbox was destroyed before its agent directory was retrieved. No instruction save is claimed.", nextAttemptAt: null });
    await release(row);
    return (await get(row.companyId, row.runId))!;
  }
  async function cleanupRemoteAfterRestart(row: Copy): Promise<boolean> {
    const cleanup = row.receipt?.cleanup as { leaseId?: string; remoteCwd?: string } | undefined;
    const lease = await ownedRemoteLease(row);
    if (!lease) return false;
    const termination = lease.metadata?.remoteExecutionTermination as { state?: string } | undefined;
    if (hasRemoteTerminationReceipt(lease)) return termination?.state === "destroyed";
    // Never execute a cleanup command against a released/uncertain allocation.
    if (lease.releasedAt || lease.status !== "active") return false;
    if (!environmentRuntime || !lease.environmentId || row.location !== `remote:${lease.environmentId}`) return false;
    const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId));
    if (!environment) return false;
    const remoteCwd = cleanup?.remoteCwd ?? lease.metadata?.remoteCwd;
    if (typeof remoteCwd !== "string" || row.executionRoot !== path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, typeof row.receipt?.materializationRunId === "string" ? row.receipt.materializationRunId : String(row.receipt?.directoryRunId ?? row.runId))) return false;
    const paths = environment.driver === "sandbox" ? [row.executionRoot, sandboxTransferRoot(row, remoteCwd)] : [row.executionRoot];
    const result = await environmentRuntime.execute({ environment: environment as Environment, lease: lease as EnvironmentLease, command: "rm", args: ["-rf", "--", ...paths],
      cwd: remoteCwd, env: {}, timeoutMs: 15_000, bypassSession: true });
    return result.exitCode === 0 && !result.timedOut;
  }
  async function serial<T>(row: Copy, fn: (current: Copy) => Promise<T>, operation: DirectoryMergeLockOperation): Promise<T> {
    // Duplicate stop callbacks and restart recovery must not race while moving
    // the stopped working copy. This lock is outside the writable tree.
    return withDirectoryMergeLock(path.resolve(row.localRoot, "../../.."), async () => {
      const current = await get(row.companyId, row.runId);
      if (!current) throw notFound("Agent directory copy not found");
      return fn(current);
    }, process.env, operation);
  }
  return { prepare: (input: Parameters<typeof prepareCopy>[0]) => prepareCopy(input), hasChanges, adopt, canReuse, recoverUnavailable,
    recoverStoppedRemote: (row: Copy) => serial(row, current => current.receipt?.retainedByRunId ? Promise.resolve(current) : recoverStoppedRemote(current), "agent_directory_collect"),
    checkpointWarm: (row: Copy, target?: AdapterExecutionTarget | null) => serial(row, current => current.receipt?.warm === true ? checkpoint(current, target) : Promise.resolve(current), "agent_directory_checkpoint"),
    collectStopped: (row: Copy, target?: AdapterExecutionTarget | null) => serial(row, current => collectStopped(current, target), "agent_directory_collect"),
    release: async (row: Copy) => {
      const current = await get(row.companyId, row.runId);
      // This check changes no receipt or bytes. A concurrent stop merely leaves
      // cleanup to its owner or the recovery sweep; it grants no new authority.
      if (!current || (!persistent(current) && releaseIsNoop(current))) return;
      await serial(current, release, "agent_directory_release");
    },
  };
}
