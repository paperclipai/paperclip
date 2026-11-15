import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runnerE2EServerControlPaths } from "../harness-env.js";
import { readProcessTable, type ProcessObservation } from "../process-tree.js";
import { runnerE2ETypeScriptProcessArgs } from "../web-server-command.js";
import { invitationIncident, type InvitationRuntimeProof } from "./identity-invite-prerequisite.js";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const invitationSourceProofPath = (root: string) => path.join(runnerE2EServerControlPaths(root).controlDirectory, "invitation-source-process.json");
interface SourceProof {
  schema: "invitation-source-process.v1"; generation: string; attemptId: string; executionIds: string[]; apiOrigin: string;
  sourceRoot: string; serverEntry: string; serverEntrySha256: string; redactorSha256: string;
  argv: string[]; pid: number; parentPid: number; processStarted: string; spawnedAt: string;
}
interface Expected { temporaryRoot: string; sourceRoot: string; apiOrigin: string; attemptId: string; executionId: string }
async function sourceBytes(root: string) {
  const serverEntry = await realpath(path.join(root, "server/src/index.ts"));
  return { serverEntry, serverEntrySha256: digest(await readFile(serverEntry)),
    redactorSha256: digest(await readFile(path.join(root, "server/src/middleware/redact-sensitive.ts"))) };
}
export function validateInvitationSourceProof(value: unknown, expected: Expected, bytes: Awaited<ReturnType<typeof sourceBytes>>,
  process: ProcessObservation | undefined, health: { commit?: string | null; serverInfo?: { processStartedAt?: string } }, restartGeneration?: string): asserts value is SourceProof {
  const p = value as SourceProof;
  const boot = Date.parse(health.serverInfo?.processStartedAt ?? ""), spawn = Date.parse(p?.spawnedAt ?? "");
  if (!expected.attemptId || !expected.executionId || !p || p.schema !== "invitation-source-process.v1" || !p.generation || restartGeneration !== undefined && p.generation !== restartGeneration || p.attemptId !== expected.attemptId
    || p.apiOrigin !== expected.apiOrigin || p.sourceRoot !== expected.sourceRoot || p.serverEntry !== bytes.serverEntry
    || p.serverEntrySha256 !== bytes.serverEntrySha256 || p.redactorSha256 !== bytes.redactorSha256
    || !Array.isArray(p.executionIds) || p.executionIds.length !== 1 || p.executionIds[0] !== expected.executionId
    || JSON.stringify(p.argv) !== JSON.stringify(runnerE2ETypeScriptProcessArgs(expected.sourceRoot, path.join(expected.sourceRoot, "tests/runner-e2e/server-entry.ts"), ["onboard", "--yes", "--run"]))
    || !process || process.pid !== p.pid || process.parentPid !== p.parentPid || process.started !== p.processStarted
    || !Number.isSafeInteger(p.pid) || p.pid <= 1 || p.parentPid <= 1 || !Number.isFinite(boot) || !Number.isFinite(spawn)
    || boot < spawn - 2000 || boot > Date.now() || spawn > Date.now()) throw new Error("Invitation source process proof is unqualified");
}
/** The supervisor alone writes this private receipt from its actual spawn. */
export async function publishInvitationSourceProof(input: Omit<Expected, "executionId"> & { executionIds: string[]; pid: number; argv: string[]; spawnedAt: string }) {
  const filename = invitationSourceProofPath(input.temporaryRoot);
  await rm(filename, { force: true });
  const processes = await readProcessTable(); const process = processes?.find(row => row.pid === input.pid);
  if (!process) return;
  const sourceRoot = await realpath(input.sourceRoot); const bytes = await sourceBytes(sourceRoot);
  const receipt: SourceProof = { schema: "invitation-source-process.v1", generation: randomUUID(), attemptId: input.attemptId,
    executionIds: input.executionIds, apiOrigin: input.apiOrigin, sourceRoot, ...bytes, argv: input.argv, pid: process.pid,
    parentPid: process.parentPid, processStarted: process.started, spawnedAt: input.spawnedAt };
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
  return receipt.generation;
}
/** Every enrollment re-reads the current generation, process and source bytes. */
export async function verifyInvitationSourceProof(input: Expected & { health(): Promise<{ commit?: string | null; serverInfo?: { processStartedAt?: string } }> }): Promise<InvitationRuntimeProof> {
  const filename = invitationSourceProofPath(input.temporaryRoot); const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.mode & 0o077 || process.getuid && metadata.uid !== process.getuid()) throw new Error("Invitation source proof custody is invalid");
  const encoded = await readFile(filename); const value = JSON.parse(encoded.toString("utf8")) as unknown;
  const sourceRoot = await realpath(input.sourceRoot); const bytes = await sourceBytes(sourceRoot);
  const table = await readProcessTable(); const health = await input.health();
  let restartGeneration: string | undefined;
  try {
    const ack = JSON.parse(await readFile(runnerE2EServerControlPaths(input.temporaryRoot).restartAcknowledgementPath, "utf8")) as { status?: string; invitationSourceGeneration?: string };
    if (ack.status !== "ready" || !ack.invitationSourceGeneration) throw new Error("Invitation restart proof is unqualified");
    restartGeneration = ack.invitationSourceGeneration;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  validateInvitationSourceProof(value, { ...input, sourceRoot }, bytes, table?.find(row => row.pid === (value as SourceProof)?.pid), health, restartGeneration);
  if (digest(await readFile(filename)) !== digest(encoded)) throw new Error("Invitation source proof changed during verification");
  return { apiOrigin: value.apiOrigin, processStartedAt: health.serverInfo!.processStartedAt!, healthCommit: health.commit ?? null,
    redactorSha256: value.redactorSha256, serverEntrySha256: value.serverEntrySha256,
    supervisorReceiptSha256: digest(encoded), priorProofSha256: invitationIncident.priorProofSha256 };
}
