import { notifyStrandedAgentStatus } from "./live-run-recovery-notifications.js";
import { notifyInstructionCollection, type InstructionCollectionScope } from "./instruction-collection-notifications.js";
import { notifyDirectoryCleanup, type DirectoryCleanupScope } from "./directory-cleanup-notifications.js";
import { notifyInstructionCommit, type InstructionCommitScope } from "./instruction-commit-notifications.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import { agentDirectoryWorkingCopyService, isAgentDirectoryCopy } from "./agent-directory-working-copies.js";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, not, notInArray, lte, or, isNull, isNotNull, sql, type SQL } from "drizzle-orm";
import { agents, heartbeatRuns, agentInstructionWorkingCopies as copies, databaseWorkScopeKey, type Db } from "@paperclipai/db";
import {
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { conflict, notFound } from "../errors.js";
import { agentInstructionsService, agentInstructionsBundleMode } from "./agent-instructions.js";
import { agentInstructionRevisionService } from "./agent-instruction-revisions.js";
import { resolveInstructionActor } from "./agent-instruction-authorization.js";
import { assertInstructionPathSafe, instructionBytes, instructionPath, materializeInstructionBytes, MAX_INSTRUCTION_BYTES, readInstructionBytes, instructionGitExcludeProgram } from "./agent-instruction-files.js";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { remoteExecutionHasStopped } from "./remote-execution-termination.js";
import type { AuthorizationActor } from "./authorization.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { logger } from "../middleware/logger.js";

const execFile = promisify(execFileCallback);
type Copy = typeof copies.$inferSelect;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const completed = new Set(["saved", "unchanged", "resolved"]);
const MAX_COLLECTION_ATTEMPTS = 3;
// Only orchestration can register a live target; tools and HTTP callers cannot
// supply one. These handles are optional: durable captured bytes survive restart.
const liveTargets = new Map<string, AdapterExecutionTarget>();
const targetKey = (companyId: string, runId: string) => `${companyId}:${runId}`;
const copySaves = new WeakMap<object, Map<string, Promise<void>>>();

/** A terminal run does not establish that its private local edits were saved.
 * Enrollment may discard these paths only after this owner's save/resolution
 * or explicit ownership transfer. A rejected directory save is settled only
 * after this owner confirms both process stop and completed no-save cleanup. */
export async function hasUnsettledLocalInstructionCopies(db: Db): Promise<boolean> {
  return (await db.select({ runId: copies.runId }).from(copies).where(and(
    eq(copies.location, "local"), notInArray(copies.state, ["saved", "unchanged", "resolved", "superseded"]),
    not(and(eq(copies.state, "unavailable"), isNotNull(copies.processStoppedAt),
      sql`coalesce(${copies.receipt}->>'schema', '') = 'paperclip.agent-files.v1'`,
      sql`coalesce(${copies.receipt}->>'cleanupPending', '') = 'false'`)!),
  )).limit(1)).length > 0;
}

function serializeCopySave<T>(db: Db, companyId: string, runId: string, save: () => Promise<T>): Promise<T> {
  const scope = databaseWorkScopeKey(db);
  let active = copySaves.get(scope);
  if (!active) copySaves.set(scope, active = new Map());
  const key = targetKey(companyId, runId);


  const operation = (active.get(key) ?? Promise.resolve()).then(save);
  const settled = operation.then(() => undefined, () => undefined);
  active.set(key, settled);
  return operation.finally(() => {
    if (active.get(key) === settled) active.delete(key);
  });
}


/** Finish only bounded immediate collection work; deferred ownership remains pending. */
export async function collectStoppedInstructionCopyWithRetries<T extends Pick<Copy, "state" | "attempts" | "nextAttemptAt">>(collect: () => Promise<T | null>): Promise<T | null> {
  let saved: T | null = null;
  let previousAttempts = -1;
  for (let calls = 0; calls < MAX_COLLECTION_ATTEMPTS; calls++) {
    saved = await collect();
    if (!saved || saved.state !== "pending_collection" || saved.nextAttemptAt === null
      || saved.attempts >= MAX_COLLECTION_ATTEMPTS || saved.attempts <= previousAttempts) break;
    previousAttempts = saved.attempts;
  }
  return saved;
}

export function instructionWorkingCopyGuidance(copy: Pick<Copy, "executionRoot" | "entryFile" | "receipt">) {
  if (isAgentDirectoryCopy(copy)) return `Your persistent agent directory is ${copy.executionRoot} (AGENT_HOME). Your instruction entry is ${copy.executionRoot}/${copy.entryFile}. Read and write your own files and subfolders there. This directory belongs to this agent across tasks and sessions; task files belong in the task working directory. Paperclip restores this directory before execution and saves validated changes at turn boundaries. A warm native Codex session keeps the same writable directory between turns. Other sessions collect after the provider stops. Regular files, including binary files, persist; symlinks and special files are unsupported. Check the agent-files save receipt before claiming persistence; Only files you change or delete are synchronized. If another run changes the same file, the last completed synchronization wins. Temporary copies are removed when the owning session stops; there is no per-run file history. Storage allows 256 MiB per file, 2 GiB total, and 100,000 entries; the instruction entry must remain UTF-8 and at most 1 MiB. Reaching a storage limit never prevents this or future tasks from running. Remove or shrink files to free space; changes that exceed the limits will not be saved.${typeof copy.receipt?.storageWarning === "string" ? `\n\n${copy.receipt.storageWarning}` : ""}`;
  return `Your editable agent instruction file is ${copy.executionRoot}/${copy.entryFile}. Edit this registered private copy normally. After this run stops, Paperclip saves changed content as a persistent revision if your responsible user still has permission and the baseline has not changed. Check the run's instruction-save receipt before claiming persistence. Use read_agent_instructions, update_agent_instructions, get_agent_instruction_history, and restore_agent_instructions for immediate saves and history. Read first and pin the returned revision. Preserve conflicts; never silently retry against a newer head. Repository instructions, skills, and the loaded prompt are separate and are not collected.`;
}

/** Remote reads use the registered entry only; never scan for files called AGENTS.md. */
export function instructionCollectionScript(root: string, entry: string) {
  instructionPath(entry);
  return `node -e ${quote([
    "const fs=require('node:fs'),path=require('node:path')",
    "const root=process.argv[1],entry=process.argv[2],max=Number(process.argv[3])",
    "const absolute=path.resolve(root,entry),parts=absolute.split('/').filter(Boolean)",
    "let current='/'",
    "for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);let s;try{s=fs.lstatSync(current)}catch(e){if(e.code==='ENOENT'){process.stdout.write(JSON.stringify({missing:true}));process.exit(0)}throw e}if(s.isSymbolicLink()||(i<parts.length-1?!s.isDirectory():!s.isFile()))throw Error('INSTRUCTION_PATH_INVALID')}",
    "const fd=fs.openSync(absolute,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)",
    "try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>max)throw Error('INSTRUCTION_CONTENT_INVALID');const bytes=Buffer.alloc(max+1);let n=0;while(n<bytes.length){const count=fs.readSync(fd,bytes,n,bytes.length-n,n);if(!count)break;n+=count}if(n>max)throw Error('INSTRUCTION_CONTENT_INVALID');process.stdout.write(JSON.stringify({contentBase64:bytes.subarray(0,n).toString('base64')}))}finally{fs.closeSync(fd)}",
  ].join(";"))} ${quote(root)} ${quote(entry)} ${MAX_INSTRUCTION_BYTES}`;
}


export function agentInstructionWorkingCopyService(db: Db, options: { environmentRuntime?: EnvironmentRuntimeService } = {}) {
  const revisions = agentInstructionRevisionService(db);
  const scope = (companyId: string, runId: string) => and(eq(copies.companyId, companyId), eq(copies.runId, runId));
  async function get(companyId: string, runId: string) {
    const [row] = await db.select().from(copies).where(scope(companyId, runId));
    return row ?? null;
  }
  async function tryPatch(row: Copy, values: Partial<typeof copies.$inferInsert>, requireDue = false, condition?: SQL) {
    const signalsCollection = collectionCandidate(row) || collectionCandidate({ ...row, ...values });
    const signalsCleanup = directoryCleanupEntry(row) !== null || directoryCleanupEntry({ ...row, ...values }) !== null;
    const signalsCommit = row.state === "pending_commit" || values.state === "pending_commit";
    const write = async (tx: Db) => {
      await notifyStrandedAgentStatus(tx, { companyId: row.companyId, agentId: row.agentId });
      if (signalsCommit)
        await notifyInstructionCommit(tx, { companyId: row.companyId, runId: row.runId });
      if (signalsCleanup) await notifyDirectoryCleanup(tx, { companyId: row.companyId, runId: row.runId });
      if (signalsCollection) await notifyInstructionCollection(tx, { companyId: row.companyId, runId: row.runId });
      const [updated] = await tx.update(copies).set({ ...values, updatedAt: new Date() }).where(and(
        scope(row.companyId, row.runId), eq(copies.state, row.state), eq(copies.attempts, row.attempts), eq(copies.baseHash, row.baseHash), eq(copies.localRoot, row.localRoot),
        sql`${copies.receipt}->>'retainedByRunId' IS NOT DISTINCT FROM ${typeof row.receipt?.retainedByRunId === "string" ? row.receipt.retainedByRunId : null}`,
        requireDue ? or(isNull(copies.nextAttemptAt), lte(copies.nextAttemptAt, new Date())) : undefined, condition,
      )).returning();
      return updated;
    };
    return db.transaction(tx => write(tx as unknown as Db));
  }
  async function patch(row: Copy, values: Partial<typeof copies.$inferInsert>) {
    const updated = await tryPatch(row, values);
    // A late cleanup must not overwrite an explicit resolution or a newer
    // baseline. Canonical content has its own independent head CAS.
    return updated ?? (await get(row.companyId, row.runId))!;
  }
  function actorFor(row: Copy): AuthorizationActor {
    return { type: "agent", companyId: row.companyId, agentId: row.agentId, runId: row.runId, onBehalfOfUserId: row.responsibleUserId };
  }
  const directories = agentDirectoryWorkingCopyService(db, get, patch, options.environmentRuntime);
  async function recoverDirectoryCleanup(row: Copy, cleanup: () => Promise<unknown>) {
    // Reserve a later retry before I/O, including lock waits. A blocked owner
    // must not occupy every sweep or prevent other copies from being reclaimed.
    try {
      await patch(row, { nextAttemptAt: new Date(Date.now() + 30_000) });
      await cleanup();
    }
    catch (error) {
      try { await patch(row, { nextAttemptAt: new Date(Date.now() + 30_000) }); }
      catch (retryError) {
        logger.warn({ err: retryError, runId: row.runId }, "Agent file cleanup retry could not be scheduled");
      }
      logger.warn({ err: error, runId: row.runId }, "Agent file cleanup deferred; save receipt unchanged");
    }
  }
  async function prepare(input: { companyId: string; agentId: string; runId: string; target?: AdapterExecutionTarget | null; cwd: string; legacy?: boolean; warm?: boolean; reuseRunId?: string; onWarmHandoff?: (copy: Copy) => void }) {
    const existing = await get(input.companyId, input.runId);
    if (isAgentDirectoryCopy(existing) || (!existing && !input.legacy)) return directories.prepare(input);
    let refreshStoppedCopy = false;
    const workspace = await fs.realpath(input.cwd);
    const expectedLocalRoot = path.join(workspace, ".paperclip-runtime", `instruction-edits-${input.runId}`, "instructions");
    if (existing && existing.localRoot !== expectedLocalRoot) throw conflict("The registered instruction copy belongs to a different run workspace");
    const location = input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local";
    if (existing && (existing.agentId !== input.agentId || existing.location !== location)) {
      throw conflict("The registered instruction copy belongs to a different run environment");
    }
    // Preserve in-flight bytes and their CAS baseline. A completed, stopped copy
    // can start a fresh lifecycle only after its recorded bytes are accounted for.
    if (existing && existing.state !== "preparing") {
      if (["conflict", "pending_commit", "unavailable"].includes(existing.state)) {
        throw conflict("Resolve this run's preserved instruction candidate before editing its working copy again");
      }
      if (input.target) liveTargets.set(targetKey(input.companyId, input.runId), input.target);
      if (completed.has(existing.state) && existing.processStoppedAt) {
        const privateBytes = await readCandidate(existing, input.target);
        // Refresh only bytes whose previous lifecycle is complete. A changed
        // private file must keep its old CAS fence; never silently rebase edits.
        refreshStoppedCopy = privateBytes === null || hash(privateBytes) === (existing.candidateHash ?? existing.baseHash);
        if (!refreshStoppedCopy && privateBytes !== null) {
          // A failed staging attempt can already have replaced the file before
          // the completed row advances. Exact current canonical bytes are also
          // accounted for; any other private edit still keeps its old fence.
          const current = await revisions.readCommittedForRuntime({ companyId: input.companyId, agentId: input.agentId });
          refreshStoppedCopy = current?.revision.entryFile === existing.entryFile
            && current.revision.contentHash === hash(privateBytes);
        }
      }
      if (!refreshStoppedCopy) {
        if (completed.has(existing.state) || existing.state === "unchanged_turn") {
          // unchanged_turn is a live warm-owner observation, not stop proof.
          return patch(existing, { state: "prepared", candidateBase64: null, candidateHash: null,
            receipt: null, processStoppedAt: null, attempts: 0, nextAttemptAt: null });
        }
        return existing;
      }
    }
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    if (!agent) throw notFound("Agent not found");
    if (agentInstructionsBundleMode(agent) !== "managed") return null;
    const bound = await resolveInstructionActor(db, { type: "agent", companyId: input.companyId, agentId: input.agentId, runId: input.runId });
    const baseline = existing?.baseRevisionId && !refreshStoppedCopy
      ? await revisions.readRevision({ companyId: input.companyId, agentId: input.agentId, entryFile: existing.entryFile, revisionId: existing.baseRevisionId }, bound).catch(async (error) => {
          if ((error as { status?: number }).status !== 404) throw error;
          const current = await revisions.readCurrent({ companyId: input.companyId, agentId: input.agentId }, bound);
          if (current?.revision.id !== existing.baseRevisionId) throw conflict("The instruction baseline changed during preparation");
          return current;
        })
      : await revisions.readCurrent({ companyId: input.companyId, agentId: input.agentId }, bound);
    if (!baseline) return null;
    const exported = await agentInstructionsService(db).exportFiles(agent, { rejectSymlinks: true });
    const entryFile = instructionPath(baseline?.revision.entryFile ?? exported.entryFile);
    const content = instructionBytes(baseline?.content ?? exported.files[entryFile] ?? "");
    const localRoot = existing?.localRoot ?? expectedLocalRoot;
    const target = input.target?.kind === "remote" ? input.target : null;
    const executionRoot = target
      ? path.posix.join(target.remoteCwd, ".paperclip-runtime", `instruction-edits-${input.runId}`, "instructions")
      : localRoot;
    if (!existing) {
      await db.transaction(async tx => {
        await notifyInstructionCollection(tx, { companyId: input.companyId, runId: input.runId });
        await notifyStrandedAgentStatus(tx, { companyId: input.companyId, agentId: input.agentId });
      await tx.insert(copies).values({
        runId: input.runId, companyId: input.companyId, agentId: input.agentId,
        responsibleUserId: bound.onBehalfOfUserId!, entryFile,
        baseRevisionId: baseline?.revision.id ?? null, baseHash: hash(content),
        localRoot, executionRoot, location, state: "preparing",
      });
      });
    }
    const row = (await get(input.companyId, input.runId))!;
    await assertInstructionPathSafe(localRoot, entryFile);
    await execFile(process.execPath, ["-e", instructionGitExcludeProgram, workspace], { timeout: 15_000 });
    await fs.mkdir(localRoot, { recursive: true, mode: 0o700 });
    for (const [name, text] of Object.entries({ ...exported.files, [entryFile]: content.toString("utf8") })) {
      const relative = instructionPath(name);
      const filename = await assertInstructionPathSafe(localRoot, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      // Atomic replacement also allows interrupted preparation to restage an
      // already-read-only sibling without writing through its existing inode.
      await materializeInstructionBytes(localRoot, relative, instructionBytes(text));
      await fs.chmod(filename, name === entryFile ? 0o600 : 0o400);
    }
    if (target) {
      const staged = await prepareAdapterExecutionTargetRuntime({
        target, runId: input.runId, adapterKey: `instruction-edits-${input.runId}`,
        workspaceLocalDir: input.cwd, syncWorkspace: false,
        assets: [{ key: "instructions", localDir: localRoot, followSymlinks: false }],
      });
      if (staged.assetDirs.instructions !== executionRoot) throw new Error("Instruction copy staging path changed");
      const excluded = await runAdapterExecutionTargetShellCommand(input.runId, target,
        `node -e ${quote(instructionGitExcludeProgram)} ${quote(target.remoteCwd)}`, { cwd: target.remoteCwd, env: {}, timeoutSec: 15 });
      if (excluded.exitCode !== 0 || excluded.timedOut) throw new Error("Could not exclude private instructions from Git staging");
    }
    // A refresh does not supersede the completed turn until every local and
    // remote staging step succeeds. Keep its receipt and stop evidence intact
    // if preparation throws or the controller stops midway through staging.
    const prepared = await patch(row, { state: "prepared", ...(refreshStoppedCopy ? {
      entryFile, baseRevisionId: baseline.revision.id, baseHash: hash(content),
      candidateBase64: null, candidateHash: null, receipt: null, processStoppedAt: null,
      attempts: 0, nextAttemptAt: null, errorCode: null, errorMessage: null,
    } : {}) });
    if (input.target) liveTargets.set(targetKey(input.companyId, input.runId), input.target);
    return prepared;
  }

  async function readCandidate(row: Copy, target?: AdapterExecutionTarget | null) {
    if (row.location === "local") return readInstructionBytes(row.localRoot, row.entryFile);
    if (target?.kind !== "remote") throw new Error("The original execution environment is needed to retrieve this instruction copy");
    if (row.location !== `remote:${target.environmentId ?? ""}`) throw new Error("Instruction copy execution environment changed");
    const expected = path.posix.join(target.remoteCwd, ".paperclip-runtime", `instruction-edits-${row.runId}`, "instructions");
    if (expected !== row.executionRoot) throw new Error("Instruction copy execution environment changed");
    const result = await runAdapterExecutionTargetShellCommand(row.runId, target, instructionCollectionScript(row.executionRoot, row.entryFile), { cwd: target.remoteCwd, env: {}, timeoutSec: 30 });
    if (result.exitCode !== 0 || result.timedOut) throw new Error("Could not safely retrieve the stopped run's instruction file");
    const payload = JSON.parse(result.stdout) as { missing?: boolean; contentBase64?: string };
    if (payload.missing) return null;
    if (typeof payload.contentBase64 !== "string" || payload.contentBase64.length > Math.ceil(MAX_INSTRUCTION_BYTES / 3) * 4) throw new Error("Instruction response exceeds the collection bound");
    return instructionBytes(Buffer.from(payload.contentBase64, "base64"));
  }

  /** A terminal-turn probe is not a save: changed/invalid copies require a
   * stopped provider before capture. Unchanged warm providers remain reusable. */
  async function hasChanges(input: { companyId: string; runId: string; target?: AdapterExecutionTarget | null }) {
    const row = await get(input.companyId, input.runId);
    if (!row || completed.has(row.state)) return false;
    if (isAgentDirectoryCopy(row)) return directories.hasChanges(row, input.target);
    try {
      const content = await readCandidate(row, input.target);
      if (content !== null && hash(content) === row.baseHash) {
        // This is an unchanged turn receipt, not stopped-process collection.
        // No candidate bytes or new revision are persisted from a live owner.
        await patch(row, { state: "unchanged_turn", nextAttemptAt: null });
        return false;
      }
      return true;
    } catch { return true; }
  }
  async function checkpointWarm(input: { companyId: string; runId: string; target?: AdapterExecutionTarget | null }) {
    const row = await get(input.companyId, input.runId);
    return row && isAgentDirectoryCopy(row) ? directories.checkpointWarm(row, input.target) : row;
  }

  async function acknowledgeExplicitSave(input: { companyId: string; agentId: string; runId: string; entryFile: string; revisionId: string; contentHash: string }) {
    const row = await get(input.companyId, input.runId);
    if (!row || isAgentDirectoryCopy(row) || row.agentId !== input.agentId || row.entryFile !== input.entryFile || row.state !== "prepared") return;
    const target = liveTargets.get(targetKey(row.companyId, row.runId));
    const content = await readCandidate(row, target).catch(() => null);
    // Never advance a stale local edit past an unrelated explicit update.
    if (content === null || hash(content) !== input.contentHash) return;
    await db.update(copies).set({ baseRevisionId: input.revisionId, baseHash: input.contentHash, updatedAt: new Date() })
      .where(and(scope(row.companyId, row.runId), eq(copies.state, "prepared"), eq(copies.baseHash, row.baseHash)));
  }

  async function commitCandidate(row: Copy) {
    if (isAgentDirectoryCopy(row)) return directories.collectStopped(row);
    if (row.candidateBase64 === null || completed.has(row.state) || row.state === "conflict") return row;
    try {
      const receipt = await revisions.commit({
        companyId: row.companyId, agentId: row.agentId, entryFile: row.entryFile,
        baseRevisionId: row.baseRevisionId, content: Buffer.from(row.candidateBase64, "base64"), source: "cleanup",
      }, actorFor(row));
      return patch(row, { state: "saved", receipt: { ...receipt }, errorCode: null, errorMessage: null, nextAttemptAt: null });
    } catch (error) {
      const detail = error as { status?: number; details?: { code?: string }; message?: string };
      const code = detail.details?.code ?? "INSTRUCTION_SAVE_FAILED";
      const retryable = !detail.status || detail.status >= 500;
      const message = detail.status === 403
        ? `${detail.message ?? "Current permissions do not allow this instruction save."} The candidate was preserved.`
        : detail.status === 409
          ? "Instructions changed after this run started. Review the preserved candidate against the current revision."
          : "Instruction edits were preserved but not saved. Review the candidate before retrying.";
      return patch(row, { state: retryable ? "pending_commit" : "conflict", errorCode: code, errorMessage: message, nextAttemptAt: retryable && row.attempts < MAX_COLLECTION_ATTEMPTS ? new Date(Date.now() + 30_000) : null });
    }
  }

  /** Caller must have joined the owned provider process before granting this proof. */
  function collectStopped(input: { companyId: string; runId: string; target?: AdapterExecutionTarget | null }): Promise<Copy | null> {
    return serializeCopySave(db, input.companyId, input.runId, () => collectStoppedOnce(input));
  }
  async function collectStoppedOnce(input: Parameters<typeof collectStopped>[0]) {
    let row = await get(input.companyId, input.runId);
    if (!row) return row;
    if (isAgentDirectoryCopy(row)) return directories.collectStopped(row, input.target);
    if (completed.has(row.state) || row.state === "conflict") return row;
    row = await patch(row, { processStoppedAt: row.processStoppedAt ?? new Date(), attempts: row.attempts + 1 });
    if (completed.has(row.state) || row.state === "conflict") return row;
    if (row.candidateBase64 !== null) return commitCandidate(row);
    try {
      const candidate = await readCandidate(row, input.target);
      if (candidate === null) {
        return patch(row, { state: "unavailable", errorCode: "INSTRUCTION_FILE_MISSING", errorMessage: "The registered instruction file was removed. Canonical instructions were kept; no edits were saved.", nextAttemptAt: null });
      }
      if (hash(candidate) === row.baseHash) return patch(row, { state: "unchanged", nextAttemptAt: null });
      // Save the candidate durably before attempting authorization/CAS or releasing the environment.
      row = await patch(row, { state: "pending_commit", candidateBase64: candidate.toString("base64"), candidateHash: hash(candidate), nextAttemptAt: new Date() });
      return commitCandidate(row);
    } catch (error) {
      return patch(row, { state: row.attempts < MAX_COLLECTION_ATTEMPTS ? "pending_collection" : "unavailable", errorCode: "INSTRUCTION_COLLECTION_FAILED", errorMessage: "The registered instruction copy could not be read safely. Canonical instructions were kept; no save receipt exists.", nextAttemptAt: row.attempts < MAX_COLLECTION_ATTEMPTS ? new Date(Date.now() + 30_000) : null });
    }
  }

  /** Restarts can retry persisted bytes without touching a live filesystem or launching a model. */
  async function recoverCaptured(options: { skipCommit?: boolean; skipDirectoryCleanup?: boolean } = {}) {
    const pending = options.skipCommit ? [] : await db.select().from(copies).where(and(
      eq(copies.state, "pending_commit"),
      or(isNull(copies.nextAttemptAt), lte(copies.nextAttemptAt, new Date())),
      lte(copies.attempts, MAX_COLLECTION_ATTEMPTS - 1),
    )).limit(20);
    for (const row of pending) await recoverCommit(commitEntry(row)!, () => true);
    // A crash between a durable save and release must not retain run snapshots
    // forever. Only discard copies with recorded stop proof and a terminal receipt.
    if (!options.skipDirectoryCleanup) {
      const cleanup = await db.select({ id: copies.runId, companyId: copies.companyId,
        dueAt: copies.nextAttemptAt }).from(copies).where(and(directoryCleanupPredicate(),
        or(isNull(copies.nextAttemptAt), lte(copies.nextAttemptAt, new Date())),
      )).orderBy(asc(copies.updatedAt)).limit(20);
      for (const row of cleanup) {
        try { await recoverDirectoryRelease({ ...row, dueAt: row.dueAt?.getTime() ?? 0 }, () => true); }
        catch (error) { logger.warn({ err: error, runId: row.id }, "Agent file cleanup deferred; save receipt unchanged"); }
      }
    }
    return pending.length;
  }

  /** Recover only the registered copy after independently recorded process-stop
   * proof. Terminal run status is never a substitute for that proof. Remote
   * receipts mean the environment is stopped; do not restart it just to read. */
  function collectionCandidate(row: Copy) {
    return !row.receipt?.retainedByRunId && (
      row.attempts < MAX_COLLECTION_ATTEMPTS && (["prepared", "pending_collection", "unchanged_turn", "warm_saved"].includes(row.state)
        || row.state === "preparing" && isAgentDirectoryCopy(row))
      || row.state === "unavailable" && !row.processStoppedAt && row.location.startsWith("remote:") && isAgentDirectoryCopy(row));
  }
  function collectionPredicate() {
    return and(sql`NOT (coalesce(${copies.receipt}, '{}'::jsonb) ? 'retainedByRunId') AND (
      (${copies.attempts} < 3 AND (${copies.state} IN ('prepared', 'pending_collection', 'unchanged_turn', 'warm_saved')
        OR (${copies.state} = 'preparing' AND ${copies.receipt}->>'schema' = 'paperclip.agent-files.v1')))
      OR (${copies.state} = 'unavailable' AND ${copies.processStoppedAt} IS NULL
        AND ${copies.location} LIKE 'remote:%' AND ${copies.receipt}->>'schema' = 'paperclip.agent-files.v1'))`,
      inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]));
  }
  async function collectRecovered(row: Copy, runtimeMode: string | null) {
    if (row.state === "unavailable" && isAgentDirectoryCopy(row)) {
      await recoverDirectoryCleanup(row, () => directories.recoverUnavailable(row));
    } else if (row.state === "preparing" && isAgentDirectoryCopy(row)) {


      await directories.release(await patch(row, { state: "unavailable", processStoppedAt: new Date(),
        errorCode: "AGENT_FILES_PREPARE_FAILED", errorMessage: "Agent-file preparation was interrupted. The temporary copy was discarded.", nextAttemptAt: null }));
    } else if (row.location === "local" && (row.processStoppedAt || runtimeMode === "native" &&
        await hasNativeLocalProcessStop(db, row.companyId, row.runId))) {
      const result = await collectStopped({ companyId: row.companyId, runId: row.runId });
      if (result && isAgentDirectoryCopy(result) && completed.has(result.state)) await directories.release(result);
    } else if (row.location !== "local" && await remoteExecutionHasStopped(db, row.companyId, row.runId)) {
      if (row.receipt?.warm === true) {
      const unavailable = row.receipt?.warm === true
        ? await patch(row, { state: "unavailable", errorCode: "AGENT_FILES_FINAL_COLLECTION_UNAVAILABLE",
          errorMessage: "The last completed checkpoint remains saved. Files changed afterwards could not be collected after remote termination.", nextAttemptAt: null })
        : await reportUnavailable(row.companyId, row.runId);
      if (unavailable && isAgentDirectoryCopy(unavailable)) {
        await directories.release(await patch(unavailable, { processStoppedAt: unavailable.processStoppedAt ?? new Date() }));
      }
      } else {
      if (isAgentDirectoryCopy(row)) await directories.recoverStoppedRemote(row);
      else await reportUnavailable(row.companyId, row.runId);
      }
    } else if (row.state === "prepared") {
      await patch(row, { state: "pending_collection", errorCode: "INSTRUCTION_STOP_UNCONFIRMED",
        errorMessage: "The provider's stop has not been confirmed. Instruction collection is pending; no save is claimed.", nextAttemptAt: new Date(Date.now() + 30_000) });
    } else if (["warm_saved", "pending_collection", "unchanged_turn"].includes(row.state)) {


      await patch(row, { nextAttemptAt: new Date(Date.now() + 30_000) });
    }
  }
  type CollectionEntry = { id: string; companyId: string; dueAt: number };
  async function loadCollection(scope: InstructionCollectionScope | undefined, admitted: () => boolean) {
    const entries: CollectionEntry[] = [];
    let cursor: string | undefined;
    while (admitted()) {
      const rows = await db.select({ id: copies.runId, companyId: copies.companyId, nextAttemptAt: copies.nextAttemptAt })
        .from(copies).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, copies.companyId), eq(heartbeatRuns.id, copies.runId)))
        .where(and(collectionPredicate(), scope ? eq(copies.companyId, scope.companyId) : undefined,
          scope?.runId ? eq(copies.runId, scope.runId) : undefined, cursor ? gt(copies.runId, cursor) : undefined))
        .orderBy(asc(copies.runId)).limit(100);
      for (const row of rows) entries.push({ id: row.id, companyId: row.companyId, dueAt: row.nextAttemptAt?.getTime() ?? 0 });
      if (rows.length < 100) return entries;
      cursor = rows[rows.length - 1].id;
    }
    throw new Error("Instruction collection reconstruction stopped");
  }
  async function readCollection(entry: CollectionEntry) {
    const [current] = await db.select({ copy: copies, runtimeMode: heartbeatRuns.runtimeMode }).from(copies)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, copies.companyId), eq(heartbeatRuns.id, copies.runId)))
      .where(and(collectionPredicate(), scope(entry.companyId, entry.id)));
    return current;
  }
  async function recoverCollection(entry: CollectionEntry, admitted: () => boolean) {
    const current = await readCollection(entry);
    if (!current) return null;
    const dueAt = current.copy.nextAttemptAt?.getTime() ?? 0;
    if (dueAt > Date.now()) return { ...entry, dueAt };
    if (!admitted()) throw new Error("Instruction collection recovery stopped");
    const claimed = await tryPatch(current.copy, { nextAttemptAt: new Date(Date.now() + 30_000) }, true,
      sql`EXISTS (SELECT 1 FROM ${heartbeatRuns} WHERE ${heartbeatRuns.id} = ${copies.runId}
        AND ${heartbeatRuns.companyId} = ${copies.companyId}
        AND ${heartbeatRuns.status} IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'))`);
    if (claimed) await collectRecovered(claimed, current.runtimeMode);
    const remaining = await readCollection(entry);
    if (!remaining) return null;
    const next = { ...entry, dueAt: remaining.copy.nextAttemptAt?.getTime() ?? 0 };
    if (next.dueAt <= Date.now()) throw new Error("Instruction collection remains unresolved without a future retry");
    return next;
  }
  async function recoverStopped() {
    const rows = await db.select({ id: copies.runId, companyId: copies.companyId, nextAttemptAt: copies.nextAttemptAt })
      .from(copies).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, copies.companyId), eq(heartbeatRuns.id, copies.runId)))
      .where(and(collectionPredicate(), or(isNull(copies.nextAttemptAt), lte(copies.nextAttemptAt, new Date()))))
      .orderBy(asc(copies.updatedAt)).limit(20);
    for (const row of rows) {
      try { await recoverCollection({ id: row.id, companyId: row.companyId, dueAt: row.nextAttemptAt?.getTime() ?? 0 }, () => true); }
      catch (error) { logger.warn({ err: error, runId: row.id }, "Instruction collection recovery deferred"); }
    }
    return rows.length;
  }
  function registerStoppedCollectionWork(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
    canRun: () => boolean, canRecover: () => Promise<boolean>) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.instructionCollection, batchSize: 20,
      decodeScope: (hint: string): InstructionCollectionScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: CollectionEntry, scope?: InstructionCollectionScope) => !scope ||
        entry.companyId === scope.companyId && (!scope.runId || entry.id === scope.runId),
      load: async (scope, signal) => await canRecover() ? loadCollection(scope, () => canRun() && !signal?.aborted) : [],
      check: async (entry, signal) => await canRecover() ? recoverCollection(entry, () => canRun() && !signal?.aborted) : null,
    }, canRun);
  }

  type DirectoryCleanupEntry = { id: string; companyId: string; dueAt: number };
  function directoryCleanupEntry(row: Copy | null): DirectoryCleanupEntry | null {
    return row && ["saved", "unchanged", "resolved", "unavailable"].includes(row.state)
      && row.processStoppedAt && isAgentDirectoryCopy(row) && !row.receipt?.retainedByRunId
      && row.receipt?.cleanupPending !== false
      && (Object.hasOwn(row.receipt!, "baseline") || row.receipt?.cleanupPending === true)
      ? { id: row.runId, companyId: row.companyId, dueAt: row.nextAttemptAt?.getTime() ?? 0 } : null;
  }
  function directoryCleanupPredicate() {
    return sql`${copies.state} IN ('saved', 'unchanged', 'resolved', 'unavailable')
      AND ${copies.processStoppedAt} IS NOT NULL
      AND ${copies.receipt}->>'schema' = 'paperclip.agent-files.v1'
      AND coalesce(${copies.receipt}->>'retainedByRunId', '') = ''
      AND ${copies.receipt}->>'cleanupPending' IS DISTINCT FROM 'false'
      AND (${copies.receipt} ? 'baseline' OR ${copies.receipt}->>'cleanupPending' = 'true')`;
  }
  async function loadDirectoryCleanup(scope: DirectoryCleanupScope | undefined, admitted: () => boolean) {
    const entries: DirectoryCleanupEntry[] = [];
    let cursor: string | undefined;
    while (admitted()) {
      const rows = await db.select({ id: copies.runId, companyId: copies.companyId, nextAttemptAt: copies.nextAttemptAt })
        .from(copies).where(and(directoryCleanupPredicate(),
          scope ? eq(copies.companyId, scope.companyId) : undefined,
          scope?.runId ? eq(copies.runId, scope.runId) : undefined,
          cursor ? gt(copies.runId, cursor) : undefined,
        )).orderBy(asc(copies.runId)).limit(100);
      for (const row of rows) entries.push({ id: row.id, companyId: row.companyId, dueAt: row.nextAttemptAt?.getTime() ?? 0 });
      if (rows.length < 100) return entries;
      cursor = rows[rows.length - 1].id;
    }
    throw new Error("Directory cleanup reconstruction stopped");
  }
  async function recoverDirectoryRelease(entry: DirectoryCleanupEntry, admitted: () => boolean) {
    const row = await get(entry.companyId, entry.id);
    const current = directoryCleanupEntry(row);
    if (!row || !current || current.dueAt > Date.now()) return current;
    if (!admitted()) throw new Error("Directory cleanup recovery stopped");
    const claimed = await tryPatch(row, { nextAttemptAt: new Date(Date.now() + 30_000) }, true);
    if (claimed) await directories.release(claimed);
    const remaining = directoryCleanupEntry(await get(entry.companyId, entry.id));
    if (remaining && remaining.dueAt <= Date.now()) throw new Error("Directory cleanup remains unresolved without a future retry");
    return remaining;
  }
  function registerDirectoryCleanupWork(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
    canRun: () => boolean, canRecover: () => Promise<boolean>) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.directoryCleanup,
      batchSize: 20,
      decodeScope: (hint: string): DirectoryCleanupScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: DirectoryCleanupEntry, scope?: DirectoryCleanupScope) => !scope ||
        entry.companyId === scope.companyId && (!scope.runId || entry.id === scope.runId),
      load: async (scope, signal) => await canRecover() ? loadDirectoryCleanup(scope, () => canRun() && !signal?.aborted) : [],
      check: async (entry, signal) => await canRecover() ? recoverDirectoryRelease(entry, () => canRun() && !signal?.aborted) : null,
    }, canRun);
  }

  type CommitEntry = { id: string; companyId: string; dueAt: number };
  function commitEntry(row: Pick<Copy, "runId" | "companyId" | "state" | "attempts" | "nextAttemptAt"> | null): CommitEntry | null {
    return row?.state === "pending_commit" && row.attempts < MAX_COLLECTION_ATTEMPTS
      ? { id: row.runId, companyId: row.companyId, dueAt: row.nextAttemptAt?.getTime() ?? 0 } : null;
  }
  async function loadCommits(scope: InstructionCommitScope | undefined, admitted: () => boolean) {
    const entries: CommitEntry[] = [];
    let cursor: string | undefined;
    while (admitted()) {
      const rows = await db.select({ runId: copies.runId, companyId: copies.companyId, state: copies.state,
        attempts: copies.attempts, nextAttemptAt: copies.nextAttemptAt }).from(copies).where(and(
        eq(copies.state, "pending_commit"), lte(copies.attempts, MAX_COLLECTION_ATTEMPTS - 1),
        scope ? eq(copies.companyId, scope.companyId) : undefined,
        scope?.runId ? eq(copies.runId, scope.runId) : undefined,
        cursor ? gt(copies.runId, cursor) : undefined,
      )).orderBy(asc(copies.runId)).limit(100);
      for (const row of rows) entries.push(commitEntry(row)!);
      if (rows.length < 100) return entries;
      cursor = rows[rows.length - 1].runId;
    }
    throw new Error("Instruction commit reconstruction stopped");
  }
  function recoverCommit(entry: CommitEntry, admitted: () => boolean): Promise<CommitEntry | null> {
    return serializeCopySave(db, entry.companyId, entry.id, () => recoverCommitOnce(entry, admitted));
  }
  async function recoverCommitOnce(entry: CommitEntry, admitted: () => boolean) {
    const row = await get(entry.companyId, entry.id);
    const current = commitEntry(row);
    if (!row || !current || current.dueAt > Date.now()) return current;
    if (!admitted()) throw new Error("Instruction commit recovery stopped");
    const claimed = await tryPatch(row, { attempts: row.attempts + 1 }, true);
    if (claimed) {
      const result = await commitCandidate(claimed);
      if (isAgentDirectoryCopy(result) && completed.has(result.state)) await directories.release(result);
    }
    return commitEntry(await get(entry.companyId, entry.id));
  }
  function registerCapturedCommitWork(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
    canRun: () => boolean, canRecover: () => Promise<boolean>) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.instructionCommit,
      batchSize: 20,
      decodeScope: (hint: string): InstructionCommitScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: CommitEntry, scope?: InstructionCommitScope) => !scope ||
        entry.companyId === scope.companyId && (!scope.runId || entry.id === scope.runId),
      load: async (scope, signal) => await canRecover() ? loadCommits(scope, () => canRun() && !signal?.aborted) : [],
      check: async (entry, signal) => await canRecover() ? recoverCommit(entry, () => canRun() && !signal?.aborted) : null,
    }, canRun);
  }

  async function list(companyId: string, agentId: string, actor: AuthorizationActor) {
    await revisions.readCurrent({ companyId, agentId }, actor);
    const rows = await db.select().from(copies).where(and(eq(copies.companyId, companyId), eq(copies.agentId, agentId), inArray(copies.state, ["conflict", "pending_collection", "pending_commit", "unavailable"]))).orderBy(desc(copies.createdAt)).limit(50);
    return rows.map(row => ({ runId: row.runId, entryFile: row.entryFile, baseRevisionId: row.baseRevisionId,
      baseHash: row.baseHash, state: row.state as "conflict" | "pending_collection" | "pending_commit" | "unavailable",
      candidateHash: row.candidateHash, contract: isAgentDirectoryCopy(row) ? "agent_files" : "legacy",
      content: row.candidateBase64 === null ? null : Buffer.from(row.candidateBase64, "base64").toString("utf8"),
      errorCode: row.errorCode, errorMessage: row.errorMessage, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
  }

  async function resolve(input: { companyId: string; agentId: string; runId: string; baseRevisionId: string | null; content: string }, actor: AuthorizationActor) {
    const row = await get(input.companyId, input.runId);
    if (!row || row.agentId !== input.agentId) throw notFound("Instruction candidate not found");
    if (completed.has(row.state)) throw conflict("This instruction candidate has already been resolved");
    if (isAgentDirectoryCopy(row)) throw conflict("Agent-file synchronization failures have no preserved candidate");
    const receipt = await revisions.commit({ companyId: input.companyId, agentId: input.agentId, entryFile: row.entryFile, content: input.content, baseRevisionId: input.baseRevisionId, source: "api" }, actor);
    await patch(row, { state: "resolved", receipt: { ...receipt }, nextAttemptAt: null });
    return receipt;
  }

  /** A controller may report loss before disposal, never fabricate a save or
   * read a possibly live provider. Already captured candidates remain intact. */
  async function reportUnavailable(companyId: string, runId: string) {
    const row = await get(companyId, runId);
    if (!row || completed.has(row.state) || ["unchanged_turn", "warm_saved", "superseded"].includes(row.state) || row.candidateBase64 !== null || (isAgentDirectoryCopy(row) && row.candidateHash !== null) || row.state === "conflict") return row;
    // A failed close or deferred lease observation grants no stop proof. Keep
    // that row recoverable through generic heartbeat cleanup.
    if (isAgentDirectoryCopy(row) && (row.state === "unavailable"
      || row.state === "pending_collection" && !row.processStoppedAt)) return row;
    return patch(row, { state: "unavailable", errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE",
      errorMessage: "The registered instruction copy could not be retrieved safely before environment release. No instruction save is claimed.", nextAttemptAt: null });
  }

  async function release(companyId: string, runId: string) { liveTargets.delete(targetKey(companyId, runId)); const row = await get(companyId, runId); if (row && isAgentDirectoryCopy(row)) await directories.release(row); }
  async function reportRetirementUnconfirmed(companyId: string, runId: string) {
    const row = await get(companyId, runId);
    if (!row || !isAgentDirectoryCopy(row) || row.receipt?.retainedByRunId || row.processStoppedAt) return row;
    return patch(row, { state: "pending_collection", errorCode: "INSTRUCTION_STOP_UNCONFIRMED",
      errorMessage: "The retained provider did not confirm retirement. Its registered agent directory is preserved; no save is claimed.", nextAttemptAt: null });
  }
  async function adopt(input: Parameters<typeof directories.adopt>[0]) {
    const row = await directories.adopt(input);
    if (row) {
      liveTargets.delete(targetKey(input.companyId, input.previousRunId));
      if (input.target) liveTargets.set(targetKey(input.companyId, input.runId), input.target);
    }
    return row;
  }
  return { registerStoppedCollectionWork, registerDirectoryCleanupWork, registerCapturedCommitWork, prepare, checkpointWarm, canReuseWarm: directories.canReuse, adopt, reportRetirementUnconfirmed, get, hasChanges, acknowledgeExplicitSave, collectStopped, recoverCaptured, recoverStopped, list, resolve, reportUnavailable, release };
}
