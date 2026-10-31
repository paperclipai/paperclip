import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { packageEvidence } from "./evidence.js";
import { sealStandardOriginalEvidence, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";
import { boundedOwnedFile, STEERING_PI_EXECUTION, STEERING_PI_PROFILE, STEERING_PI_SOURCE_CLOSURE } from "./steering-pi-receipt.js";

export const PRIVATE_OPERATION_STATE = "steering-pi-operation.json";
export interface PrivatePreframeworkOperation {
  schema: "paperclip.private-preframework-operation/v1"; kind: "steering-pi-installation";
  frameworkStarted: false; runtimeFingerprint: null;
  executionId: typeof STEERING_PI_EXECUTION; runId: string; attempt: "1"; workflowSha: string; targetSha: string;
  profileVersion: 30; profileDigest: string; sourceClosureSha256: string;
  buildArtifact: string; buildSha256: string | null; provisionerSha256: string | null;
  phase: "admission" | "installer" | "asset-verification";
  outcome: "not-started" | "failed" | "cancelled" | "unknown";
  retirement: "not-started" | "observed-closed" | "unknown";
  outputCapture: "complete" | "unknown"; capturedStreams: Array<"stdout" | "stderr">;
}
export function newPreframeworkOperation(context: ManualPrivateHandoff, buildSha256: string | null = null): PrivatePreframeworkOperation {
  return validatePreframeworkOperation({ schema: "paperclip.private-preframework-operation/v1", kind: "steering-pi-installation", frameworkStarted: false, runtimeFingerprint: null,
    executionId: STEERING_PI_EXECUTION, runId: context.runId, attempt: "1", workflowSha: context.workflowSha, targetSha: context.targetSha,
    profileVersion: 30, profileDigest: STEERING_PI_PROFILE.digest, sourceClosureSha256: STEERING_PI_SOURCE_CLOSURE,
    buildArtifact: `runner-e2e-build-${context.targetSha}-${context.runId}-1`, buildSha256, provisionerSha256: null,
    phase: "admission", outcome: "not-started", retirement: "not-started", outputCapture: "complete", capturedStreams: [] }, context);
}
export function validatePreframeworkOperation(value: unknown, context: ManualPrivateHandoff): PrivatePreframeworkOperation {
  const row = value as PrivatePreframeworkOperation;
  const keys = ["schema", "kind", "frameworkStarted", "runtimeFingerprint", "executionId", "runId", "attempt", "workflowSha", "targetSha", "profileVersion", "profileDigest", "sourceClosureSha256", "buildArtifact", "buildSha256", "provisionerSha256", "phase", "outcome", "retirement", "outputCapture", "capturedStreams"];
  if (!row || context.private !== true || context.protocol !== MANUAL_PRIVATE_PROTOCOL || Object.keys(row).sort().join() !== keys.sort().join() || row.schema !== "paperclip.private-preframework-operation/v1" || row.kind !== "steering-pi-installation"
    || row.frameworkStarted !== false || row.runtimeFingerprint !== null || context.executionIds.length !== 1 || row.executionId !== STEERING_PI_EXECUTION || context.executionIds[0] !== row.executionId
    || row.runId !== context.runId || row.attempt !== "1" || context.attempt !== "1" || row.workflowSha !== context.workflowSha || row.targetSha !== context.targetSha
    || row.profileVersion !== STEERING_PI_PROFILE.version || row.profileDigest !== STEERING_PI_PROFILE.digest || row.sourceClosureSha256 !== STEERING_PI_SOURCE_CLOSURE
    || row.buildArtifact !== `runner-e2e-build-${context.targetSha}-${context.runId}-1`
    || [row.buildSha256, row.provisionerSha256].some(value => value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)))
    || !["admission", "installer", "asset-verification"].includes(row.phase) || !["not-started", "failed", "cancelled", "unknown"].includes(row.outcome)
    || !["complete", "unknown"].includes(row.outputCapture) || !["not-started", "observed-closed", "unknown"].includes(row.retirement) || !Array.isArray(row.capturedStreams)
    || !["", "stdout", "stderr", "stdout,stderr"].includes(row.capturedStreams.join()) || row.phase === "admission" && row.retirement !== "not-started"
    || row.phase !== "admission" && (row.retirement === "not-started" || !row.buildSha256 || !row.provisionerSha256 || row.capturedStreams.length !== 2)
    || row.outcome === "not-started" && row.phase !== "admission" || row.retirement === "unknown" && row.outcome !== "unknown")
    throw new Error("Invalid private preframework operation identity");
  return row;
}
export async function validateOperationOriginals(directory: string, context: ManualPrivateHandoff) {
  const operation = validatePreframeworkOperation(JSON.parse((await boundedOwnedFile(path.join(directory, "snapshots/preframework-operation.json"), 16_384, true)).toString()), context);
  const expected = ["snapshots/preframework-operation.json", ...operation.capturedStreams.map(stream => `playwright-output/steering-pi-installer.${stream}.log`)];
  const files: string[] = [];
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === "original-evidence-inventory.json" && !relative) continue;
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory() || entry.isDirectory() && !["snapshots", "playwright-output"].includes(name)) throw new Error("Unexpected private operation carrier");
      if (entry.isDirectory()) await visit(name); else files.push(name);
    }
  }
  await visit("");
  if (files.sort().join() !== expected.sort().join()) throw new Error("Private operation files differ from captured streams");
  for (const name of expected) await boundedOwnedFile(path.join(directory, name), 4 * 1024 * 1024, true);
  return operation;
}
export async function sealPreframeworkOperation(context: ManualPrivateHandoff, secrets: string[]) {
  let operation: PrivatePreframeworkOperation;
  try { operation = validatePreframeworkOperation(JSON.parse((await boundedOwnedFile(path.join(context.root, PRIVATE_OPERATION_STATE), 16_384, true)).toString()), context); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const stream of ["stdout", "stderr"]) {
      try { await boundedOwnedFile(path.join(context.root, `steering-pi-installer.${stream}.log`), 4 * 1024 * 1024, true); throw new Error("Installer output without operation admission"); }
      catch (absent) { if ((absent as NodeJS.ErrnoException).code !== "ENOENT") throw absent; }
    }
    operation = newPreframeworkOperation(context); operation.outcome = "unknown";
    await writeFile(path.join(context.root, PRIVATE_OPERATION_STATE), `${JSON.stringify(operation)}\n`, { mode: 0o600, flag: "wx" });
  }
  const discovered: Array<"stdout" | "stderr"> = [];
  for (const stream of ["stdout", "stderr"] as const) {
    const info = await lstat(path.join(context.root, `steering-pi-installer.${stream}.log`)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077 || typeof process.getuid === "function" && info.uid !== process.getuid())
      throw new Error("Invalid known installer output custody");
    discovered.push(stream);
  }
  if (discovered.join() !== operation.capturedStreams.join()) throw new Error("Known installer output differs from operation capture declaration");
  const source = path.join(context.root, "preframework-operation");
  await mkdir(source, { mode: 0o700 }); await mkdir(path.join(source, "snapshots"), { mode: 0o700 });
  await writeFile(path.join(source, "snapshots/preframework-operation.json"), `${JSON.stringify(operation)}\n`, { mode: 0o600, flag: "wx" });
  if (operation.capturedStreams.length) await mkdir(path.join(source, "playwright-output"), { mode: 0o700 });
  for (const stream of operation.capturedStreams) {
    const name = `steering-pi-installer.${stream}.log`, original = path.join(context.root, name);
    const bytes = await boundedOwnedFile(original, 4 * 1024 * 1024, true);
    await writeFile(path.join(source, "playwright-output", name), bytes, { mode: 0o600, flag: "wx" });
  }
  await validateOperationOriginals(source, context);
  const scan = await packageEvidence({ privateDir: source, uploadDir: path.join(context.root, "operation-scan"), secrets, expectPassScreenshot: false });
  return sealStandardOriginalEvidence({ context, executionId: operation.executionId, source, evidence: scan, secrets, expectPassScreenshot: false });
}
