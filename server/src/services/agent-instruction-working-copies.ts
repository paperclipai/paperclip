import { agentDirectoryWorkingCopyService, isAgentDirectoryCopy } from "./agent-directory-working-copies.js";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, inArray, lte, or, isNull, isNotNull, sql } from "drizzle-orm";
import { agents, heartbeatRuns, agentInstructionWorkingCopies as copies, type Db } from "@paperclipai/db";
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
  async function patch(row: Copy, values: Partial<typeof copies.$inferInsert>) {
    const [updated] = await db.update(copies).set({ ...values, updatedAt: new Date() }).where(and(
      scope(row.companyId, row.runId), eq(copies.state, row.state), eq(copies.attempts, row.attempts), eq(copies.baseHash, row.baseHash),
    )).returning();
    // A late cleanup must not overwrite an explicit resolution or a newer
    // baseline. Canonical content has its own independent head CAS.
    return updated ?? (await get(row.companyId, row.runId))!;
  }
  function actorFor(row: Copy): AuthorizationActor {
    return { type: "agent", companyId: row.companyId, agentId: row.agentId, runId: row.runId, onBehalfOfUserId: row.responsibleUserId };
  }
  const directories = agentDirectoryWorkingCopyService(db, get, patch, options.environmentRuntime);
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
    const exported = await agentInstructionsService().exportFiles(agent, { rejectSymlinks: true });
    const entryFile = instructionPath(baseline?.revision.entryFile ?? exported.entryFile);
    const content = instructionBytes(baseline?.content ?? exported.files[entryFile] ?? "");
    const localRoot = existing?.localRoot ?? expectedLocalRoot;
    const target = input.target?.kind === "remote" ? input.target : null;
    const executionRoot = target
      ? path.posix.join(target.remoteCwd, ".paperclip-runtime", `instruction-edits-${input.runId}`, "instructions")
      : localRoot;
    if (!existing) {
      await db.insert(copies).values({
        runId: input.runId, companyId: input.companyId, agentId: input.agentId,
        responsibleUserId: bound.onBehalfOfUserId!, entryFile,
        baseRevisionId: baseline?.revision.id ?? null, baseHash: hash(content),
        localRoot, executionRoot, location, state: "preparing",
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
  async function collectStopped(input: { companyId: string; runId: string; target?: AdapterExecutionTarget | null }) {
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
  async function recoverCaptured() {
    const pending = await db.select().from(copies).where(and(
      eq(copies.state, "pending_commit"),
      or(isNull(copies.nextAttemptAt), lte(copies.nextAttemptAt, new Date())),
      lte(copies.attempts, MAX_COLLECTION_ATTEMPTS - 1),
    )).limit(20);
    for (const row of pending) {
      const result = await commitCandidate(await patch(row, { attempts: row.attempts + 1 }));
      if (isAgentDirectoryCopy(result) && completed.has(result.state)) await directories.release(result);
    }
    // A crash between a durable save and release must not retain run snapshots
    // forever. Only discard copies with recorded stop proof and a terminal receipt.
    const cleanup = await db.select().from(copies).where(and(
      inArray(copies.state, [...completed, "unavailable"]), isNotNull(copies.processStoppedAt),
      sql`${copies.receipt}->>'schema' = 'paperclip.agent-files.v1'`,
      or(sql`${copies.receipt} ? 'baseline'`, sql`${copies.receipt}->>'cleanupPending' = 'true'`),
      or(isNull(copies.nextAttemptAt), lte(copies.nextAttemptAt, new Date())),
    )).orderBy(asc(copies.updatedAt)).limit(20);
    for (const row of cleanup) await directories.release(row);
    return pending.length;
  }

  /** Recover only the registered copy after independently recorded process-stop
   * proof. Terminal run status is never a substitute for that proof. Remote
   * receipts mean the environment is stopped; do not restart it just to read. */
  async function recoverStopped() {
    const pending = await db.select({ copy: copies, runtimeMode: heartbeatRuns.runtimeMode }).from(copies)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, copies.companyId), eq(heartbeatRuns.id, copies.runId)))
      .where(and(or(inArray(copies.state, ["prepared", "pending_collection", "warm_saved"]),
          and(eq(copies.state, "preparing"), sql`${copies.receipt}->>'schema' = 'paperclip.agent-files.v1'`)),
        inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]),
        or(isNull(copies.nextAttemptAt), lte(copies.nextAttemptAt, new Date())),
        lte(copies.attempts, MAX_COLLECTION_ATTEMPTS - 1))).orderBy(asc(copies.updatedAt)).limit(20);
    for (const { copy: row, runtimeMode } of pending) {
      if (row.state === "preparing" && isAgentDirectoryCopy(row)) {
        // A provider cannot launch until preparation records "prepared". With
        // the owning run terminal, this is an interrupted staging copy only.
        await directories.release(await patch(row, { state: "unavailable", processStoppedAt: new Date(),
          errorCode: "AGENT_FILES_PREPARE_FAILED", errorMessage: "Agent-file preparation was interrupted. The temporary copy was discarded.", nextAttemptAt: null }));
      } else if (row.location === "local" && (row.processStoppedAt || runtimeMode === "native" &&
          await hasNativeLocalProcessStop(db, row.companyId, row.runId))) {
        const result = await collectStopped({ companyId: row.companyId, runId: row.runId });
        if (result && isAgentDirectoryCopy(result) && completed.has(result.state)) await directories.release(result);
      } else if (row.location !== "local" && await remoteExecutionHasStopped(db, row.companyId, row.runId)) {
        const unavailable = row.receipt?.warm === true
          ? await patch(row, { state: "unavailable", errorCode: "AGENT_FILES_FINAL_COLLECTION_UNAVAILABLE",
            errorMessage: "The last completed checkpoint remains saved. Files changed afterwards could not be collected after remote termination.", nextAttemptAt: null })
          : await reportUnavailable(row.companyId, row.runId);
        if (unavailable && isAgentDirectoryCopy(unavailable)) {
          await directories.release(await patch(unavailable, { processStoppedAt: unavailable.processStoppedAt ?? new Date() }));
        }
      } else if (row.state === "prepared") {
        await patch(row, { state: "pending_collection", errorCode: "INSTRUCTION_STOP_UNCONFIRMED",
          errorMessage: "The provider's stop has not been confirmed. Instruction collection is pending; no save is claimed.", nextAttemptAt: null });
      } else if (row.state === "warm_saved") {
        // Live retained sessions must not occupy every batch and starve stopped
        // copies from other agents. This does not permit reads without stop proof.
        await patch(row, { nextAttemptAt: new Date(Date.now() + 30_000) });
      }
    }
    return pending.length;
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
    if (isAgentDirectoryCopy(row) && row.state === "unavailable") return row;
    return patch(row, { state: "unavailable", errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE",
      errorMessage: "The registered instruction copy could not be retrieved safely before environment release. No instruction save is claimed.", nextAttemptAt: null });
  }

  async function release(companyId: string, runId: string) { liveTargets.delete(targetKey(companyId, runId)); const row = await get(companyId, runId); if (row && isAgentDirectoryCopy(row)) await directories.release(row); }
  return { prepare, get, hasChanges, checkpointWarm, canReuseWarm: directories.canReuse, acknowledgeExplicitSave, collectStopped, recoverCaptured, recoverStopped, list, resolve, reportUnavailable, release };
}
