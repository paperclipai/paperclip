import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import approvedTarget from "./steering-pi-target-source.json" with { type: "json" };
import { PI_DISTRIBUTION_CLOSURE_SHA256 } from "../../packages/paperclip-runner/src/drivers/acpx/pi-closure-pins.js";
import { PI_NODE_VERSION } from "../../packages/paperclip-runner/src/drivers/acpx/pi-node-pins.js";
import { parseNativeAcpxDistributionEntries } from "../../packages/paperclip-runner/src/drivers/acpx/native-distribution-integrity.js";
import type { ManualPrivateHandoff } from "./manual-private-handoff.js";

export const STEERING_PI_PROFILE = Object.freeze({ version: 30, digest: "sha256:4517ab123dd89140ef462fc1905ac7a16a0dfcbaf21d67299a3c62de29c08a4d" });
export const STEERING_PI_SOURCE_CLOSURE = "b4aa765fc2ca536d6bc0e96b52f3643b06297c90ada7fa6998f597bbeddc334b";
export const STEERING_PI_EXECUTION = "chat-features.runner-opencode.local.steering.steer-active";
export const STEERING_PI_CASE_MS = 720_000;
export const STEERING_PI_CLEANUP_MS = 90_000;
export const STEERING_PI_JOB_MS = 32 * 60_000;
export const STEERING_PI_RECEIPT = "steering-pi-assets.json";
export interface SteeringPiReceipt {
  schema: "paperclip.steering-pi-assets/v1";
  executionId: typeof STEERING_PI_EXECUTION;
  runId: string; attempt: "1"; workflowSha: string; targetSha: string;
  jobId: number; runnerName: string; jobStartedAt: string; jobDeadlineMs: number;
  buildArtifact: string; buildSha256: string; provisionerSha256: string;
  status: "installed_verified" | "verified_existing"; target: "linux-x64";
  profileDigest: string; sourceClosureSha256: string; closureSha256: string; distributionSha256: string; nativeManifestSha256: string;
}
export const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export async function boundedOwnedFile(file: string, limit: number, privateFile = false): Promise<Buffer> {
  if (await realpath(file) !== path.resolve(file)) throw new Error("Pi delivery path is not canonical");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)
      || before.uid !== BigInt(process.getuid!()) || (privateFile && (before.mode & 0o077n) !== 0n)) throw new Error("Invalid Pi delivery file custody");
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    if (bytes.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) throw new Error("Pi delivery file changed");
    return bytes;
  } finally { await handle.close(); }
}
export async function assertSteeringPiTargetSource(targetRoot: string) {
  if (approvedTarget.profileVersion !== STEERING_PI_PROFILE.version || approvedTarget.profileDigest !== STEERING_PI_PROFILE.digest
    || digest(JSON.stringify(approvedTarget.records)) !== STEERING_PI_SOURCE_CLOSURE) throw new Error("Invalid reviewed Pi target closure");
  for (const row of approvedTarget.records) {
    if (!row.file.startsWith("packages/paperclip-runner/") && !row.file.startsWith("patches/") || row.file.split("/").includes("..")) throw new Error("Invalid reviewed Pi source path");
    if (digest(await boundedOwnedFile(path.join(targetRoot, row.file), 64 * 1024 * 1024)) !== row.sha256) throw new Error("Pi target source differs from its exact reviewed closure");
  }
}
export function requireSteeringPiTime(deadline: number, now: number) {
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(now) || deadline - now < STEERING_PI_CASE_MS + STEERING_PI_CLEANUP_MS)
    throw new Error("Insufficient time for the unchanged steering case and cleanup");
}
export async function steeringPiAssetIdentity(targetRoot: string) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Steering Pi delivery requires the selected Linux host");
  const assets = path.join(targetRoot, "packages/paperclip-runner/provider-assets/pi/linux-x64");
  const distribution = await boundedOwnedFile(path.join(assets, "pi-distribution.json"), 4 * 1024 * 1024);
  const native = await boundedOwnedFile(path.join(assets, "native-closure.json"), 4 * 1024 * 1024);
  const metadata = JSON.parse(distribution.toString());
  const closureSha256 = PI_DISTRIBUTION_CLOSURE_SHA256["linux-x64"];
  parseNativeAcpxDistributionEntries(JSON.parse(native.toString()), closureSha256);
  if (metadata.schema !== "paperclip.pi-distribution.v1" || metadata.runtimeRoot !== "runtime" || metadata.nativeClosureSha256 !== closureSha256
    || metadata.target?.platform !== "linux" || metadata.target?.architecture !== "x64" || metadata.target?.nodeVersion !== PI_NODE_VERSION
    || metadata.pins?.wrapper !== "0.0.33" || metadata.pins?.runtime !== "1.0.0" || metadata.pins?.sdk !== "0.26.0" || metadata.pins?.zod !== "3.25.76")
    throw new Error("Pi delivery metadata does not match the source-owned graph");
  return { closureSha256, distributionSha256: digest(distribution), nativeManifestSha256: digest(native) };
}
export async function readSteeringPiReceipt(context: ManualPrivateHandoff, targetRoot: string, runnerName: string, now: () => number = Date.now) {
  if (context.executionIds.length !== 1 || context.executionIds[0] !== STEERING_PI_EXECUTION) throw new Error("Pi delivery is outside its selected execution");
  const bytes = await boundedOwnedFile(path.join(context.root, STEERING_PI_RECEIPT), 16_384, true);
  const receipt = JSON.parse(bytes.toString()) as SteeringPiReceipt;
  const keys = ["schema", "executionId", "runId", "attempt", "workflowSha", "targetSha", "jobId", "runnerName", "jobStartedAt", "jobDeadlineMs", "buildArtifact", "buildSha256", "provisionerSha256", "status", "target", "profileDigest", "sourceClosureSha256", "closureSha256", "distributionSha256", "nativeManifestSha256"];
  if (Object.keys(receipt).sort().join() !== keys.sort().join() || receipt.schema !== "paperclip.steering-pi-assets/v1" || receipt.executionId !== STEERING_PI_EXECUTION
    || receipt.runId !== context.runId || receipt.attempt !== context.attempt || receipt.workflowSha !== context.workflowSha || receipt.targetSha !== context.targetSha
    || receipt.runnerName !== runnerName || !runnerName || !Number.isSafeInteger(receipt.jobId) || receipt.jobId <= 0
    || receipt.jobDeadlineMs !== Date.parse(receipt.jobStartedAt) + STEERING_PI_JOB_MS || Date.parse(receipt.jobStartedAt) > now()
    || receipt.buildArtifact !== `runner-e2e-build-${context.targetSha}-${context.runId}-1`
    || !/^[a-f0-9]{64}$/.test(receipt.buildSha256) || receipt.target !== "linux-x64"
    || !["verified_existing", "installed_verified"].includes(receipt.status) || receipt.profileDigest !== STEERING_PI_PROFILE.digest || receipt.sourceClosureSha256 !== STEERING_PI_SOURCE_CLOSURE)
    throw new Error("Pi delivery receipt does not match this original attempt");
  requireSteeringPiTime(receipt.jobDeadlineMs, now());
  const entry = path.join(targetRoot, "packages/paperclip-runner/dist/cli/provision-pi.cjs");
  if (digest(await boundedOwnedFile(entry, 64 * 1024 * 1024)) !== receipt.provisionerSha256) throw new Error("Pi provisioner changed after setup");
  const actual = await steeringPiAssetIdentity(targetRoot);
  for (const key of Object.keys(actual) as (keyof typeof actual)[]) if (actual[key] !== receipt[key]) throw new Error("Pi assets changed after setup");
  requireSteeringPiTime(receipt.jobDeadlineMs, now());
  return Object.freeze(receipt);
}
